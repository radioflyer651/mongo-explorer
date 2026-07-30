import { injectable } from 'inversify';
import { ObjectId } from 'mongodb';
import { Observable, Subject } from 'rxjs';
import { ConnectionManager } from '../connections/connection-manager.service';
import { DocumentService } from '../explorer/document.service';
import { IndexAdminService } from '../explorer/index-admin.service';
import { DatabaseExplorerService } from '../explorer/database-explorer.service';
import { PipelineService } from '../explorer/pipeline.service';
import { ShellService } from '../explorer/shell.service';
import { QueryService } from '../explorer/query.service';
import { ILimitsConfig } from '../model/app-config.model';
import {
    DataProposal,
    ProposalApplyResult,
    ProposalKind,
    ProposalOperation,
    ProposalReversal,
    ProposalSummary,
} from '../model/shared-models/mcp/proposal.model';
import { PipelineStage } from '../model/shared-models/explorer/pipeline.model';
import { ShellTier } from '../model/shared-models/explorer/shell.model';
import { errorMessage, newId, nowIso } from '../utils/misc.util';
import { parseExtendedJsonArray } from '../utils/ejson.util';
import { redactText } from '../utils/redaction.util';

/** What a caller must supply to stage a proposal. */
export interface CreateProposalRequest {
    /** Which kind of change this is. */
    kind: ProposalKind;

    /** Which connection the change targets. */
    connectionId: ObjectId;

    /** Target Database name. */
    databaseName: string;

    /** Collection name, absent for database-level operations. */
    collectionName?: string;

    /** One-sentence plain-language statement of what this does. */
    summary: string;

    /** Why the change is being proposed. */
    rationale: string;

    /** The exact operation. What executes is what is displayed. */
    operation: ProposalOperation;
}

/**
 * The propose-don't-commit contract.
 *
 * A proposal is data, not an intention to act. Nothing in this service acts on one
 * automatically. The only method that executes a proposal is applyProposal, which
 * runs with actor 'user' and is reachable only from a user gesture in the client.
 *
 * There is deliberately no MCP tool that calls applyProposal, and there must never
 * be one.
 */
@injectable()
export class ProposalService {
    constructor(
        connectionManager: ConnectionManager,
        documentService: DocumentService,
        indexService: IndexAdminService,
        databaseService: DatabaseExplorerService,
        pipelineService: PipelineService,
        shellService: ShellService,
        queryService: QueryService,
        limits: ILimitsConfig
    ) {
        this.connectionManager = connectionManager;
        this.documentService = documentService;
        this.indexService = indexService;
        this.databaseService = databaseService;
        this.pipelineService = pipelineService;
        this.shellService = shellService;
        this.queryService = queryService;
        this.limits = limits;
    }

    private readonly connectionManager: ConnectionManager;
    private readonly documentService: DocumentService;
    private readonly indexService: IndexAdminService;
    private readonly databaseService: DatabaseExplorerService;
    private readonly pipelineService: PipelineService;
    private readonly shellService: ShellService;
    private readonly queryService: QueryService;
    private readonly limits: ILimitsConfig;

    private readonly proposals = new Map<string, DataProposal>();
    private readonly changes = new Subject<ProposalSummary[]>();

    /** Emits whenever the proposal list changes. */
    readonly changed$: Observable<ProposalSummary[]> = this.changes.asObservable();

    /**
     * Stages a proposal. Computes the real affected count and reversibility, because
     * "this will update approximately some documents" is not a basis for consent.
     */
    async createProposal(request: CreateProposalRequest): Promise<DataProposal> {
        const affectedCount = await this.determineAffectedCount(request);
        const reversal = await this.determineReversal(request, affectedCount);

        const proposal: DataProposal = {
            id: newId(),
            createdAt: nowIso(),
            actor: 'mcp',
            kind: request.kind,
            connectionId: request.connectionId,
            databaseName: request.databaseName,
            collectionName: request.collectionName,
            summary: request.summary,
            rationale: request.rationale,
            operation: request.operation,
            affectedCount,
            reversal,
            status: 'pending',
        };

        this.proposals.set(proposal.id, proposal);
        this.publish();

        return proposal;
    }

