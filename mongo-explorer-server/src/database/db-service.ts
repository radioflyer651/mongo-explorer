import { injectable } from 'inversify';
import { MongoHelper } from '../mongo-helper';

/**
 * Base for every Application Database service. Exists to delete repetitive helper
 * plumbing, not to grow an inheritance hierarchy.
 *
 * Application Database only. Target Database access goes through the explorer
 * services and a LiveConnection.
 */
@injectable()
export abstract class DbService {
    constructor(dbHelper: MongoHelper) {
        this.dbHelper = dbHelper;
    }

    /** Shared connection to the Application Database. */
    protected readonly dbHelper: MongoHelper;
}
