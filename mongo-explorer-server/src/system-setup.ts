import { Container } from 'inversify';
import { TOKENS } from './tokens';
import { MongoHelper } from './mongo-helper';
import { LogDbService } from './database/log-db.service';
import { DbCollectionNames } from './model/db-collection-names.constants';

/**
 * System-level initialisation: index creation on the Application Database and a
 * start-up log entry.
 */
export async function systemInitialization(container: Container): Promise<void> {
    const helper = await container.getAsync<MongoHelper>(TOKENS.MongoHelper);
    const logService = await container.getAsync<LogDbService>(TOKENS.LogDbService);

    await helper.makeCall(async database => {
        await database.collection(DbCollectionNames.SavedConnections).createIndex({ name: 1 }, { unique: true });
        await database.collection(DbCollectionNames.Settings).createIndex({ key: 1 }, { unique: true });
        await database.collection(DbCollectionNames.ViewPreferences).createIndex(
            { connectionId: 1, databaseName: 1, collectionName: 1 },
            { unique: true }
        );
        await database.collection(DbCollectionNames.SavedPipelines).createIndex({ name: 1 });
        await database.collection(DbCollectionNames.QueryHistory).createIndex({ at: -1 });
        await database.collection(DbCollectionNames.Logs).createIndex({ at: -1 });
    });

    await logService.logMessage({ level: 'info', message: 'Mongo Explorer started.' });
}