    /** Every proposal, newest first. */
    getAll(): DataProposal[] {
        return [...this.proposals.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }

    /** Pending proposals in summary form. */
    getPendingSummaries(): ProposalSummary[] {
        return this.getAll()
            .filter(proposal => proposal.status === 'pending')
            .map(proposal => this.toSummary(proposal));
    }

    /** One proposal. */
    getProposal(proposalId: string): DataProposal | undefined {
        return this.proposals.get(proposalId);
    }

    /** Withdraws a proposal. Available to the AI that created it. */
    withdrawProposal(proposalId: string): boolean {
        const proposal = this.proposals.get(proposalId);

        if (!proposal || proposal.status !== 'pending') {
            return false;
        }

        this.setStatus(proposal, 'withdrawn');
        return true;
    }

    /** Rejects a proposal at the user's instruction. */
    rejectProposal(proposalId: string): boolean {
        const proposal = this.proposals.get(proposalId);

        if (!proposal || proposal.status !== 'pending') {
            return false;
        }

        this.setStatus(proposal, 'rejected');
        return true;
    }

    /**
     * Executes a proposal, as the user.
     *
     * The operation executed is the stored operation: the client does not rebuild it
     * and this method does not adjust it. Any divergence between the reviewed diff and
     * the executed statement would make review theatre.
     */
    async applyProposal(proposalId: string): Promise<ProposalApplyResult> {
        const proposal = this.proposals.get(proposalId);

        if (!proposal) {
            return { proposalId, succeeded: false, error: 'No such proposal.', isUndoable: false };
        }

        if (proposal.status !== 'pending') {
            return { proposalId, succeeded: false, error: `Proposal is ${proposal.status}.`, isUndoable: false };
        }

        try {
            const connection = await this.connectionManager.getConnection(proposal.connectionId);
            const ref = {
                connectionId: proposal.connectionId,
                databaseName: proposal.databaseName,
                collectionName: proposal.collectionName ?? '',
            };

            /* Capture the prior state before changing anything, so Apply is undoable. */
            if (proposal.operation.filterJson && proposal.collectionName) {
                const snapshot = await this.documentService.captureSnapshot(connection, ref, proposal.operation.filterJson);
                (proposal as { snapshotJson?: string; }).snapshotJson = snapshot.snapshotJson;
            }

            const affected = await this.execute(proposal);
            this.setStatus(proposal, 'applied');

            return {
                proposalId,
                succeeded: true,
                affectedCount: affected,
                isUndoable: proposal.snapshotJson !== undefined,
            };
        } catch (error) {
            return {
                proposalId,
                succeeded: false,
                error: redactText(errorMessage(error)),
                isUndoable: false,
            };
        }
    }

    /**
     * Marks proposals against a collection stale after it has been written to. The
     * document an AI reasoned about is not the document on disk any more.
     */
    markStaleForCollection(databaseName: string, collectionName: string, reason: string): void {
        let changed = false;

        for (const proposal of this.proposals.values()) {
            if (
                proposal.status === 'pending' &&
                proposal.databaseName === databaseName &&
                proposal.collectionName === collectionName
            ) {
                (proposal as { status: string; staleReason?: string; }).status = 'stale';
                (proposal as { staleReason?: string; }).staleReason = reason;
                changed = true;
            }
        }

        if (changed) {
            this.publish();
        }
    }

    /** Dispatches a proposal to the right service, always as the user. */
    private async execute(proposal: DataProposal): Promise<number | undefined> {
        const connection = await this.connectionManager.getConnection(proposal.connectionId);
        const operation = proposal.operation;
        const ref = {
            connectionId: proposal.connectionId,
            databaseName: proposal.databaseName,
            collectionName: proposal.collectionName ?? '',
        };

        switch (proposal.kind) {
            case ProposalKind.DocumentInsert: {
                const result = await this.documentService.insertDocuments(
                    connection,
                    ref,
                    operation.documentsJson ?? '[]',
                    'user'
                );
                return result.insertedCount;
            }

            case ProposalKind.DocumentUpdate: {
                const result = await this.documentService.updateDocuments(
                    connection,
                    ref,
                    operation.filterJson ?? '{}',
                    operation.updateJson ?? '{}',
                    operation.isMany === true,
                    'user'
                );
                return result.modifiedCount;
            }

            case ProposalKind.DocumentReplace: {
                const result = await this.documentService.replaceDocument(
                    connection,
                    ref,
                    operation.filterJson ?? '{}',
                    operation.documentsJson ?? '{}',
                    'user'
                );
                return result.modifiedCount;
            }

            case ProposalKind.DocumentDelete: {
                const result = await this.documentService.deleteDocuments(
                    connection,
                    ref,
                    operation.filterJson ?? '{}',
                    operation.isMany === true,
                    'user'
                );
                return result.deletedCount;
            }

            case ProposalKind.IndexCreate:
                await this.indexService.createIndex(
                    connection,
                    proposal.databaseName,
                    proposal.collectionName ?? '',
                    operation.indexJson ?? '{}',
                    { name: operation.indexName },
                    'user'
                );
                return undefined;

            case ProposalKind.IndexDrop:
                await this.indexService.dropIndex(
                    connection,
                    proposal.databaseName,
                    proposal.collectionName ?? '',
                    operation.indexName ?? '',
                    'user'
                );
                return undefined;

            case ProposalKind.CollectionOperation:
                return await this.executeCollectionOperation(proposal);

            case ProposalKind.PipelineRun: {
                const stages = parseExtendedJsonArray(operation.pipelineJson ?? '[]', 'pipeline') as unknown as PipelineStage[];
                await this.pipelineService.runWritePipeline(
                    connection,
                    {
                        connectionId: proposal.connectionId,
                        databaseName: proposal.databaseName,
                        collectionName: proposal.collectionName ?? '',
                        stages,
                        sampleSize: this.limits.pipelinePreviewSize,
                    },
                    'user'
                );
                return undefined;
            }

            case ProposalKind.ShellCommand: {
                const entry = await this.shellService.execute(
                    connection,
                    {
                        connectionId: proposal.connectionId,
                        databaseName: proposal.databaseName,
                        input: operation.shellInput ?? '',
                        tier: ShellTier.CommandRunner,
                    },
                    'user'
                );

                if (entry.status !== 'succeeded') {
                    throw new Error(entry.error ?? 'The shell command did not succeed.');
                }

                return undefined;
            }

            default:
                throw new Error(`Unsupported proposal kind: ${proposal.kind}`);
        }
    }

    /** Executes a create, rename, or drop of a collection. */
    private async executeCollectionOperation(proposal: DataProposal): Promise<undefined> {
        const connection = await this.connectionManager.getConnection(proposal.connectionId);
        const action = proposal.operation.collectionAction;
        const collectionName = proposal.collectionName ?? '';

        switch (action) {
            case 'create':
                await this.databaseService.createCollection(connection, proposal.databaseName, collectionName, 'user');
                return undefined;

            case 'rename':
                await this.databaseService.renameCollection(
                    connection,
                    proposal.databaseName,
                    collectionName,
                    proposal.operation.newName ?? '',
                    'user'
                );
                return undefined;

            case 'drop':
                await this.databaseService.dropCollection(connection, proposal.databaseName, collectionName, 'user');
                return undefined;

            default:
                throw new Error(`Unsupported collection action: ${String(action)}`);
        }
    }

    /** Counts the documents a proposal will affect, using a real count. */
    private async determineAffectedCount(request: CreateProposalRequest): Promise<number | undefined> {
        if (!request.operation.filterJson || !request.collectionName) {
            return undefined;
        }

        try {
            const connection = await this.connectionManager.getConnection(request.connectionId);

            const result = await this.queryService.countDocuments(connection, {
                connectionId: request.connectionId,
                databaseName: request.databaseName,
                collectionName: request.collectionName,
                filter: request.operation.filterJson,
            });

            if (!request.operation.isMany && result.count > 1) {
                return 1;
            }

            return result.count;
        } catch {
            /* An undeterminable count is reported as undefined; the confirmation
               tells the user it could not be established. */
            return undefined;
        }
    }

    /** Works out whether and how a proposal can be reversed. */
    private async determineReversal(request: CreateProposalRequest, affectedCount: number | undefined): Promise<ProposalReversal> {
        switch (request.kind) {
            case ProposalKind.DocumentInsert:
                return {
                    kind: 'inverse-operation',
                    operation: {
                        kind: ProposalKind.DocumentDelete,
                        documentsJson: request.operation.documentsJson,
                        isMany: true,
                    },
                };

            case ProposalKind.IndexCreate:
                return {
                    kind: 'inverse-operation',
                    operation: { kind: ProposalKind.IndexDrop, indexName: request.operation.indexName },
                };

            case ProposalKind.DocumentUpdate:
            case ProposalKind.DocumentReplace:
            case ProposalKind.DocumentDelete:
                if (affectedCount !== undefined && affectedCount <= this.limits.maxUndoSnapshotDocuments) {
                    return { kind: 'snapshot', documentCount: affectedCount };
                }

                return {
                    kind: 'none',
                    explanation:
                        affectedCount === undefined
                            ? 'The affected document count could not be determined, so no snapshot can be captured.'
                            : `${affectedCount} documents exceed the ${this.limits.maxUndoSnapshotDocuments} snapshot cap, so this cannot be undone.`,
                };

            case ProposalKind.CollectionOperation:
                return request.operation.collectionAction === 'rename'
                    ? {
                        kind: 'inverse-operation',
                        operation: {
                            kind: ProposalKind.CollectionOperation,
                            collectionAction: 'rename',
                            newName: request.collectionName,
                        },
                    }
                    : { kind: 'none', explanation: 'Creating or dropping a collection cannot be undone.' };

            default:
                return { kind: 'none', explanation: 'This operation cannot be undone automatically.' };
        }
    }

    /** Applies a terminal status and publishes the change. */
    private setStatus(proposal: DataProposal, status: DataProposal['status']): void {
        (proposal as { status: DataProposal['status']; }).status = status;
        (proposal as { statusChangedAt?: string; }).statusChangedAt = nowIso();
        this.publish();
    }

    /** Reduces a proposal to its summary form. */
    private toSummary(proposal: DataProposal): ProposalSummary {
        return {
            id: proposal.id,
            kind: proposal.kind,
            summary: proposal.summary,
            status: proposal.status,
            databaseName: proposal.databaseName,
            collectionName: proposal.collectionName,
            affectedCount: proposal.affectedCount,
            createdAt: proposal.createdAt,
        };
    }

    /** Publishes the current pending list. */
    private publish(): void {
        this.changes.next(this.getPendingSummaries());
    }
}
