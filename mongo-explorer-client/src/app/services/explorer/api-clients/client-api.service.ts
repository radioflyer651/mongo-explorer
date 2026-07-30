import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { ObjectId } from 'mongodb';
import { ApiClientBase } from './api-client-base.service';
import {
    SaveConnectionRequest,
    SavedConnectionListing,
} from '../../../../model/shared-models/connections/saved-connection.model';
import { ConnectionStatus } from '../../../../model/shared-models/connections/connection-state.model';
import {
    CollectionSummary,
    CountResult,
    DatabaseSummary,
    ExplainResult,
    IndexInfo,
    QueryResultPage,
    SchemaSample,
} from '../../../../model/shared-models/explorer/explorer.model';
import {
    PipelineExplainResult,
    PipelinePreviewResult,
    PipelineStage,
    SavedPipeline,
} from '../../../../model/shared-models/explorer/pipeline.model';
import { ShellTranscriptEntry } from '../../../../model/shared-models/explorer/shell.model';
import { AppSessionState } from '../../../../model/shared-models/mcp/app-session-state.model';
import { McpMode, McpModeCapabilities } from '../../../../model/shared-models/mcp/mcp-mode.model';
import { DataProposal, ProposalApplyResult } from '../../../../model/shared-models/mcp/proposal.model';
import { ActivityEntry } from '../../../../model/shared-models/mcp/app-session-state.model';
import { AuthRequirement, LoginResponse } from '../../../../model/shared-models/auth/user.model';

/** Query arguments for a document read. */
export interface DocumentQueryArgs {
    /** Filter as Extended JSON text. */
    filter?: string;

    /** Projection as Extended JSON text. */
    projection?: string;

    /** Sort as Extended JSON text. */
    sort?: string;

    /** Page size. */
    limit?: number;

    /** Documents to skip. */
    skip?: number;
}

/** Outcome of a document write. */
export interface WriteOutcome {
    matchedCount: number;
    modifiedCount: number;
    insertedCount: number;
    deletedCount: number;
}

/**
 * The main API client. Comprehensive coverage of the server's endpoints.
 *
 * Every method returns an Observable, even for one-shot calls. Auth is automatic
 * except for the login endpoints.
 */
@Injectable({ providedIn: 'root' })
export class ClientApiService extends ApiClientBase {
    constructor() {
        super();
    }

    /* ---------- Health and authentication ---------- */

    /** Checks that the server is reachable. */
    getHealth(): Observable<{ status: string; mcpEnabled: boolean; }> {
        return this.http.get<{ status: string; mcpEnabled: boolean; }>(this.url('/api/health'));
    }

    /** Reads whether a local lock is configured. */
    getAuthRequirement(): Observable<AuthRequirement> {
        return this.http.get<AuthRequirement>(this.url('/api/auth/requirement'));
    }

    /** Signs in. One of the two calls that does not attach a token. */
    login(userName: string, password: string): Observable<LoginResponse> {
        return this.http.post<LoginResponse>(this.url('/api/auth/login'), { userName, password });
    }

    /* ---------- Connections ---------- */

    /** Lists saved connections in redacted form. */
    getConnections(): Observable<SavedConnectionListing[]> {
        return this.http.get<SavedConnectionListing[]>(
            this.url('/api/connections'),
            this.optionsBuilder.withAuthorization()
        );
    }

    /** Lists the available connection strategies. */
    getStrategies(): Observable<{ kind: string; displayName: string; requiresRefresh: boolean; }[]> {
        return this.http.get<{ kind: string; displayName: string; requiresRefresh: boolean; }[]>(
            this.url('/api/connections/strategies'),
            this.optionsBuilder.withAuthorization()
        );
    }

    /** Reads the status of every connection the server knows about. */
    getConnectionStatuses(): Observable<ConnectionStatus[]> {
        return this.http.get<ConnectionStatus[]>(
            this.url('/api/connections/statuses'),
            this.optionsBuilder.withAuthorization()
        );
    }

