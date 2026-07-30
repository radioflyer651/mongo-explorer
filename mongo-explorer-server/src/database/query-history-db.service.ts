import { injectable } from 'inversify';
import { ObjectId } from 'mongodb';
import { DbService } from './db-service';
import { MongoHelper } from '../mongo-helper';
import { DbCollectionNames } from '../model/db-collection-names.constants';
import { nowIso } from '../utils/misc.util';

/** One executed query, retained so it can be recalled or favourited. */
export interface QueryHistoryEntry {
    /** Identifier in the Application Database. */
    _id: ObjectId;

    /** Connection the query ran against. */
    connectionId: ObjectId;

    /** Target Database name. */
    databaseName: string;

    /** Collection name. */
    collectionName: string;

    /** Filter as Extended JSON text. */
    filter?: string;

    /** Projection as Extended JSON text. */
    projection?: string;

    /** Sort as Extended JSON text. */
    sort?: string;

    /** When it ran, as an ISO-8601 string. */
    at: string;

    /** How long it took, in milliseconds. */
    durationMs?: number;

    /** How many documents came back. */
    returnedCount?: number;

    /** Whether the user marked this as a favourite. */
    isFavourite: boolean;

    /** Optional user-supplied name, for favourites. */
    name?: string;
}

/** Stores and recalls query history. */
@injectable()
export class QueryHistoryDbService extends DbService {
    constructor(dbHelper: MongoHelper) {
        super(dbHelper);
    }

    /** Appends an executed query to the history. */
    async recordQuery(entry: Omit<QueryHistoryEntry, '_id' | 'at' | 'isFavourite'>): Promise<void> {
        await this.dbHelper.upsertDataItem(DbCollectionNames.QueryHistory, {
            _id: new ObjectId(),
            ...entry,
            at: nowIso(),
            isFavourite: false,
        });
    }

    /** Returns recent history for one collection, newest first. */
    async getHistory(connectionId: ObjectId, databaseName: string, collectionName: string, limit: number): Promise<QueryHistoryEntry[]> {
        return await this.dbHelper.makeCallWithCollection<QueryHistoryEntry, QueryHistoryEntry[]>(
            DbCollectionNames.QueryHistory,
            collection =>
                collection
                    .find({ connectionId, databaseName, collectionName })
                    .sort({ at: -1 })
                    .limit(limit)
                    .toArray() as Promise<QueryHistoryEntry[]>
        );
    }

    /** Returns every favourite, newest first. */
    async getFavourites(): Promise<QueryHistoryEntry[]> {
        return await this.dbHelper.makeCallWithCollection<QueryHistoryEntry, QueryHistoryEntry[]>(
            DbCollectionNames.QueryHistory,
            collection => collection.find({ isFavourite: true }).sort({ at: -1 }).toArray() as Promise<QueryHistoryEntry[]>
        );
    }

    /** Marks or unmarks a history entry as a favourite. */
    async setFavourite(entryId: ObjectId, isFavourite: boolean, name?: string): Promise<void> {
        await this.dbHelper.updateDataItems<QueryHistoryEntry>(
            DbCollectionNames.QueryHistory,
            { _id: entryId },
            { $set: { isFavourite, name } }
        );
    }
}
