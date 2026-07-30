import { injectable } from 'inversify';
import { MongoClientOptions } from 'mongodb';
import {
    BuiltClientOptions,
    ConnectionContext,
    ConnectionValidationError,
    ConnectionValidationResult,
    IConnectionStrategy,
} from '../connection-strategy';
import { ConnectionStrategyKind } from '../../model/shared-models/connections/connection-strategy-kind.model';
import { SavedConnection, TransportOptions } from '../../model/shared-models/connections/saved-connection.model';

/** Applies shared transport options onto driver options. */
export function applyTransportOptions(options: MongoClientOptions, transport: TransportOptions | undefined): void {
    if (!transport) {
        return;
    }

    if (transport.useTls !== undefined) {
        options.tls = transport.useTls;
    }

    if (transport.tlsCaFilePath) {
        options.tlsCAFile = transport.tlsCaFilePath;
    }

    if (transport.tlsAllowInvalidCertificates) {
        options.tlsAllowInvalidCertificates = true;
    }

    if (transport.retryWrites !== undefined) {
        options.retryWrites = transport.retryWrites;
    }

    if (transport.maxIdleTimeMs !== undefined) {
        options.maxIdleTimeMS = transport.maxIdleTimeMs;
    }

    options.serverSelectionTimeoutMS = transport.serverSelectionTimeoutMs ?? 10_000;
}

/**
 * A complete connection URI supplied by the user. Covers local development,
 * self-hosted deployments, and Atlas with SCRAM.
 */
@injectable()
export class ConnectionStringStrategy implements IConnectionStrategy {
    readonly kind = ConnectionStrategyKind.ConnectionString;
    readonly displayName = 'Connection string';
    readonly requiresRefresh = false;

    validate(connection: SavedConnection): ConnectionValidationResult {
        const errors: ConnectionValidationError[] = [];
        const uri = connection.config.connectionString?.uri?.trim();

        if (!uri) {
            errors.push({ path: 'connectionString.uri', message: 'A connection string is required.' });
        } else if (!/^mongodb(\+srv)?:\/\//i.test(uri)) {
            errors.push({
                path: 'connectionString.uri',
                message: 'A connection string must begin with mongodb:// or mongodb+srv://.',
            });
        }

        return { isValid: errors.length === 0, errors };
    }

    async buildClientOptions(connection: SavedConnection, _context: ConnectionContext): Promise<BuiltClientOptions> {
        const config = connection.config.connectionString;
        const options: MongoClientOptions = {};

        applyTransportOptions(options, connection.config.transport);

        return {
            uri: config?.uri ?? '',
            options,
            defaultDatabase: config?.defaultDatabase,
        };
    }
}
