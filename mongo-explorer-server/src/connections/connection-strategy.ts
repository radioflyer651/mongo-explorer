import { MongoClientOptions } from 'mongodb';
import { SavedConnection } from '../model/shared-models/connections/saved-connection.model';
import { ConnectionStrategyKind } from '../model/shared-models/connections/connection-strategy-kind.model';
import { InteractionPrompt } from '../model/shared-models/connections/connection-state.model';

/**
 * Turns saved connection configuration into a usable driver connection.
 *
 * A connection is a strategy plus a state machine, never merely a string. That is
 * the precise reason Compass fails against Azure vCore: its model has nowhere to
 * put an interactive, expiring credential.
 */
export interface IConnectionStrategy {
    /** Discriminator matching SavedConnection.strategyKind. */
    readonly kind: ConnectionStrategyKind;

    /** Human-readable label for the connection interface. */
    readonly displayName: string;

    /** Whether this strategy's credentials expire and need refreshing. */
    readonly requiresRefresh: boolean;

    /** Validates configuration before any network attempt is made. */
    validate(connection: SavedConnection): ConnectionValidationResult;

    /** Produces the URI and driver options needed to connect. May acquire tokens. */
    buildClientOptions(connection: SavedConnection, context: ConnectionContext): Promise<BuiltClientOptions>;
}

/** Outcome of validating a connection's configuration. */
export interface ConnectionValidationResult {
    /** Whether the configuration is usable. */
    isValid: boolean;

    /** Field-level problems, keyed by a dotted config path. */
    errors: ConnectionValidationError[];
}

/** One problem found while validating a connection. */
export interface ConnectionValidationError {
    /** Dotted path into the configuration, for example 'azureOidc.tenantId'. */
    path: string;

    /** Plain-language description of the problem. */
    message: string;
}

/** What a strategy produces: everything the driver needs, and nothing more. */
export interface BuiltClientOptions {
    /** Connection URI. Already assembled, credentials included where applicable. */
    uri: string;

    /** Driver options, including any OIDC callbacks. */
    options: MongoClientOptions;

    /** Database to open by default, when the configuration names one. */
    defaultDatabase?: string;

    /**
     * When the credential expires, as an ISO-8601 string. Drives the
     * CredentialExpiring state so the interface can warn before an operation
     * fails rather than after.
     */
    credentialExpiresAt?: string;
}

/**
 * Everything a strategy needs from its surroundings, including a channel for
 * interactive prompts. Interactive authentication is the main path here, not an
 * edge case, so the contract supports "the strategy needs to tell the human
 * something mid-connect" from the start rather than by retrofit.
 */
export interface ConnectionContext {
    /** Retrieves the connection's decrypted secret, when one is stored. */
    getSecret(): Promise<string | undefined>;

    /** Surfaces a prompt to the human and resolves when it is dismissed or met. */
    prompt(prompt: InteractionPrompt): void;

    /** Reports progress text for display while connecting. */
    report(message: string): void;

    /** Aborts when the user cancels the attempt. */
    readonly abortSignal: AbortSignal;
}

/** Raised when a strategy cannot produce usable options. */
export class ConnectionStrategyError extends Error {
    constructor(message: string, readonly isConfigurationProblem = false) {
        super(message);
        this.name = 'ConnectionStrategyError';
    }
}