    /** Creates or updates a connection. */
    saveConnection(request: SaveConnectionRequest): Observable<SavedConnectionListing> {
        return this.http.post<SavedConnectionListing>(
            this.url('/api/connections'),
            request,
            this.optionsBuilder.withAuthorization()
        );
    }

    /** Deletes a connection. */
    deleteConnection(connectionId: ObjectId): Observable<{ deleted: boolean; }> {
        return this.http.delete<{ deleted: boolean; }>(
            this.url(`/api/connections/${connectionId}`),
            this.optionsBuilder.withAuthorization()
        );
    }

    /** Sets the read-only guard rail. */
    setConnectionReadOnly(connectionId: ObjectId, isReadOnly: boolean): Observable<{ isReadOnly: boolean; }> {
        return this.http.post<{ isReadOnly: boolean; }>(
            this.url(`/api/connections/${connectionId}/read-only`),
            { isReadOnly },
            this.optionsBuilder.withAuthorization()
        );
    }

    /** Validates a connection's configuration without reaching the deployment. */
    validateConnection(connectionId: ObjectId): Observable<{ isValid: boolean; errors: { path: string; message: string; }[]; }> {
        return this.http.get<{ isValid: boolean; errors: { path: string; message: string; }[]; }>(
            this.url(`/api/connections/${connectionId}/validate`),
            this.optionsBuilder.withAuthorization()
        );
    }

    /** Opens a connection. */
    connect(connectionId: ObjectId): Observable<ConnectionStatus> {
        return this.http.post<ConnectionStatus>(
            this.url(`/api/connections/${connectionId}/connect`),
            {},
            this.optionsBuilder.withAuthorization()
        );
    }

    /** Closes a connection. */
    disconnect(connectionId: ObjectId): Observable<{ disconnected: boolean; }> {
        return this.http.post<{ disconnected: boolean; }>(
            this.url(`/api/connections/${connectionId}/disconnect`),
            {},
            this.optionsBuilder.withAuthorization()
        );
    }

    /** Cancels an in-flight connection attempt. */
    cancelConnect(connectionId: ObjectId): Observable<{ cancelled: boolean; }> {
        return this.http.post<{ cancelled: boolean; }>(
            this.url(`/api/connections/${connectionId}/cancel`),
            {},
            this.optionsBuilder.withAuthorization()
        );
    }

    /* ---------- Databases and collections ---------- */

    /** Lists databases on a deployment. */
    getDatabases(connectionId: ObjectId): Observable<DatabaseSummary[]> {
        return this.http.get<DatabaseSummary[]>(
            this.url(`/api/connections/${connectionId}/databases`),
            this.optionsBuilder.withAuthorization()
        );
    }

    /** Lists collections in a database. */
    getCollections(connectionId: ObjectId, databaseName: string): Observable<CollectionSummary[]> {
        return this.http.get<CollectionSummary[]>(
            this.url(`/api/connections/${connectionId}/databases/${this.segment(databaseName)}/collections`),
            this.optionsBuilder.withAuthorization()
        );
    }

    /** Reads statistics for one collection. */
    getCollectionStats(connectionId: ObjectId, databaseName: string, collectionName: string): Observable<CollectionSummary> {
        return this.http.get<CollectionSummary>(
            this.url(this.collectionPath(connectionId, databaseName, collectionName, '/stats')),
            this.optionsBuilder.withAuthorization()
        );
    }

    /** Creates a collection. */
    createCollection(connectionId: ObjectId, databaseName: string, collectionName: string): Observable<{ created: boolean; }> {
        return this.http.post<{ created: boolean; }>(
            this.url(`/api/connections/${connectionId}/databases/${this.segment(databaseName)}/collections`),
            { collectionName },
            this.optionsBuilder.withAuthorization()
        );
    }

