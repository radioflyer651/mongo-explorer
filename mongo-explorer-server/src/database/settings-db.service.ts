import { injectable } from 'inversify';
import { DbService } from './db-service';
import { MongoHelper } from '../mongo-helper';
import { DbCollectionNames } from '../model/db-collection-names.constants';

/** A single application setting, stored as a key and value. */
interface SettingRecord {
    /** Setting key. */
    key: string;

    /** Setting value, as a JSON-serialisable value. */
    value: unknown;
}

/** Key of the persisted MCP permission mode. */
export const SETTING_MCP_MODE = 'mcpMode';

/** Reads and writes application settings. */
@injectable()
export class SettingsDbService extends DbService {
    constructor(dbHelper: MongoHelper) {
        super(dbHelper);
    }

    /** Reads a setting, returning the fallback when it has never been written. */
    async getSetting<T>(key: string, fallback: T): Promise<T> {
        const record = await this.dbHelper.findDataItem<SettingRecord & { _id: never; }>(
            DbCollectionNames.Settings,
            { key },
            { findOne: true }
        );

        if (!record) {
            return fallback;
        }

        return (record as unknown as SettingRecord).value as T;
    }

    /** Writes a setting. */
    async setSetting(key: string, value: unknown): Promise<void> {
        await this.dbHelper.makeCallWithCollection(DbCollectionNames.Settings, async collection => {
            await collection.updateOne({ key }, { $set: { key, value } }, { upsert: true });
        });
    }
}
