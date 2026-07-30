import { CommonModule } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { AiSessionService } from '../../../services/ai-session.service';
import { ClientApiService } from '../../../services/explorer/api-clients/client-api.service';
import { ExplorerDataService } from '../../../services/explorer/explorer-data.service';
import { ComponentBase } from '../../component-base/component-base.component';
import { toDisplayJson } from '../../../core/ejson.util';
import { DataProposal, ProposalKind } from '../../../../model/shared-models/mcp/proposal.model';

/** A proposal expanded for review. */
interface ReviewedProposal {
    /** The proposal. */
    proposal: DataProposal;

    /** The operation rendered as readable Extended JSON. */
    operationLines: { label: string; body: string; }[];

    /** Plain-language statement of whether it can be undone. */
    reversalText: string;

    /** True when the user must type the collection name to confirm. */
    requiresTypedConfirmation: boolean;
}

/**
 * The Proposals panel: a first-class surface, not a toast.
 *
 * Every proposal shows what it will do, why, the real affected count, and whether it
 * can be undone. The user applies it — there is no code path by which an AI can.
 */
@Component({
    selector: 'app-proposals-panel',
    imports: [CommonModule, FormsModule],
    templateUrl: './proposals-panel.component.html',
    styleUrl: './proposals-panel.component.scss',
})
export class ProposalsPanelComponent extends ComponentBase {
    constructor(readonly ai: AiSessionService) {
        super();
        this.reload();
    }

    private readonly api = inject(ClientApiService);
    private readonly data = inject(ExplorerDataService);

    /** Every proposal, newest first. */
    readonly proposals = signal<DataProposal[]>([]);

    /** Which proposal is expanded. */
    readonly expandedId = signal<string | undefined>(undefined);

    /** Typed confirmation text, keyed by proposal id. */
    readonly confirmationText = signal<Record<string, string>>({});

    /** The most recent error from applying a proposal. */
    readonly lastError = signal<string | undefined>(undefined);

    /** Whether an apply is in flight. */
    readonly isApplying = signal(false);

    /** Proposals expanded for review. */
    readonly reviewed = computed<ReviewedProposal[]>(() =>
        this.proposals().map(proposal => ({
            proposal,
            operationLines: this.describeOperation(proposal),
            reversalText: this.describeReversal(proposal),
            requiresTypedConfirmation: this.needsTypedConfirmation(proposal),
        }))
    );

    /** How many proposals are pending. */
    readonly pendingCount = computed(
        () => this.proposals().filter(proposal => proposal.status === 'pending').length
    );

    /** Reloads the list from the server. */
    reload(): void {
        this.api.getProposals().subscribe(proposals => this.proposals.set(proposals));
    }

    /** Expands or collapses one proposal. */
    toggle(proposalId: string): void {
        this.expandedId.update(current => (current === proposalId ? undefined : proposalId));
    }

    /** Records the typed confirmation for one proposal. */
    setConfirmation(proposalId: string, value: string): void {
        this.confirmationText.update(current => ({ ...current, [proposalId]: value }));
    }

    /**
     * Whether Apply may be pressed. Apply is never the default focused action and a
     * bulk or drop operation needs the collection name typed out.
     */
    canApply(entry: ReviewedProposal): boolean {
        if (entry.proposal.status !== 'pending' || this.isApplying()) {
            return false;
        }

        if (!entry.requiresTypedConfirmation) {
            return true;
        }

        const typed = this.confirmationText()[entry.proposal.id] ?? '';
        return typed === entry.proposal.collectionName;
    }

    /** Applies a proposal. This is the user pressing the button. */
    async apply(entry: ReviewedProposal): Promise<void> {
        if (!this.canApply(entry)) {
            return;
        }

        this.isApplying.set(true);
        this.lastError.set(undefined);

        try {
            const result = await firstValueFrom(this.api.applyProposal(entry.proposal.id));

            if (!result.succeeded) {
                this.lastError.set(result.error ?? 'The proposal could not be applied.');
            } else {
                await this.data.loadActiveTab();
            }

            this.reload();
            this.ai.reloadProposals();
        } catch (error) {
            this.lastError.set(error instanceof Error ? error.message : 'The proposal could not be applied.');
        } finally {
            this.isApplying.set(false);
        }
    }