    /** Drops a collection. */
    dropCollection(connectionId: ObjectId, databaseName: string, collectionName: string): Observable<{ dropped: boolean; }> {
        return this.http.delete<{ dropped: boolean; }>(
            this.url(this.collectionPath(connectionId, databaseName, collectionName, '')),
            this.optionsBuilder.withAuthorization()
        );
    }

    /** Renames a collection. */
    renameCollection(
        connectionId: ObjectId,
        databaseName: string,
        collectionName: string,
        newName: string
    ): Observable<{ renamed: boolean; }> {
        return this.http.post<{ renamed: boolean; }>(
            this.url(this.collectionPath(connectionId, databaseName, collectionName, '/rename')),
            { newName },
            this.optionsBuilder.withAuthorization()
        );
    }

    /** Drops a database. */
    dropDatabase(connectionId: ObjectId, databaseName: string): Observable<{ dropped: boolean; }> {
        return this.http.delete<{ dropped: boolean; }>(
            this.url(`/api/connections/${connectionId}/databases/${this.segment(databaseName)}`),
            this.optionsBuilder.withAuthorization()
        );
    }

    /* ---------- Documents ---------- */

    /** Reads one bounded page of documents. */
    findDocuments(
        connectionId: ObjectId,
        databaseName: string,
        collectionName: string,
        args: DocumentQueryArgs
    ): Observable<QueryResultPage> {
        const options = this.optionsBuilder
            .buildOptions()
            .addAuthToken()
            .addParam('filter', args.filter)
            .addParam('projection', args.projection)
            .addParam('sort', args.sort)
            .addParam('limit', args.limit)
            .addParam('skip', args.skip)
            .build();

        return this.http.get<QueryResultPage>(
            this.url(this.collectionPath(connectionId, databaseName, collectionName, '/documents')),
            options
        );
    }

    /** Counts matching documents. */
    countDocuments(
        connectionId: ObjectId,
        databaseName: string,
        collectionName: string,
        filter?: string
    ): Observable<CountResult> {
        const options = this.optionsBuilder.buildOptions().addAuthToken().addParam('filter', filter).build();

        return this.http.get<CountResult>(
            this.url(this.collectionPath(connectionId, databaseName, collectionName, '/count')),
            options
        );
    }

    /** Infers a collection's shape from a sample. */
    getSchema(
        connectionId: ObjectId,
        databaseName: string,
        collectionName: string,
        sampleSize?: number
    ): Observable<SchemaSample> {
        const options = this.optionsBuilder.buildOptions().addAuthToken().addParam('sampleSize', sampleSize).build();

        return this.http.get<SchemaSample>(
            this.url(this.collectionPath(connectionId, databaseName, collectionName, '/schema')),
            options
        );
    }

    /** Explains a find. */
    explainQuery(
        connectionId: ObjectId,
        databaseName: string,
        collectionName: string,
        args: DocumentQueryArgs
    ): Observable<ExplainResult> {
        const options = this.optionsBuilder
            .buildOptions()
            .addAuthToken()
            .addParam('filter', args.filter)
            .addParam('sort', args.sort)
            .addParam('limit', args.limit)
            .build();

        return this.http.get<ExplainResult>(
            this.url(this.collectionPath(connectionId, databaseName, collectionName, '/explain')),
            options
        );
    }

    /** Inserts documents supplied as Extended JSON. */
    insertDocuments(
        connectionId: ObjectId,
        databaseName: string,
        collectionName: string,
        documentsJson: string
    ): Observable<WriteOutcome> {
        return this.http.post<WriteOutcome>(
            this.url(this.collectionPath(connectionId, databaseName, collectionName, '/documents')),
            { documentsJson },
            this.optionsBuilder.withAuthorization()
        );
    }

