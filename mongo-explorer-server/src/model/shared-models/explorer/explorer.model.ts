import { ObjectId } from 'mongodb';
import { FieldDescriptor } from './bson-type.model';

/**
 * Identifies a Target Database collection. Carried on nearly every explorer
 * request; the envelope is strongly typed even though the documents inside are
 * not.
 */
export interface CollectionRef {
    /** Which saved connection to operate through. */
    connectionId: ObjectId;

    /** Target Database name. Runtime user data, never a constant. */
    databaseName: string;

    /** Target Database collection name. Runtime user data, never a constant. */
    collectionName: string;
}

/** Summary of one database on a Target Database deployment. */
export interface DatabaseSummary {
    /** Database name. */
    name: string;

    /** Total size on disk in bytes, when the deployment reports it. */
    sizeOnDisk?: number;

    /** Whether the deployment reports the database as empty. */
    isEmpty?: boolean;

    /** Number of collections, when cheaply available. */
    collectionCount?: number;
}

/** Summary of one collection on a Target Database deployment. */
export interface CollectionSummary {
    /** Collection name. */
    name: string;

    /** Whether this is a view rather than a collection. */
    isView: boolean;

    /** Whether the collection is a time-series collection. */
    isTimeSeries: boolean;

    /** Estimated document count. */
    documentCount?: number;

    /** Total data size in bytes. */
    dataSize?: number;

    /** Total storage size in bytes. */
    storageSize?: number;

    /** Average document size in bytes. */
    averageDocumentSize?: number;

    /** Number of indexes on the collection. */
    indexCount?: number;

    /** Total index size in bytes. */
    totalIndexSize?: number;
}

/** One index on a Target Database collection. */
export interface IndexInfo {
    /** Index name. */
    name: string;

    /** Key specification, as field path to direction or index type. */
    key: Record<string, unknown>;

    /** Whether the index enforces uniqueness. */
    isUnique: boolean;

    /** Whether the index is sparse. */
    isSparse: boolean;

    /** Whether the index is a text index. */
    isText: boolean;

    /** Time-to-live in seconds, when the index expires documents. */
    expireAfterSeconds?: number;

    /** Partial filter expression, as Extended JSON, when partial. */
    partialFilterExpression?: string;

    /** Index size in bytes, when reported. */
    sizeInBytes?: number;
}

/**
 * A document query request. Every field that could cause an unbounded read is
 * mandatory or capped server-side.
 */
export interface QueryRequest extends CollectionRef {
    /** Filter as an Extended JSON string. Empty or absent means match all. */
    filter?: string;

    /** Projection as an Extended JSON string. */
    projection?: string;

    /** Sort specification as an Extended JSON string. */
    sort?: string;

    /** Maximum documents to return. Clamped to the server page cap. */
    limit: number;

    /** Documents to skip. */
    skip: number;

    /** Query time budget in milliseconds. Clamped to the server maximum. */
    maxTimeMs?: number;
}

/**
 * A page of query results. Truncation is always reported: a silently capped
 * result set makes the tool lie about completeness.
 */
export interface QueryResultPage {
    /** The documents, serialised as Extended JSON (canonical mode). */
    documentsJson: string;

    /** How many documents this page contains. */
    returnedCount: number;

    /** The limit that was applied after clamping. */
    appliedLimit: number;

    /** The skip that was applied. */
    appliedSkip: number;

    /** True when more documents exist beyond this page. */
    hasMore: boolean;

    /** True when the page was capped or the query timed out. */
    isPartial: boolean;

    /** Why the result is partial, when it is. */
    partialReason?: 'page-cap' | 'time-limit' | 'size-limit';

    /** Wall-clock duration of the query in milliseconds. */
    durationMs: number;

    /** Fields observed in the returned documents, for column derivation. */
    fields: FieldDescriptor[];
}

/** Result of counting documents matching a filter. */
export interface CountResult {
    /** The matching document count. */
    count: number;

    /** True when the count is an estimate rather than exact. */
    isEstimate: boolean;
}

/** Inferred shape of a collection, derived from a sample. */
export interface SchemaSample {
    /** How many documents were sampled. */
    sampleSize: number;

    /** Observed fields, ordered by frequency then path. */
    fields: FieldDescriptor[];

    /** Wall-clock duration of the sampling operation in milliseconds. */
    durationMs: number;
}

/** An explain plan result, returned as Extended JSON for the viewer to render. */
export interface ExplainResult {
    /** The raw explain output as Extended JSON. */
    planJson: string;

    /** Extracted summary: which index was chosen, if any. */
    indexUsed?: string;

    /** Whether a full collection scan was chosen. */
    isCollectionScan: boolean;

    /** Documents examined, when reported. */
    documentsExamined?: number;

    /** Keys examined, when reported. */
    keysExamined?: number;

    /** Documents returned, when reported. */
    documentsReturned?: number;
}
