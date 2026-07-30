import { ObjectId } from 'mongodb';

/** What kind of data change a proposal describes. */
export enum ProposalKind {
    /** Update documents matching a filter. */
    DocumentUpdate = 'document-update',

    /** Replace a single document wholesale. */
    DocumentReplace = 'document-replace',

    /** Insert one or more documents. */
    DocumentInsert = 'document-insert',

    /** Delete documents matching a filter. */
    DocumentDelete = 'document-delete',

    /** Create an index. */
    IndexCreate = 'index-create',

    /** Drop an index. */
    IndexDrop = 'index-drop',

    /** Create, rename, or drop a collection. */
    CollectionOperation = 'collection-operation',

    /** Run an aggregation pipeline that contains a write stage. */
    PipelineRun = 'pipeline-run',

    /** Run a shell command that is not classified read-only. */
    ShellCommand = 'shell-command',
}

/** The exact operation a proposal will perform, as Extended JSON strings. */
export interface ProposalOperation {
    /** Which kind of operation this is. */
    kind: ProposalKind;

    /** Filter as Extended JSON, for update and delete operations. */
    filterJson?: string;

    /** Update document as Extended JSON, for update operations. */
    updateJson?: string;

    /** Replacement or insert documents as Extended JSON. */
    documentsJson?: string;

    /** Whether the operation affects many documents rather than one. */
    isMany?: boolean;

    /** Index specification as Extended JSON, for index operations. */
    indexJson?: string;

    /** Index name, for index drops. */
    indexName?: string;

    /** Collection sub-operation, for collection operations. */
    collectionAction?: 'create' | 'rename' | 'drop';

    /** New name, for a rename. */
    newName?: string;

    /** Pipeline stages as Extended JSON, for pipeline runs. */
    pipelineJson?: string;

    /** Raw command text, for shell commands. */
    shellInput?: string;
}

/** Whether the user can get back to where they were after applying. */
export type ProposalReversal =
    | { kind: 'none'; explanation: string; }
    | { kind: 'inverse-operation'; operation: ProposalOperation; }
    | { kind: 'snapshot'; documentCount: number; };

/** Lifecycle status of a proposal. */
export type ProposalStatus = 'pending' | 'applied' | 'rejected' | 'withdrawn' | 'stale';

/**
 * A data change described by an AI, awaiting user execution. A proposal is data,
 * not an intention to act: nothing in the server acts on one. The only code that
 * executes a proposal is reached from a user gesture, and runs as actor 'user'.
 */
export interface DataProposal {
    /** Stable identifier. */
    id: string;

    /** When the proposal was created, as an ISO-8601 string. */
    createdAt: string;

    /** Always 'mcp' — a user-authored change is not a proposal. */
    actor: 'mcp';

    /** Which kind of change this is. */
    kind: ProposalKind;

    /** Which connection the change targets. */
    connectionId: ObjectId;

    /** Target Database name. */
    databaseName: string;

    /** Collection name, absent for database-level operations. */
    collectionName?: string;

    /** One-sentence plain-language statement of what this does. Required. */
    summary: string;

    /** Why the change is being proposed. Required: unexplained is unreviewable. */
    rationale: string;

    /** The exact operation. What executes is what is displayed. */
    operation: ProposalOperation;

    /** Real count from a count operation, absent when it could not be determined. */
    affectedCount?: number;

    /** Whether and how the change can be undone. */
    reversal: ProposalReversal;

    /** Current status. */
    status: ProposalStatus;

    /**
     * Snapshot of affected documents as Extended JSON, captured at apply time to
     * make the change undoable. Absent when the affected count exceeded the cap.
     */
    snapshotJson?: string;

    /** When the status last changed, as an ISO-8601 string. */
    statusChangedAt?: string;

    /** Why the proposal went stale, when it did. */
    staleReason?: string;
}

/** The compact form of a proposal carried in the session state. */
export interface ProposalSummary {
    /** Stable identifier. */
    id: string;

    /** Which kind of change this is. */
    kind: ProposalKind;

    /** One-sentence statement of what this does. */
    summary: string;

    /** Current status. */
    status: ProposalStatus;

    /** Target Database name. */
    databaseName: string;

    /** Collection name, when applicable. */
    collectionName?: string;

    /** Real affected count, when known. */
    affectedCount?: number;

    /** When the proposal was created. */
    createdAt: string;
}

/** Result of the user applying a proposal. */
export interface ProposalApplyResult {
    /** Which proposal was applied. */
    proposalId: string;

    /** Whether the operation succeeded. */
    succeeded: boolean;

    /** Documents actually affected. */
    affectedCount?: number;

    /** Error text, already redacted, when it failed. */
    error?: string;

    /** Whether an undo snapshot was captured. */
    isUndoable: boolean;
}