    /** Updates documents matching a filter. */
    updateDocuments(
        connectionId: ObjectId,
        databaseName: string,
        collectionName: string,
        filterJson: string,
        updateJson: string,
        isMany: boolean
    ): Observable<WriteOutcome> {
        return this.http.patch<WriteOutcome>(
            this.url(this.collectionPath(connectionId, databaseName, collectionName, '/documents')),
            { filterJson, updateJson, isMany },
            this.optionsBuilder.withAuthorization()
        );
    }

    /** Replaces one document wholesale. */
    replaceDocument(
        connectionId: ObjectId,
        databaseName: string,
        collectionName: string,
        filterJson: string,
        documentsJson: string
    ): Observable<WriteOutcome> {
        return this.http.put<WriteOutcome>(
            this.url(this.collectionPath(connectionId, databaseName, collectionName, '/documents')),
            { filterJson, documentsJson },
            this.optionsBuilder.withAuthorization()
        );
    }

    /** Deletes documents matching a filter. */
    deleteDocuments(
        connectionId: ObjectId,
        databaseName: string,
        collectionName: string,
        filterJson: string,
        isMany: boolean
    ): Observable<WriteOutcome> {
        return this.http.post<WriteOutcome>(
            this.url(this.collectionPath(connectionId, databaseName, collectionName, '/documents/delete')),
            { filterJson, isMany },
            this.optionsBuilder.withAuthorization()
        );
    }

    /* ---------- Indexes ---------- */

    /** Lists indexes on a collection. */
    getIndexes(connectionId: ObjectId, databaseName: string, collectionName: string): Observable<IndexInfo[]> {
        return this.http.get<IndexInfo[]>(
            this.url(this.collectionPath(connectionId, databaseName, collectionName, '/indexes')),
            this.optionsBuilder.withAuthorization()
        );
    }

    /** Creates an index. */
    createIndex(
        connectionId: ObjectId,
        databaseName: string,
        collectionName: string,
        body: { keyJson: string; name?: string; unique?: boolean; sparse?: boolean; expireAfterSeconds?: number; }
    ): Observable<{ created: boolean; name: string; }> {
        return this.http.post<{ created: boolean; name: string; }>(
            this.url(this.collectionPath(connectionId, databaseName, collectionName, '/indexes')),
            body,
            this.optionsBuilder.withAuthorization()
        );
    }

    /** Drops an index. */
    dropIndex(
        connectionId: ObjectId,
        databaseName: string,
        collectionName: string,
        indexName: string
    ): Observable<{ dropped: boolean; }> {
        return this.http.delete<{ dropped: boolean; }>(
            this.url(this.collectionPath(connectionId, databaseName, collectionName, `/indexes/${this.segment(indexName)}`)),
            this.optionsBuilder.withAuthorization()
        );
    }

    /* ---------- Aggregation pipeline ---------- */

    /** Previews a pipeline prefix. */
    previewPipeline(
        connectionId: ObjectId,
        databaseName: string,
        collectionName: string,
        stages: PipelineStage[],
        upToStageIndex?: number,
        sampleSize?: number
    ): Observable<PipelinePreviewResult> {
        return this.http.post<PipelinePreviewResult>(
            this.url(this.collectionPath(connectionId, databaseName, collectionName, '/pipeline/preview')),
            { stages, upToStageIndex, sampleSize },
            this.optionsBuilder.withAuthorization()
        );
    }

    /** Explains a pipeline. */
    explainPipeline(
        connectionId: ObjectId,
        databaseName: string,
        collectionName: string,
        stages: PipelineStage[]
    ): Observable<PipelineExplainResult> {
        return this.http.post<PipelineExplainResult>(
            this.url(this.collectionPath(connectionId, databaseName, collectionName, '/pipeline/explain')),
            { stages },
            this.optionsBuilder.withAuthorization()
        );
    }

