import { injectable } from 'inversify';
import { Document, Sort } from 'mongodb';
import { ExplorerServiceBase } from './explorer-base';
import { LiveConnection } from '../connections/live-connection';
import { ILimitsConfig } from '../model/app-config.model';
import {
    CountResult,
    ExplainResult,
    QueryRequest,
    QueryResultPage,
    SchemaSample,
} from '../model/shared-models/explorer/explorer.model';
import { deriveFields, parseExtendedJsonObject, toExtendedJson } from '../utils/ejson.util';

/**
 * Reads documents from a Target Database. Every call is bounded: an explicit limit,
 * an explicit time budget, and a server-side cap the client cannot exceed.
 *
 * Truncation is always reported. A silently capped result set makes the application
 * lie about completeness, which is worse than an error.
 */
@injectable()
export class QueryService extends ExplorerServiceBase {
    constructor(limits: ILimitsConfig) {
        super(limits);
    }

    /** Runs a find and returns one bounded page. */
    async findDocuments(connection: LiveConnection, request: QueryRequest): Promise<QueryResultPage> {
        const limit = this.resolveLimit(request.limit);
        const maxTimeMs = this.resolveTimeMs(request.maxTimeMs);
        const skip = Math.max(0, Math.floor(request.skip ?? 0));

        const filter = parseExtendedJsonObject(request.filter ?? '', 'filter');
        const projection = request.projection ? parseExtendedJsonObject(request.projection, 'projection') : undefined;
        const sort = request.sort ? (parseExtendedJsonObject(request.sort, 'sort') as Sort) : undefined;

        const collection = connection.getDatabase(request.databaseName).collection(request.collectionName);
        const startedAt = Date.now();

        let cursor = collection.find(filter, { maxTimeMS: maxTimeMs });

        if (projection) {
            cursor = cursor.project(projection);
        }

        if (sort) {
            cursor = cursor.sort(sort);
        }

        /* Fetch one extra document so hasMore is a fact rather than a guess. */
        cursor = cursor.skip(skip).limit(limit + 1);

        let documents: Document[];
        let isPartial = false;
        let partialReason: QueryResultPage['partialReason'];

        try {
            documents = await cursor.toArray();
        } catch (error) {
            if (!this.isTimeoutError(error)) {
                throw error;
            }

            documents = [];
            isPartial = true;
            partialReason = 'time-limit';
        }

        const hasMore = documents.length > limit;
        const page = hasMore ? documents.slice(0, limit) : documents;

        if (hasMore) {
            isPartial = true;
            partialReason = partialReason ?? 'page-cap';
        }

        return {
            documentsJson: toExtendedJson(page),
            returnedCount: page.length,
            appliedLimit: limit,
            appliedSkip: skip,
            hasMore,
            isPartial,
            partialReason,
            durationMs: Date.now() - startedAt,
            fields: deriveFields(page),
        };
    }

    /** Counts matching documents, falling back to an estimate when necessary. */
    async countDocuments(connection: LiveConnection, request: Omit<QueryRequest, 'limit' | 'skip'>): Promise<CountResult> {
        const filter = parseExtendedJsonObject(request.filter ?? '', 'filter');
        const collection = connection.getDatabase(request.databaseName).collection(request.collectionName);
        const maxTimeMS = this.resolveTimeMs(request.maxTimeMs);

        try {
            const count = await collection.countDocuments(filter, { maxTimeMS });
            return { count, isEstimate: false };
        } catch (error) {
            if (!this.isTimeoutError(error) || Object.keys(filter).length > 0) {
                throw error;
            }

            const estimated = await collection.estimatedDocumentCount({ maxTimeMS });
            return { count: estimated, isEstimate: true };
        }
    }

    /** Samples documents to infer the collection's shape. */
    async inferSchema(
        connection: LiveConnection,
        databaseName: string,
        collectionName: string,
        sampleSize?: number
    ): Promise<SchemaSample> {
        const size = this.resolveSampleSize(sampleSize, this.limits.schemaSampleSize);
        const maxTimeMS = this.resolveTimeMs(undefined);
        const collection = connection.getDatabase(databaseName).collection(collectionName);
        const startedAt = Date.now();

        const documents = await collection
            .aggregate([{ $sample: { size } }], { maxTimeMS })
            .toArray();

        return {
            sampleSize: documents.length,
            fields: deriveFields(documents, 4),
            durationMs: Date.now() - startedAt,
        };
    }

    /** Samples documents without inferring a schema. */
    async sampleDocuments(
        connection: LiveConnection,
        databaseName: string,
        collectionName: string,
        sampleSize?: number
    ): Promise<QueryResultPage> {
        const size = this.resolveSampleSize(sampleSize, 20);
        const maxTimeMS = this.resolveTimeMs(undefined);
        const collection = connection.getDatabase(databaseName).collection(collectionName);
        const startedAt = Date.now();

        const documents = await collection.aggregate([{ $sample: { size } }], { maxTimeMS }).toArray();

        return {
            documentsJson: toExtendedJson(documents),
            returnedCount: documents.length,
            appliedLimit: size,
            appliedSkip: 0,
            hasMore: false,
            isPartial: true,
            partialReason: 'page-cap',
            durationMs: Date.now() - startedAt,
            fields: deriveFields(documents),
        };
    }

    /** Explains a find, extracting the parts users actually need. */
    async explainQuery(connection: LiveConnection, request: QueryRequest): Promise<ExplainResult> {
        const filter = parseExtendedJsonObject(request.filter ?? '', 'filter');
        const sort = request.sort ? (parseExtendedJsonObject(request.sort, 'sort') as Sort) : undefined;
        const collection = connection.getDatabase(request.databaseName).collection(request.collectionName);

        let cursor = collection.find(filter, { maxTimeMS: this.resolveTimeMs(request.maxTimeMs) });

        if (sort) {
            cursor = cursor.sort(sort);
        }

        const plan = (await cursor.limit(this.resolveLimit(request.limit)).explain('executionStats')) as Document;
        return summariseExplain(plan);
    }
}

/** Extracts the useful parts of an explain plan for display. */
export function summariseExplain(plan: Document): ExplainResult {
    const winning = findWinningStage(plan);
    const stats = (plan['executionStats'] as Document | undefined) ?? {};

    return {
        planJson: toExtendedJson(plan),
        indexUsed: winning?.indexName,
        isCollectionScan: winning?.stage === 'COLLSCAN',
        documentsExamined: numberOrUndefined(stats['totalDocsExamined']),
        keysExamined: numberOrUndefined(stats['totalKeysExamined']),
        documentsReturned: numberOrUndefined(stats['nReturned']),
    };
}

/** Walks the plan tree looking for the stage that did the work. */
function findWinningStage(plan: Document): { stage?: string; indexName?: string; } | undefined {
    const queryPlanner = plan['queryPlanner'] as Document | undefined;
    let node = queryPlanner?.['winningPlan'] as Document | undefined;

    while (node) {
        const stage = node['stage'] as string | undefined;

        if (stage === 'IXSCAN') {
            return { stage, indexName: node['indexName'] as string | undefined };
        }

        if (stage === 'COLLSCAN') {
            return { stage };
        }

        node = (node['inputStage'] as Document | undefined)
            ?? ((node['inputStages'] as Document[] | undefined)?.[0]);
    }

    return undefined;
}

/** Coerces a plan value to a number when it is one. */
function numberOrUndefined(value: unknown): number | undefined {
    return typeof value === 'number' ? value : undefined;
}
