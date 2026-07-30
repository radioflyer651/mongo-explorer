import fs from 'fs';
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
 * TLS client certificate authentication. Possible here only because the
 * application is local: the certificate files are on the same machine as the
 * process.
 */
@injectable()
export class X509Strategy implements IConnectionStrategy {
    readonly kind = ConnectionStrategyKind.X509;
    readonly displayName = 'Client certificate (X.509)';
    readonly requiresRefresh = false;

    validate(connection: SavedConnection): ConnectionValidationResult {
        const errors: ConnectionValidationError[] = [];
        const config = connection.config.x509;

        if (!config) {
            errors.push({ path: 'x509', message: 'Certificate configuration is missing.' });
            return { isValid: false, errors };
        }

        if (!config.host?.trim()) {
            errors.push({ path: 'x509.host', message: 'A host is required.' });
        }

        if (!config.certificateKeyFilePath?.trim()) {
            errors.push({ path: 'x509.certificateKeyFilePath', message: 'A certificate and key file path is required.' });
        } else if (!fs.existsSync(config.certificateKeyFilePath)) {
            errors.push({
                path: 'x509.certificateKeyFilePath',
                message: `No file exists at ${config.certificateKeyFilePath}.`,
            });
        }

        return { isValid: errors.length === 0, errors };
    }

    async buildClientOptions(connection: SavedConnection, context: ConnectionContext): Promise<BuiltClientOptions> {
        const config = connection.config.x509;

        if (!config) {
            throw new ConnectionStrategyError('Certificate configuration is missing.', true);
        }

        const options: MongoClientOptions = {
            authMechanism: 'MONGODB-X509',
            tls: true,
            tlsCertificateKeyFile: config.certificateKeyFilePath,
        };

        if (config.hasStoredPassphrase) {
            const passphrase = await context.getSecret();

            if (passphrase) {
                options.tlsCertificateKeyFilePassword = passphrase;
            }
        }

        applyTransportOptions(options, connection.config.transport);
        options.tls = true;

        return {
            uri: `mongodb://${config.host}:${config.port}`,
            options,
            defaultDatabase: config.defaultDatabase,
        };
    }
}