    /** Runs a pipeline containing a write stage. */
    runWritePipeline(
        connectionId: ObjectId,
        databaseName: string,
        collectionName: string,
        stages: PipelineStage[]
    ): Observable<{ durationMs: number; }> {
        return this.http.post<{ durationMs: number; }>(
            this.url(this.collectionPath(connectionId, databaseName, collectionName, '/pipeline/run')),
            { stages },
            this.optionsBuilder.withAuthorization()
        );
    }

    /** Asks the server which stages write. */
    findWriteStages(
        connectionId: ObjectId,
        databaseName: string,
        collectionName: string,
        stages: PipelineStage[]
    ): Observable<{ hasWriteStage: boolean; writeStages: string[]; }> {
        return this.http.post<{ hasWriteStage: boolean; writeStages: string[]; }>(
            this.url(this.collectionPath(connectionId, databaseName, collectionName, '/pipeline/write-stages')),
            { stages },
            this.optionsBuilder.withAuthorization()
        );
    }

    /** Generates code for a pipeline. */
    exportPipeline(
        connectionId: ObjectId,
        databaseName: string,
        collectionName: string,
        stages: PipelineStage[],
        language: 'node' | 'mongosh' | 'python' | 'json'
    ): Observable<{ language: string; code: string; }> {
        return this.http.post<{ language: string; code: string; }>(
            this.url(this.collectionPath(connectionId, databaseName, collectionName, '/pipeline/export')),
            { stages, language },
            this.optionsBuilder.withAuthorization()
        );
    }

    /** Lists saved pipelines. */
    getSavedPipelines(connectionId?: ObjectId, databaseName?: string, collectionName?: string): Observable<SavedPipeline[]> {
        const options = this.optionsBuilder
            .buildOptions()
            .addAuthToken()
            .addParam('connectionId', connectionId)
            .addParam('databaseName', databaseName)
            .addParam('collectionName', collectionName)
            .build();

        return this.http.get<SavedPipeline[]>(this.url('/api/saved-pipelines'), options);
    }

    /** Saves a pipeline. */
    savePipeline(pipeline: {
        _id?: ObjectId;
        name: string;
        description?: string;
        connectionId: ObjectId;
        databaseName: string;
        collectionName: string;
        stages: PipelineStage[];
    }): Observable<SavedPipeline> {
        return this.http.post<SavedPipeline>(
            this.url('/api/saved-pipelines'),
            pipeline,
            this.optionsBuilder.withAuthorization()
        );
    }

    /** Deletes a saved pipeline. */
    deleteSavedPipeline(pipelineId: ObjectId): Observable<{ deleted: boolean; }> {
        return this.http.delete<{ deleted: boolean; }>(
            this.url(`/api/saved-pipelines/${pipelineId}`),
            this.optionsBuilder.withAuthorization()
        );
    }

    /* ---------- Shell ---------- */

    /** Reads the shell transcript. */
    getShellTranscript(): Observable<ShellTranscriptEntry[]> {
        return this.http.get<ShellTranscriptEntry[]>(
            this.url('/api/shell/transcript'),
            this.optionsBuilder.withAuthorization()
        );
    }

    /** Clears the shell transcript. */
    clearShellTranscript(): Observable<{ cleared: boolean; }> {
        return this.http.delete<{ cleared: boolean; }>(
            this.url('/api/shell/transcript'),
            this.optionsBuilder.withAuthorization()
        );
    }

    /** Classifies a shell command without running it. */
    classifyShellCommand(input: string): Observable<{ classification: string; commandName?: string; }> {
        return this.http.post<{ classification: string; commandName?: string; }>(
            this.url('/api/shell/classify'),
            { input },
            this.optionsBuilder.withAuthorization()
        );
    }

    /** Runs a shell command. */
    executeShellCommand(
        connectionId: ObjectId,
        databaseName: string,
        input: string
    ): Observable<ShellTranscriptEntry> {
        return this.http.post<ShellTranscriptEntry>(
            this.url(`/api/connections/${connectionId}/shell/execute`),
            { databaseName, input },
            this.optionsBuilder.withAuthorization()
        );
    }

