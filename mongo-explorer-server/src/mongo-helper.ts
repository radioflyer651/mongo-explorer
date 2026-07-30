import { Collection, Db, Document, Filter, MongoClient, ObjectId, OptionalUnlessRequiredId, Sort, UpdateFilter, WithId } from 'mongodb';
import { injectable } from 'inversify';
import { nullToUndefined } from './utils/misc.util';
import { redactConnectionString } from './utils/redaction.util';

/**
 * Thin wrapper around the official MongoClient for the APPLICATION DATABASE ONLY.
 *
 * It assumes one persistent connection to one known database whose schemas we own.
 * A Target Database is none of those things — handing this class a user's cluster
 * is the defining mistake of this codebase. Target access goes through
 * ConnectionManager and LiveConnection instead.
 */
@injectable()
export class MongoHelper {
    constructor(connectionString: string, databaseName: string) {
        this.connectionString = connectionString;
        this.databaseName = databaseName;
        this.client = new MongoClient(connectionString, { serverSelectionTimeoutMS: 10_000 });
    }

    private readonly connectionString: string;
    private readonly databaseName: string;
    private readonly client: MongoClient;
    private database?: Db;
    private isIntentionallyDisconnected = false;

    /** Whether a connection is currently established. */
    get isConnected(): boolean {
        return this.database !== undefined;
    }

    /** The redacted connection string, safe for logging. */
    get safeConnectionString(): string {
        return redactConnectionString(this.connectionString);
    }

    /** Opens the connection. Idempotent. */
    async connect(): Promise<void> {
        if (this.database) {
            return;
        }

        await this.client.connect();
        this.database = this.client.db(this.databaseName);

        this.client.on('close', () => {
            this.database = undefined;

            if (!this.isIntentionallyDisconnected) {
                void this.connect().catch(() => {
                    /* A failed reconnect leaves isConnected false; the next call retries. */
                });
            }
        });
    }

    /** Closes the connection and suppresses the reconnect handler. */
    async disconnect(): Promise<void> {
        this.isIntentionallyDisconnected = true;
        this.database = undefined;
        await this.client.close();
    }

    /** Runs a callback against the database, connecting first when needed. */
    async makeCall<T>(work: (database: Db) => Promise<T>): Promise<T> {
        await this.connect();
        return await work(this.database as Db);
    }

    /** Runs a callback against one collection, connecting first when needed. */
    async makeCallWithCollection<TDocument extends Document, TResult>(
        collectionName: string,
        work: (collection: Collection<TDocument>) => Promise<TResult>
    ): Promise<TResult> {
        return await this.makeCall(database => work(database.collection<TDocument>(collectionName)));
    }

    /** Finds a single matching item, or undefined when none matches. */
    async findDataItem<TDocument extends Document>(
        collectionName: string,
        filter: Filter<TDocument>,
        options: { findOne: true; }
    ): Promise<WithId<TDocument> | undefined>;

    /** Finds every matching item. */
    async findDataItem<TDocument extends Document>(
        collectionName: string,
        filter: Filter<TDocument>,
        options?: { findOne?: false; sort?: Sort; limit?: number; }
    ): Promise<WithId<TDocument>[]>;

    async findDataItem<TDocument extends Document>(
        collectionName: string,
        filter: Filter<TDocument>,
        options?: { findOne?: boolean; sort?: Sort; limit?: number; }
    ): Promise<WithId<TDocument> | undefined | WithId<TDocument>[]> {
        return await this.makeCallWithCollection<TDocument, WithId<TDocument> | undefined | WithId<TDocument>[]>(
            collectionName,
            async collection => {
                if (options?.findOne) {
                    return nullToUndefined(await collection.findOne(filter));
                }

                let cursor = collection.find(filter);

                if (options?.sort) {
                    cursor = cursor.sort(options.sort);
                }

                if (options?.limit) {
                    cursor = cursor.limit(options.limit);
                }

                return await cursor.toArray();
            }
        );
    }

    /** Updates every matching item and returns how many were modified. */
    async updateDataItems<TDocument extends Document>(
        collectionName: string,
        filter: Filter<TDocument>,
        update: UpdateFilter<TDocument>
    ): Promise<number> {
        return await this.makeCallWithCollection<TDocument, number>(collectionName, async collection => {
            const result = await collection.updateMany(filter, update);
            return result.modifiedCount;
        });
    }

    /** Deletes every matching item and returns how many were removed. */
    async deleteDataItems<TDocument extends Document>(
        collectionName: string,
        filter: Filter<TDocument>
    ): Promise<number> {
        return await this.makeCallWithCollection<TDocument, number>(collectionName, async collection => {
            const result = await collection.deleteMany(filter);
            return result.deletedCount;
        });
    }

    /** Inserts when the item has no identifier, replaces when it does. */
    async upsertDataItem<TDocument extends Document & { _id?: ObjectId; }>(
        collectionName: string,
        item: TDocument
    ): Promise<TDocument & { _id: ObjectId; }> {
        return await this.makeCallWithCollection<Document, TDocument & { _id: ObjectId; }>(
            collectionName,
            async collection => {
                if (item._id) {
                    const { _id, ...rest } = item;
                    await collection.replaceOne({ _id }, rest as Document, { upsert: true });
                    return item as TDocument & { _id: ObjectId; };
                }

                const result = await collection.insertOne(item as OptionalUnlessRequiredId<Document>);
                return { ...item, _id: result.insertedId } as TDocument & { _id: ObjectId; };
            }
        );
    }

    /** Counts matching items. */
    async countDataItems<TDocument extends Document>(
        collectionName: string,
        filter: Filter<TDocument>
    ): Promise<number> {
        return await this.makeCallWithCollection<TDocument, number>(
            collectionName,
            collection => collection.countDocuments(filter)
        );
    }
}
