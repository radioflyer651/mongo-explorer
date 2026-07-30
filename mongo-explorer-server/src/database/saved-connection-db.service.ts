import { injectable } from 'inversify';
import { ObjectId } from 'mongodb';
import { DbService } from './db-service';
import { MongoHelper } from '../mongo-helper';
import { SecretCipher } from '../utils/secret-cipher';
import { DbCollectionNames } from '../model/db-collection-names.constants';
import {
    ConnectionConfig,
    SaveConnectionRequest,
    SavedConnection,
    SavedConnectionListing,
} from '../model/shared-models/connections/saved-connection.model';
import { ConnectionStrategyKind } from '../model/shared-models/connections/connection-strategy-kind.model';
import { nowIso } from '../utils/misc.util';

/**
 * Storage for Target Database connections. Secrets are encrypted at rest and never
 * leave this service in readable form except to a connection strategy.
 *
 * There is no user scoping: the application is single-user and loopback-only, so
 * ownership columns would be ceremony.
 */
@injectable()
export class SavedConnectionDbService extends DbService {
    constructor(dbHelper: MongoHelper, cipher: SecretCipher, applicationDatabaseHost: string, applicationDatabaseName: string) {
        super(dbHelper);
        this.cipher = cipher;
        this.applicationDatabaseHost = applicationDatabaseHost;
        this.applicationDatabaseName = applicationDatabaseName;
    }

    private readonly cipher: SecretCipher;
    private readonly applicationDatabaseHost: string;
    private readonly applicationDatabaseName: string;

    /** Returns every connection in redacted listing form. */
    async getConnectionListings(): Promise<SavedConnectionListing[]> {
        const connections = await this.dbHelper.findDataItem<SavedConnection>(
            DbCollectionNames.SavedConnections,
            {},
            { sort: { name: 1 } }
        );

        return connections.map(connection => this.toListing(connection as SavedConnection));
    }

    /** Returns one connection with its secret still encrypted. */
    async getConnectionById(connectionId: ObjectId): Promise<SavedConnection | undefined> {
        const found = await this.dbHelper.findDataItem<SavedConnection>(
            DbCollectionNames.SavedConnections,
            { _id: connectionId },
            { findOne: true }
        );

        return found as SavedConnection | undefined;
    }

    /**
     * Returns the decrypted secret for a connection, for use by a strategy only.
     * Never call this from a route handler.
     */
    async getDecryptedSecret(connectionId: ObjectId): Promise<string | undefined> {
        const stored = await this.dbHelper.findDataItem<SavedConnection & { encryptedSecret?: string; }>(
            DbCollectionNames.SavedConnections,
            { _id: connectionId },
            { findOne: true }
        );

        const encrypted = (stored as { encryptedSecret?: string; } | undefined)?.encryptedSecret;

        if (!encrypted) {
            return undefined;
        }

        return this.cipher.decrypt(encrypted);
    }

    /** Creates or updates a connection, encrypting any supplied secret. */
    async saveConnection(request: SaveConnectionRequest): Promise<SavedConnectionListing> {
        const existing = request._id ? await this.getConnectionById(request._id) : undefined;

        const record: SavedConnection & { encryptedSecret?: string; } = {
            _id: request._id ?? new ObjectId(),
            name: request.name,
            strategyKind: request.strategyKind,
            isReadOnly: request.isReadOnly,
            notes: request.notes,
            colorTag: request.colorTag,
            config: this.applyStoredSecretFlags(request),
            createdAt: existing?.createdAt ?? nowIso(),
            lastConnectedAt: existing?.lastConnectedAt,
        };

        if (request.secret !== undefined) {
            record.encryptedSecret = request.secret === '' ? undefined : this.cipher.encrypt(request.secret);
        } else if (existing) {
            const previous = await this.dbHelper.findDataItem<{ _id: ObjectId; encryptedSecret?: string; }>(
                DbCollectionNames.SavedConnections,
                { _id: existing._id },
                { findOne: true }
            );
            record.encryptedSecret = (previous as { encryptedSecret?: string; } | undefined)?.encryptedSecret;
        }

        await this.dbHelper.upsertDataItem(DbCollectionNames.SavedConnections, record);
        return this.toListing(record);
    }