    /* ---------- Deployment diagnostics ---------- */

    /** Reads live deployment metrics. */
    getServerStatus(connectionId: ObjectId): Observable<unknown> {
        return this.http.get<unknown>(
            this.url(`/api/connections/${connectionId}/server-status`),
            this.optionsBuilder.withAuthorization()
        );
    }

    /** Lists in-progress operations. */
    getCurrentOperations(connectionId: ObjectId): Observable<unknown[]> {
        return this.http.get<unknown[]>(
            this.url(`/api/connections/${connectionId}/current-operations`),
            this.optionsBuilder.withAuthorization()
        );
    }

    /* ---------- AI mode, proposals, activity ---------- */

    /** Reads the AI permission mode. */
    getAiMode(): Observable<{ mode: McpMode; capabilities: McpModeCapabilities; }> {
        return this.http.get<{ mode: McpMode; capabilities: McpModeCapabilities; }>(
            this.url('/api/ai/mode'),
            this.optionsBuilder.withAuthorization()
        );
    }

    /** Changes the AI permission mode. */
    setAiMode(mode: McpMode): Observable<{ mode: McpMode; capabilities: McpModeCapabilities; }> {
        return this.http.post<{ mode: McpMode; capabilities: McpModeCapabilities; }>(
            this.url('/api/ai/mode'),
            { mode },
            this.optionsBuilder.withAuthorization()
        );
    }

    /** Reads the server's mirrored session state. */
    getSessionState(): Observable<AppSessionState> {
        return this.http.get<AppSessionState>(
            this.url('/api/ai/session-state'),
            this.optionsBuilder.withAuthorization()
        );
    }

    /** Lists proposals. */
    getProposals(): Observable<DataProposal[]> {
        return this.http.get<DataProposal[]>(this.url('/api/ai/proposals'), this.optionsBuilder.withAuthorization());
    }

    /** Reads one proposal. */
    getProposal(proposalId: string): Observable<DataProposal> {
        return this.http.get<DataProposal>(
            this.url(`/api/ai/proposals/${this.segment(proposalId)}`),
            this.optionsBuilder.withAuthorization()
        );
    }

    /** Applies a proposal. The user pressing the button. */
    applyProposal(proposalId: string): Observable<ProposalApplyResult> {
        return this.http.post<ProposalApplyResult>(
            this.url(`/api/ai/proposals/${this.segment(proposalId)}/apply`),
            {},
            this.optionsBuilder.withAuthorization()
        );
    }

    /** Rejects a proposal. */
    rejectProposal(proposalId: string): Observable<{ rejected: boolean; }> {
        return this.http.post<{ rejected: boolean; }>(
            this.url(`/api/ai/proposals/${this.segment(proposalId)}/reject`),
            {},
            this.optionsBuilder.withAuthorization()
        );
    }

    /** Reads the attribution log. */
    getActivity(limit = 100): Observable<ActivityEntry[]> {
        const options = this.optionsBuilder.buildOptions().addAuthToken().addParam('limit', limit).build();
        return this.http.get<ActivityEntry[]>(this.url('/api/ai/activity'), options);
    }

    /** Marks an activity entry as undone. */
    markActivityUndone(entryId: string): Observable<{ marked: boolean; }> {
        return this.http.post<{ marked: boolean; }>(
            this.url(`/api/ai/activity/${this.segment(entryId)}/undone`),
            {},
            this.optionsBuilder.withAuthorization()
        );
    }

    /** Builds a collection-scoped path. */
    private collectionPath(connectionId: ObjectId, databaseName: string, collectionName: string, suffix: string): string {
        return (
            `/api/connections/${connectionId}` +
            `/databases/${this.segment(databaseName)}` +
            `/collections/${this.segment(collectionName)}${suffix}`
        );
    }
}
