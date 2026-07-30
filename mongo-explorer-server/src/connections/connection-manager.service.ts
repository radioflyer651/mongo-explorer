import { injectable } from 'inversify';
import { Document, MongoClient, ObjectId } from 'mongodb';
import { Observable, Subject } from 'rxjs';
import { IConnectionStrategy, ConnectionContext, ConnectionStrategyError } from './connection-strategy';
import { LiveConnection, describeConnectionError } from './live-connection';
import { SavedConnectionDbService } from '../database/saved-connection-db.service';
import { LogDbService } from '../database/log-db.service';
import {
    ConnectionState,
    ConnectionStatus,
    InteractionPrompt,
    ServerCapabilities,
} from '../model/shared-models/connections/connection-state.model';
import { SavedConnection } from '../model/shared-models/connections/saved-connection.model';
import { errorMessage } from '../utils/misc.util';
import { redactConnectionString } from '../utils/redaction.util';

/**
 * Owns the lifecycle of every live Target Database connection: resolves the right
 * strategy, opens the client, detects capabilities, and pools the result.
 *
 * One MongoClient per logical connection, reused across requests, rather than a new
 * handshake per user action.
 */
@injectable()
export class ConnectionManager {
    constructor(
        strategies: IConnectionStrategy[],
        savedConnections: SavedConnectionDbService,
        logService: LogDbService
    ) {
        this.strategies = new Map(strategies.map(strategy => [strategy.kind, strategy]));
        this.savedConnections = savedConnections;
        this.logService = logService;
    }

    private readonly strategies: Map<string, IConnectionStrategy>;
    private readonly savedConnections: SavedConnectionDbService;
    private readonly logService: LogDbService;
    private readonly live = new Map<string, LiveConnection>();
    private readonly connecting = new Map<string, Promise<LiveConnection>>();
    private readonly abortControllers = new Map<string, AbortController>();
    private readonly statusChanges = new Subject<ConnectionStatus>();
    private readonly transientStatuses = new Map<string, ConnectionStatus>();

    /** Emits whenever any connection's status changes. */
    readonly status$: Observable<ConnectionStatus> = this.statusChanges.asObservable();

    /** Every registered strategy, for the connection editor to enumerate. */
    get availableStrategies(): IConnectionStrategy[] {
        return [...this.strategies.values()];
    }

    /** The status of every connection the manager knows about. */
    getAllStatuses(): ConnectionStatus[] {
        const statuses = [...this.live.values()].map(connection => connection.status);
        const liveIds = new Set(statuses.map(status => status.connectionId.toHexString()));

        for (const [id, status] of this.transientStatuses) {
            if (!liveIds.has(id)) {
                statuses.push(status);
            }
        }

        return statuses;
    }

    /** Returns a live connection, or undefined when it is not open. */
    tryGet(connectionId: ObjectId): LiveConnection | undefined {
        return this.live.get(connectionId.toHexString());
    }

    /**
     * Returns a usable live connection, opening one when necessary. This is the only
     * way anything above this layer obtains Target Database access.
     */
    async getConnection(connectionId: ObjectId): Promise<LiveConnection> {
        const key = connectionId.toHexString();
        const existing = this.live.get(key);

        if (existing?.isUsable) {
            return existing;
        }

        const inFlight = this.connecting.get(key);

        if (inFlight) {
            return await inFlight;
        }

        return await this.connect(connectionId);
    }

    /** Opens a connection, validating configuration before any network attempt. */
    async connect(connectionId: ObjectId): Promise<LiveConnection> {
        const key = connectionId.toHexString();
        const existing = this.live.get(key);

        if (existing?.isUsable) {
            return existing;
        }

        const attempt = this.performConnect(connectionId);
        this.connecting.set(key, attempt);

        try {
            return await attempt;
        } finally {
            this.connecting.delete(key);
        }
    }

    /** Closes a connection and forgets it. */
    async disconnect(connectionId: ObjectId): Promise<void> {
        const key = connectionId.toHexString();
        const connection = this.live.get(key);

        this.abortControllers.get(key)?.abort();
        this.abortControllers.delete(key);

        if (connection) {
            await connection.close();
            this.live.delete(key);
        }

        this.transientStatuses.delete(key);
    }

