import { injectable } from 'inversify';
import { ObjectId } from 'mongodb';
import { DbService } from './db-service';
import { MongoHelper } from '../mongo-helper';
import { DbCollectionNames } from '../model/db-collection-names.constants';

/**
 * Per-collection interface preferences. View choice persists so someone who always
 * wants JSON for one collection does not have to re-choose it.
 */
export interface ViewPreference {
    /** Identifier in the Application Database. */
    _id: ObjectId;

    /** Connection the preference belongs to. */
    connectionId: ObjectId;

    /** Target Database name. */
    databaseName: string;

    /** Collection name. */
    collectionName: string;

    /** Which registered view was last used. */
    viewId: string;

    /** Column paths that are hidden. */
    hiddenColumns?: string[];

    /** Explicit column order, when the user has reordered them. */
    columnOrder?: string[];

    /** Page size the user last chose. */
    pageSize?: number;
}

/** Stores and retrieves per-collection view preferences. */
@injectable()
export class ViewPreferenceDbService extends DbService {
    constructor(dbHelper: MongoHelper) {
        super(dbHelper);
    }

    /** Reads the preference for one collection, when one has been stored. */
    async getPreference(connectionId: ObjectId, databaseName: string, collectionName: string): Promise<ViewPreference | undefined> {
        const found = await this.dbHelper.findDataItem<ViewPreference>(
            DbCollectionNames.ViewPreferences,
            { connectionId, databaseName, collectionName },
            { findOne: true }
        );

        return found as ViewPreference | undefined;
    }

    /** Writes the preference for one collection. */
    async savePreference(preference: Omit<ViewPreference, '_id'> & { _id?: ObjectId; }): Promise<void> {
        await this.dbHelper.makeCallWithCollection(DbCollectionNames.ViewPreferences, async collection => {
            await collection.updateOne(
                {
                    connectionId: preference.connectionId,
                    databaseName: preference.databaseName,
                    collectionName: preference.collectionName,
                },
                {
                    $set: {
                        viewId: preference.viewId,
                        hiddenColumns: preference.hiddenColumns,
                        columnOrder: preference.columnOrder,
                        pageSize: preference.pageSize,
                    },
                },
                { upsert: true }
            );
        });
    }
}
