import { injectable } from 'inversify';
import { Document, IndexSpecification } from 'mongodb';
import { ExplorerServiceBase } from './explorer-base';
import { LiveConnection } from '../connections/live-connection';
import { OperationActor, assertWriteAllowed } from './operation-actor';
import { ILimitsConfig } from '../model/app-config.model';
import { IndexInfo } from '../model/shared-models/explorer/explorer.model';
import { parseExtendedJsonObject, toExtendedJson } from '../utils/ejson.util';

/** Index administration against a Target Database. */
@injectable()
export class IndexAdminService extends ExplorerServiceBase {
    constructor(limits: ILimitsConfig) {
        super(limits);
    }

    /** Lists indexes on a collection, with sizes where the deployment reports them. */
    async listIndexes(connection: LiveConnection, databaseName: string, collectionName: string): Promise<IndexInfo[]> {
        const collection = connection.getDatabase(databaseName).collection(collectionName);
        const raw = await collection.indexes();
        const sizes = await this.tryGetIndexSizes(connection, databaseName, collectionName);

        return raw.map(entry => {
            const index = entry as Document;
            const name = String(index['name']);

            return {
                name,
                key: (index['key'] as Record<string, unknown>) ?? {},
                isUnique: index['unique'] === true,
                isSparse: index['sparse'] === true,
                isText: Object.values((index['key'] as Record<string, unknown>) ?? {}).includes('text'),
                expireAfterSeconds: typeof index['expireAfterSeconds'] === 'number' ? index['expireAfterSeconds'] : undefined,
                partialFilterExpression: index['partialFilterExpression']
                    ? toExtendedJson(index['partialFilterExpression'])
                    : undefined,
                sizeInBytes: sizes[name],
            };
        });
    }

    /** Creates an index from an Extended JSON key specification. */
    async createIndex(
        connection: LiveConnection,
        databaseName: string,
        collectionName: string,
        keyJson: string,
        options: { name?: string; unique?: boolean; sparse?: boolean; expireAfterSeconds?: number; partialFilterExpressionJson?: string; },
        actor: OperationActor
    ): Promise<string> {
        assertWriteAllowed(connection, actor, 'createIndex');

        const key = parseExtendedJsonObject(keyJson, 'index key') as IndexSpecification;
        const collection = connection.getDatabase(databaseName).collection(collectionName);

        return await collection.createIndex(key, {
            name: options.name,
            unique: options.unique,
            sparse: options.sparse,
            expireAfterSeconds: options.expireAfterSeconds,
            partialFilterExpression: options.partialFilterExpressionJson
                ? parseExtendedJsonObject(options.partialFilterExpressionJson, 'partial filter expression')
                : undefined,
        });
    }

    /** Drops an index by name. */
    async dropIndex(
        connection: LiveConnection,
        databaseName: string,
        collectionName: string,
        indexName: string,
        actor: OperationActor
    ): Promise<void> {
        assertWriteAllowed(connection, actor, 'dropIndex');

        if (indexName === '_id_') {
            throw new Error('The _id index cannot be dropped.');
        }

        await connection.getDatabase(databaseName).collection(collectionName).dropIndex(indexName);
    }

    /** Reads per-index sizes, tolerating deployments that refuse collStats. */
    private async tryGetIndexSizes(
        connection: LiveConnection,
        databaseName: string,
        collectionName: string
    ): Promise<Record<string, number>> {
        try {
            const stats = await connection.runCommand(databaseName, { collStats: collectionName });
            const sizes = stats['indexSizes'] as Record<string, unknown> | undefined;

            if (!sizes) {
                return {};
            }

            const result: Record<string, number> = {};

            for (const [name, size] of Object.entries(sizes)) {
                if (typeof size === 'number') {
                    result[name] = size;
                }
            }

            return result;
        } catch {
            return {};
        }
    }
}
