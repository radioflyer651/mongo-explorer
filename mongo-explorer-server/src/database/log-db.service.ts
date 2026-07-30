import { injectable } from 'inversify';
import { ObjectId } from 'mongodb';
import { DbService } from './db-service';
import { MongoHelper } from '../mongo-helper';
import { DbCollectionNames } from '../model/db-collection-names.constants';
import { nowIso } from '../utils/misc.util';
import { redactObject } from '../utils/redaction.util';

/** Severity of a log entry. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** One application log entry. */
export interface LogEntry {
    /** Identifier in the Application Database. */
    _id: ObjectId;

    /** Severity. */
    level: LogLevel;

    /** Message text. */
    message: string;

    /** Structured context, already redacted before storage. */
    data?: unknown;

    /** When the entry was written, as an ISO-8601 string. */
    at: string;
}

/** Writes application log entries to the Application Database. */
@injectable()
export class LogDbService extends DbService {
    constructor(dbHelper: MongoHelper) {
        super(dbHelper);
    }

    /**
     * Appends a log entry. Context is redacted before storage, so a credential
     * cannot reach the log even if a caller passes one in.
     */
    async logMessage(entry: { level: LogLevel; message: string; data?: unknown; }): Promise<void> {
        try {
            await this.dbHelper.makeCallWithCollection(DbCollectionNames.Logs, async collection => {
                await collection.insertOne({
                    level: entry.level,
                    message: entry.message,
                    data: entry.data === undefined ? undefined : redactObject(entry.data),
                    at: nowIso(),
                });
            });
        } catch {
            /* Logging must never break the caller. */
        }
    }

    /** Returns recent log entries, newest first. */
    async getRecentEntries(limit: number): Promise<LogEntry[]> {
        return await this.dbHelper.makeCallWithCollection<LogEntry, LogEntry[]>(
            DbCollectionNames.Logs,
            collection => collection.find({}).sort({ at: -1 }).limit(limit).toArray() as Promise<LogEntry[]>
        );
    }
}