    /** Rejects a proposal. */
    async reject(entry: ReviewedProposal): Promise<void> {
        await firstValueFrom(this.api.rejectProposal(entry.proposal.id));
        this.reload();
        this.ai.reloadProposals();
    }

    /** Copies the operation as a shell command, for the user to run themselves. */
    async copyAsShell(entry: ReviewedProposal): Promise<void> {
        await navigator.clipboard.writeText(this.toShellCommand(entry.proposal));
    }

    /** Breaks an operation into labelled, readable blocks. */
    private describeOperation(proposal: DataProposal): { label: string; body: string; }[] {
        const operation = proposal.operation;
        const lines: { label: string; body: string; }[] = [];

        if (operation.filterJson) {
            lines.push({ label: 'Filter', body: this.pretty(operation.filterJson) });
        }

        if (operation.updateJson) {
            lines.push({ label: 'Update', body: this.pretty(operation.updateJson) });
        }

        if (operation.documentsJson) {
            lines.push({ label: 'Documents', body: this.pretty(operation.documentsJson) });
        }

        if (operation.indexJson) {
            lines.push({ label: 'Index key', body: this.pretty(operation.indexJson) });
        }

        if (operation.pipelineJson) {
            lines.push({ label: 'Pipeline', body: this.pretty(operation.pipelineJson) });
        }

        if (operation.shellInput) {
            lines.push({ label: 'Command', body: operation.shellInput });
        }

        if (operation.collectionAction) {
            lines.push({
                label: 'Action',
                body: `${operation.collectionAction}${operation.newName ? ` to '${operation.newName}'` : ''}`,
            });
        }

        return lines;
    }

    /** States plainly whether the change can be undone. */
    private describeReversal(proposal: DataProposal): string {
        switch (proposal.reversal.kind) {
            case 'snapshot':
                return `Undoable — ${proposal.reversal.documentCount} document(s) will be captured before the change.`;
            case 'inverse-operation':
                return 'Undoable — the inverse operation can be applied.';
            default:
                return `Cannot be undone. ${proposal.reversal.explanation}`;
        }
    }

    /** Whether the user must type the collection name to confirm. */
    private needsTypedConfirmation(proposal: DataProposal): boolean {
        const isBulk = proposal.operation.isMany === true;
        const isDrop =
            proposal.kind === ProposalKind.CollectionOperation && proposal.operation.collectionAction === 'drop';

        return isDrop || (isBulk && (proposal.affectedCount ?? 0) > 1);
    }

    /** Reformats Extended JSON for display, tolerating unparseable text. */
    private pretty(json: string): string {
        try {
            return toDisplayJson(JSON.parse(json));
        } catch {
            return json;
        }
    }

    /** Renders a proposal as an equivalent shell command. */
    private toShellCommand(proposal: DataProposal): string {
        const collection = proposal.collectionName ?? '';

        switch (proposal.kind) {
            case ProposalKind.DocumentUpdate:
                return `db.getCollection("${collection}").update${proposal.operation.isMany ? 'Many' : 'One'}(${proposal.operation.filterJson}, ${proposal.operation.updateJson})`;
            case ProposalKind.DocumentDelete:
                return `db.getCollection("${collection}").delete${proposal.operation.isMany ? 'Many' : 'One'}(${proposal.operation.filterJson})`;
            case ProposalKind.DocumentInsert:
                return `db.getCollection("${collection}").insertMany(${proposal.operation.documentsJson})`;
            case ProposalKind.IndexCreate:
                return `db.getCollection("${collection}").createIndex(${proposal.operation.indexJson})`;
            case ProposalKind.ShellCommand:
                return proposal.operation.shellInput ?? '';
            default:
                return `// ${proposal.summary}`;
        }
    }
}
