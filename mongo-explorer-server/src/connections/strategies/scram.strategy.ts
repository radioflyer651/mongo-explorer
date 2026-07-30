import { injectable } from 'inversify';
import { MongoClientOptions } from 'mongodb';
import {
    BuiltClientOptions,
    ConnectionContext,
    ConnectionStrategyError,
    ConnectionValidationError,
    ConnectionValidationResult,
    IConnectionStrategy,
} from '../connection-strategy';
import { applyTransportOptions } from './connection-string.strategy';
import { ConnectionStrategyKind } from '../../model/shared-models/connections/connection-strategy-kind.model';
import { SavedConnection } from '../../model/shared-models/connections/saved-connection.model';

/**
 * Username and password authentication with a friendly form, so users do not have
 * to hand-assemble a URI.
 */
@injectable()
export class ScramStrategy implements IConnectionStrategy {
    readonly kind = ConnectionStrategyKind.Scram;
    readonly displayName = 'Username and password';
    readonly requiresRefresh = false;

    validate(connection: SavedConnection): ConnectionValidationResult {
        const errors: ConnectionValidationError[] = [];
        const config = connection.config.scram;

        if (!config) {
            errors.push({ path: 'scram', message: 'Username and password configuration is missing.' });
            return { isValid: false, errors };
        }

        if (!config.host?.trim()) {
            errors.push({ path: 'scram.host', message: 'A host is required.' });
        }

        if (!config.port || config.port < 1 || config.port > 65_535) {
            errors.push({ path: 'scram.port', message: 'A port between 1 and 65535 is required.' });
        }

        if (!config.userName?.trim()) {
            errors.push({ path: 'scram.userName', message: 'A user name is required.' });
        }

        return { isValid: errors.length === 0, errors };
    }

    async buildClientOptions(connection: SavedConnection, context: ConnectionContext): Promise<BuiltClientOptions> {
        const config = connection.config.scram;

        if (!config) {
            throw new ConnectionStrategyError('Username and password configuration is missing.', true);
        }

        let password = await context.getSecret();

        if (password === undefined) {
            /* Offer the no-stored-password path rather than failing outright. */
            context.prompt({
                kind: 'password',
                message: `Enter the password for ${config.userName} on ${config.host}.`,
            });

            throw new ConnectionStrategyError(
                'No password is stored for this connection. Supply one to connect.',
                true
            );
        }

        const options: MongoClientOptions = {
            auth: { username: config.userName, password },
            authSource: config.authSource || 'admin',
        };

        if (config.replicaSet) {
            options.replicaSet = config.replicaSet;
        }

        applyTransportOptions(options, connection.config.transport);
        password = '';

        return {
            uri: `mongodb://${config.host}:${config.port}`,
            options,
            defaultDatabase: config.defaultDatabase,
        };
    }
}