    /** Deletes a connection. */
    async deleteConnection(connectionId: ObjectId): Promise<boolean> {
        const removed = await this.dbHelper.deleteDataItems<SavedConnection>(
            DbCollectionNames.SavedConnections,
            { _id: connectionId }
        );

        return removed > 0;
    }

    /** Records that a connection opened successfully. */
    async recordConnected(connectionId: ObjectId): Promise<void> {
        await this.dbHelper.updateDataItems<SavedConnection>(
            DbCollectionNames.SavedConnections,
            { _id: connectionId },
            { $set: { lastConnectedAt: nowIso() } }
        );
    }

    /** Sets the read-only guard rail. */
    async setReadOnly(connectionId: ObjectId, isReadOnly: boolean): Promise<void> {
        await this.dbHelper.updateDataItems<SavedConnection>(
            DbCollectionNames.SavedConnections,
            { _id: connectionId },
            { $set: { isReadOnly } }
        );
    }

    /**
     * Produces the redacted client-facing form. Secrets are absent by
     * construction: this builder never receives them.
     */
    private toListing(connection: SavedConnection): SavedConnectionListing {
        return {
            _id: connection._id,
            name: connection.name,
            strategyKind: connection.strategyKind,
            isReadOnly: connection.isReadOnly,
            endpointSummary: this.describeEndpoint(connection),
            notes: connection.notes,
            colorTag: connection.colorTag,
            lastConnectedAt: connection.lastConnectedAt,
            isApplicationDatabase: this.pointsAtApplicationDatabase(connection),
        };
    }

    /** Builds a display summary of where a connection points. */
    private describeEndpoint(connection: SavedConnection): string {
        const config = connection.config;

        switch (connection.strategyKind) {
            case ConnectionStrategyKind.ConnectionString: {
                const uri = config.connectionString?.uri ?? '';
                const match = /\/\/(?:[^@]*@)?([^/?]+)/.exec(uri);
                return match ? match[1] : 'connection string';
            }
            case ConnectionStrategyKind.Scram:
                return `${config.scram?.host ?? '?'}:${config.scram?.port ?? 27017}`;
            case ConnectionStrategyKind.AzureOidc:
                return `${config.azureOidc?.host ?? '?'}:${config.azureOidc?.port ?? 10255}`;
            case ConnectionStrategyKind.X509:
                return `${config.x509?.host ?? '?'}:${config.x509?.port ?? 27017}`;
            default:
                return 'unknown';
        }
    }

    /**
     * True when this connection points at the Application Database itself. The
     * code path is unchanged — it goes through LiveConnection like any other
     * Target Database — but the interface warns the user.
     */
    private pointsAtApplicationDatabase(connection: SavedConnection): boolean {
        const endpoint = this.describeEndpoint(connection).toLowerCase();
        const host = this.applicationDatabaseHost.toLowerCase();

        if (!endpoint.includes(host)) {
            return false;
        }

        const defaultDatabase =
            connection.config.connectionString?.defaultDatabase ??
            connection.config.scram?.defaultDatabase ??
            connection.config.azureOidc?.defaultDatabase ??
            connection.config.x509?.defaultDatabase;

        return defaultDatabase === undefined || defaultDatabase === this.applicationDatabaseName;
    }

    /** Records whether a secret is stored, so the client can show the right state. */
    private applyStoredSecretFlags(request: SaveConnectionRequest): ConnectionConfig {
        const hasSecret = request.secret !== undefined && request.secret !== '';
        const config: ConnectionConfig = JSON.parse(JSON.stringify(request.config)) as ConnectionConfig;

        if (config.scram) {
            config.scram.hasStoredPassword = hasSecret || config.scram.hasStoredPassword;
        }

        if (config.azureOidc) {
            config.azureOidc.hasStoredClientSecret = hasSecret || config.azureOidc.hasStoredClientSecret;
        }

        if (config.x509) {
            config.x509.hasStoredPassphrase = hasSecret || config.x509.hasStoredPassphrase;
        }

        return config;
    }
}
