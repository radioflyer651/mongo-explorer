import { Db, Document, MongoClient } from 'mongodb';
import { ObjectId } from 'mongodb';
import { Observable, Subject } from 'rxjs';
import {
    ConnectionState,
    ConnectionStatus,
    InteractionPrompt,
    ServerCapabilities,
} from '../model/shared-models/connections/connection-state.model';
import { errorMessage, nowIso } from '../utils/misc.util';
import { redactText } from '../utils/redaction.util';

/**
 * A connected, pooled, named session against one Target Database deployment.
 *
 * Everything above this class depends only on this class: no explorer service ever
 * sees a connection string or a credential. That single constraint is what keeps
 * the OIDC path from leaking into forty files.
 */
export class LiveConnection {
    constructor(
        readonly connectionId: ObjectId,
        readonly connectionName: string,
        readonly isReadOnly: boolean,
        private readonly client: MongoClient,
        readonly defaultDatabase: string | undefined,
        credentialExpiresAt: string | undefined
    ) {
        this.credentialExpiresAt = credentialExpiresAt;
        this.currentState = ConnectionState.Connected;
        this.watchForDrops();
        this.scheduleExpiryWarning();
    }

    private currentState: ConnectionState;
    private currentMessage?: string;
    private currentError?: string;
    private pendingInteraction?: InteractionPrompt;
    private capabilities?: ServerCapabilities;
    private credentialExpiresAt?: string;
    private expiryTimer?: NodeJS.Timeout;
    private readonly stateChanges = new Subject<ConnectionStatus>();

    /** Emits whenever the connection's status changes. */
    readonly status$: Observable<ConnectionStatus> = this.stateChanges.asObservable();

    /** Current lifecycle state. */
    get state(): ConnectionState {
        return this.currentState;
    }

    /** Whether the connection is usable for operations right now. */
    get isUsable(): boolean {
        return (
            this.currentState === ConnectionState.Connected ||
            this.currentState === ConnectionState.CredentialExpiring
        );
    }

    /** Detected server capabilities. */
    get serverCapabilities(): ServerCapabilities | undefined {
        return this.capabilities;
    }

    /** Full current status, as reported to the client. */
    get status(): ConnectionStatus {
        return {
            connectionId: this.connectionId,
            connectionName: this.connectionName,
            state: this.currentState,
            message: this.currentMessage,
            error: this.currentError,
            pendingInteraction: this.pendingInteraction,
            credentialExpiresAt: this.credentialExpiresAt,
            isReadOnly: this.isReadOnly,
            serverCapabilities: this.capabilities,
        };
    }

    /** Records the capabilities detected at connect time. */
    setCapabilities(capabilities: ServerCapabilities): void {
        this.capabilities = capabilities;
        this.emit();
    }

    /** Returns a database handle. Throws when the connection is not usable. */
    getDatabase(databaseName: string): Db {
        this.assertUsable();
        return this.client.db(databaseName);
    }

    /** Returns the admin database handle, for deployment-level commands. */
    getAdminDatabase(): Db {
        this.assertUsable();
        return this.client.db('admin');
    }

    /** Runs a command against one database. */
    async runCommand(databaseName: string, command: Document): Promise<Document> {
        this.assertUsable();
        return await this.client.db(databaseName).command(command);
    }

    /** Lists databases on the deployment. */
    async listDatabases(): Promise<Document> {
        this.assertUsable();
        return await this.client.db('admin').admin().listDatabases();
    }

    /** Moves to a new state, notifying observers. */
    transitionTo(state: ConnectionState, detail?: { message?: string; error?: string; interaction?: InteractionPrompt; }): void {
        this.currentState = state;
        this.currentMessage = detail?.message;
        this.currentError = detail?.error === undefined ? undefined : redactText(detail.error);
        this.pendingInteraction = detail?.interaction;
        this.emit();
    }

    /** Closes the connection and releases its resources. */
    async close(): Promise<void> {
        if (this.expiryTimer) {
            clearTimeout(this.expiryTimer);
            this.expiryTimer = undefined;
        }

        try {
            await this.client.close();
        } catch {
            /* Closing a broken connection is not an error worth surfacing. */
        }

        this.transitionTo(ConnectionState.Disconnected, { message: 'Disconnected.' });
        this.stateChanges.complete();
    }

    /** Throws a descriptive error when the connection cannot be used. */
    private assertUsable(): void {
        if (this.isUsable) {
            return;
        }

        throw new ConnectionNotUsableError(
            `Connection '${this.connectionName}' is ${this.currentState}${this.currentError ? `: ${this.currentError}` : '.'}`,
            this.currentState
        );
    }

    /** Publishes the current status. */
    private emit(): void {
        this.stateChanges.next(this.status);
    }

    /** Reacts to the driver losing its transport. */
    private watchForDrops(): void {
        this.client.on('serverHeartbeatFailed', () => {
            if (this.currentState === ConnectionState.Connected) {
                this.transitionTo(ConnectionState.Reconnecting, { message: 'The server stopped responding.' });
            }
        });

        this.client.on('serverHeartbeatSucceeded', () => {
            if (this.currentState === ConnectionState.Reconnecting) {
                this.transitionTo(ConnectionState.Connected, { message: 'Reconnected.' });
            }
        });
    }

    /**
     * Warns before the credential expires rather than after an operation fails.
     * The CredentialExpiring state exists precisely so the interface can do this.
     */
    private scheduleExpiryWarning(): void {
        if (!this.credentialExpiresAt) {
            return;
        }

        const expiresAtMs = Date.parse(this.credentialExpiresAt);
        const warnAtMs = expiresAtMs - 5 * 60 * 1000;
        const delayMs = warnAtMs - Date.now();

        if (Number.isNaN(delayMs) || delayMs <= 0) {
            return;
        }

        this.expiryTimer = setTimeout(() => {
            if (this.currentState === ConnectionState.Connected) {
                this.transitionTo(ConnectionState.CredentialExpiring, {
                    message: 'The credential for this connection expires shortly.',
                });
            }
        }, Math.min(delayMs, 2_147_483_000));
    }
}

/** Raised when an operation is attempted on a connection that cannot serve it. */
export class ConnectionNotUsableError extends Error {
    constructor(message: string, readonly state: ConnectionState) {
        super(message);
        this.name = 'ConnectionNotUsableError';
    }
}

/** Raised when a write is attempted through a read-only connection. */
export class ReadOnlyConnectionError extends Error {
    constructor(connectionName: string) {
        super(`Connection '${connectionName}' is marked read-only. Writes are refused server-side.`);
        this.name = 'ReadOnlyConnectionError';
    }
}

/** Builds a plain error description safe to send to a client. */
export function describeConnectionError(error: unknown): string {
    return redactText(errorMessage(error)) || `Connection failed at ${nowIso()}`;
}
