import { injectable } from 'inversify';
import { Document } from 'mongodb';
import { ExplorerServiceBase } from './explorer-base';
import { LiveConnection } from '../connections/live-connection';
import { OperationActor, assertWriteAllowed } from './operation-actor';
import { ILimitsConfig } from '../model/app-config.model';
import { CollectionSummary, DatabaseSummary } from '../model/shared-models/explorer/explorer.model';
import { errorMessage } from '../utils/misc.util';

/**
 * Database and collection enumeration against a Target Database.
 *
 * Takes a LiveConnection, never a connection string. Never a MongoHelper.
 */
@injectable()
export class DatabaseExplorerService extends ExplorerServiceBase {
    constructor(limits: ILimitsConfig) {
        super(limits);
    }

    /** Lists databases on the deployment. */
    async listDatabases(connection: LiveConnection): Promise<DatabaseSummary[]> {
        const result = await connection.listDatabases();
        const databases = (result['databases'] as Document[] | undefined) ?? [];

        return databases.map(entry => ({
            name: String(entry['name']),
            sizeOnDisk: typeof entry['sizeOnDisk'] === 'number' ? entry['sizeOnDisk'] : undefined,
            isEmpty: typeof entry['empty'] === 'boolean' ? entry['empty'] : undefined,
        }));
    }

    /** Lists collections in one database, with statistics where permitted. */
    async listCollections(connection: LiveConnection, databaseName: string): Promise<CollectionSummary[]> {
        const database = connection.getDatabase(databaseName);
        const infos = await database.listCollections({}, { nameOnly: false }).toArray();
        const summaries: CollectionSummary[] = [];

        for (const info of infos) {
            const summary: CollectionSummary = {
                name: info.name,
                isView: info.type === 'view',
                isTimeSeries: info.type === 'timeseries',
            };

            if (!summary.isView && connection.serverCapabilities?.supportsCollStats !== false) {
                Object.assign(summary, await this.tryGetStats(connection, databaseName, info.name));
            }

            summaries.push(summary);
        }

        summaries.sort((a, b) => a.name.localeCompare(b.name));
        return summaries;
    }

    /** Returns statistics for one collection. */
    async getCollectionStats(connection: LiveConnection, databaseName: string, collectionName: string): Promise<CollectionSummary> {
        const database = connection.getDatabase(databaseName);
        const infos = await database.listCollections({ name: collectionName }, { nameOnly: false }).toArray();
        const info = infos[0];

        const summary: CollectionSummary = {
            name: collectionName,
            isView: info?.type === 'view',
            isTimeSeries: info?.type === 'timeseries',
        };

        Object.assign(summary, await this.tryGetStats(connection, databaseName, collectionName));
        return summary;
    }

    /** Creates a database by creating its first collection. */
    async createDatabase(
        connection: LiveConnection,
        databaseName: string,
        firstCollectionName: string,
        actor: OperationActor
    ): Promise<void> {
        assertWriteAllowed(connection, actor, 'createDatabase');
        await connection.getDatabase(databaseName).createCollection(firstCollectionName);
    }

    /** Drops an entire database. */
    async dropDatabase(connection: LiveConnection, databaseName: string, actor: OperationActor): Promise<void> {
        assertWriteAllowed(connection, actor, 'dropDatabase');
        await connection.getDatabase(databaseName).dropDatabase();
    }

    /** Creates a collection. */
    async createCollection(
        connection: LiveConnection,
        databaseName: string,
        collectionName: string,
        actor: OperationActor
    ): Promise<void> {
        assertWriteAllowed(connection, actor, 'createCollection');
        await connection.getDatabase(databaseName).createCollection(collectionName);
    }

    /** Drops a collection. */
    async dropCollection(
        connection: LiveConnection,
        databaseName: string,
        collectionName: string,
        actor: OperationActor
    ): Promise<void> {
        assertWriteAllowed(connection, actor, 'dropCollection');
        await connection.getDatabase(databaseName).collection(collectionName).drop();
    }

    /** Renames a collection. */
    async renameCollection(
        connection: LiveConnection,
        databaseName: string,
        collectionName: string,
        newName: string,
        actor: OperationActor
    ): Promise<void> {
        assertWriteAllowed(connection, actor, 'renameCollection');
        await connection.getDatabase(databaseName).renameCollection(collectionName, newName);
    }

    /** Reads collStats, tolerating deployments that refuse the command. */
    private async tryGetStats(
        connection: LiveConnection,
        databaseName: string,
        collectionName: string
    ): Promise<Partial<CollectionSummary>> {
        try {
            const stats = await connection.runCommand(databaseName, { collStats: collectionName });

            return {
                documentCount: this.asNumber(stats['count']),
                dataSize: this.asNumber(stats['size']),
                storageSize: this.asNumber(stats['storageSize']),
                averageDocumentSize: this.asNumber(stats['avgObjSize']),
                indexCount: this.asNumber(stats['nindexes']),
                totalIndexSize: this.asNumber(stats['totalIndexSize']),
            };
        } catch (error) {
            /* Some deployments refuse collStats. Fall back to an estimate rather
               than failing the whole listing. */
            try {
                const estimated = await connection
                    .getDatabase(databaseName)
                    .collection(collectionName)
                    .estimatedDocumentCount({ maxTimeMS: this.resolveTimeMs(undefined) });

                return { documentCount: estimated };
            } catch {
                void errorMessage(error);
                return {};
            }
        }
    }

    /** Coerces a driver-reported numeric value. */
    private asNumber(value: unknown): number | undefined {
        if (typeof value === 'number') {
            return value;
        }

        if (typeof value === 'object' && value !== null && 'valueOf' in value) {
            const converted = Number((value as { valueOf(): unknown; }).valueOf());
            return Number.isNaN(converted) ? undefined : converted;
        }

        return undefined;
    }
}