    /** Closes every connection. Called during shutdown. */
    async disconnectAll(): Promise<void> {
        const ids = [...this.live.keys()];

        for (const id of ids) {
            await this.disconnect(new ObjectId(id));
        }
    }

    /** Cancels an in-flight connection attempt. */
    cancelConnect(connectionId: ObjectId): void {
        this.abortControllers.get(connectionId.toHexString())?.abort();
    }

    /** Validates a saved connection without attempting to reach the deployment. */
    async validate(connectionId: ObjectId): Promise<{ isValid: boolean; errors: { path: string; message: string; }[]; }> {
        const saved = await this.savedConnections.getConnectionById(connectionId);

        if (!saved) {
            return { isValid: false, errors: [{ path: '_id', message: 'No such connection.' }] };
        }

        const strategy = this.strategies.get(saved.strategyKind);

        if (!strategy) {
            return { isValid: false, errors: [{ path: 'strategyKind', message: `No strategy for ${saved.strategyKind}.` }] };
        }

        return strategy.validate(saved);
    }

    /** Performs the connection sequence and records the resulting state. */
    private async performConnect(connectionId: ObjectId): Promise<LiveConnection> {
        const key = connectionId.toHexString();
        const saved = await this.savedConnections.getConnectionById(connectionId);

        if (!saved) {
            throw new ConnectionStrategyError(`No connection exists with id ${key}.`, true);
        }

        const strategy = this.strategies.get(saved.strategyKind);

        if (!strategy) {
            throw new ConnectionStrategyError(`No strategy is registered for ${saved.strategyKind}.`, true);
        }

        const validation = strategy.validate(saved);

        if (!validation.isValid) {
            const summary = validation.errors.map(error => `${error.path}: ${error.message}`).join('; ');
            this.publishTransient(connectionId, saved, ConnectionState.AuthFailed, { error: summary });
            throw new ConnectionStrategyError(summary, true);
        }

        const abortController = new AbortController();
        this.abortControllers.set(key, abortController);

        this.publishTransient(connectionId, saved, ConnectionState.Authenticating, {
            message: `Authenticating with ${strategy.displayName}.`,
        });

        const context: ConnectionContext = {
            getSecret: () => this.savedConnections.getDecryptedSecret(connectionId),
            prompt: (prompt: InteractionPrompt) => {
                this.publishTransient(connectionId, saved, ConnectionState.AwaitingUserInteraction, {
                    message: prompt.message,
                    interaction: prompt,
                });
            },
            report: (message: string) => {
                this.publishTransient(connectionId, saved, ConnectionState.Authenticating, { message });
            },
            abortSignal: abortController.signal,
        };

        try {
            const built = await strategy.buildClientOptions(saved, context);

            this.publishTransient(connectionId, saved, ConnectionState.Connecting, {
                message: `Connecting to ${redactConnectionString(built.uri)}.`,
            });

            const client = new MongoClient(built.uri, built.options);
            await client.connect();

            /* Prove the connection actually works before reporting success. */
            await client.db('admin').command({ ping: 1 });

            const connection = new LiveConnection(
                connectionId,
                saved.name,
                saved.isReadOnly,
                client,
                built.defaultDatabase,
                built.credentialExpiresAt
            );

            connection.status$.subscribe(status => this.statusChanges.next(status));
            connection.setCapabilities(await this.detectCapabilities(client));

            this.live.set(key, connection);
            this.transientStatuses.delete(key);
            this.abortControllers.delete(key);

            await this.savedConnections.recordConnected(connectionId);
            await this.logService.logMessage({
                level: 'info',
                message: `Connected to '${saved.name}'.`,
                data: { uri: redactConnectionString(built.uri) },
            });

            this.statusChanges.next(connection.status);
            return connection;
        } catch (error) {
            const description = describeConnectionError(error);

            this.publishTransient(connectionId, saved, ConnectionState.AuthFailed, { error: description });
            this.abortControllers.delete(key);

            await this.logService.logMessage({
                level: 'error',
                message: `Failed to connect to '${saved.name}'.`,
                data: { error: description },
            });

            /* The driver's message reaches the caller largely intact, minus secrets.
               Opaque connection errors are the problem this project exists to
               escape; reproducing them here would be self-defeating. */
            throw new ConnectionStrategyError(description, error instanceof ConnectionStrategyError ? error.isConfigurationProblem : false);
        }
    }

    /**
     * Probes what the deployment supports. Feature detection beats a hard-coded
     * compatibility matrix, because Cosmos vCore, Atlas, and self-hosted MongoDB
     * differ in ways that change over time.
     */
    private async detectCapabilities(client: MongoClient): Promise<ServerCapabilities> {
        const unavailable: string[] = [];
        let version = 'unknown';
        let deploymentKind: ServerCapabilities['deploymentKind'] = 'unknown';

        try {
            const buildInfo = await client.db('admin').command({ buildInfo: 1 });
            version = (buildInfo['version'] as string) ?? 'unknown';
        } catch {
            unavailable.push('buildInfo');
        }

        try {
            const hello = (await client.db('admin').command({ hello: 1 })) as Document;
            deploymentKind = this.inferDeploymentKind(client, hello, version);
        } catch {
            unavailable.push('hello');
        }

        const supportsCollStats = await this.probe(client, { collStats: '__mongo_explorer_probe__' }, unavailable, 'collStats');
        const supportsCurrentOp = await this.probe(client, { currentOp: 1 }, unavailable, 'currentOp');
        const supportsUserManagement = await this.probe(client, { usersInfo: 1 }, unavailable, 'usersInfo');

        const isCosmos = deploymentKind === 'cosmos-vcore' || deploymentKind === 'cosmos-ru';

        return {
            version,
            deploymentKind,
            supportsOut: deploymentKind !== 'cosmos-ru',
            supportsMerge: !isCosmos,
            supportsTransactions: deploymentKind !== 'cosmos-ru',
            supportsCollStats,
            supportsCurrentOp,
            supportsUserManagement,
            unavailableCommands: unavailable,
        };
    }

    /** Runs a probe command, recording the name when it is refused. */
    private async probe(client: MongoClient, command: Document, unavailable: string[], name: string): Promise<boolean> {
        try {
            await client.db('admin').command(command);
            return true;
        } catch (error) {
            /* A namespace-not-found reply still proves the command is permitted. */
            const message = errorMessage(error).toLowerCase();

            if (message.includes('not found') || message.includes('does not exist')) {
                return true;
            }

            unavailable.push(name);
            return false;
        }
    }

    /** Guesses the deployment family from the host and hello reply. */
    private inferDeploymentKind(client: MongoClient, hello: Document, version: string): ServerCapabilities['deploymentKind'] {
        const hosts = (client.options?.hosts ?? []).map(host => String(host)).join(',').toLowerCase();

        if (hosts.includes('mongocluster.cosmos.azure.com')) {
            return 'cosmos-vcore';
        }

        if (hosts.includes('documents.azure.com')) {
            return 'cosmos-ru';
        }

        if (hosts.includes('mongodb.net')) {
            return 'atlas';
        }

        if (typeof hello['$clusterTime'] === 'undefined' && version.startsWith('4.')) {
            return 'cosmos-ru';
        }

        return 'self-hosted';
    }

    /** Publishes a status for a connection that has no LiveConnection yet. */
    private publishTransient(
        connectionId: ObjectId,
        saved: SavedConnection,
        state: ConnectionState,
        detail?: { message?: string; error?: string; interaction?: InteractionPrompt; }
    ): void {
        const status: ConnectionStatus = {
            connectionId,
            connectionName: saved.name,
            state,
            message: detail?.message,
            error: detail?.error,
            pendingInteraction: detail?.interaction,
            isReadOnly: saved.isReadOnly,
        };

        this.transientStatuses.set(connectionId.toHexString(), status);
        this.statusChanges.next(status);
    }
}
