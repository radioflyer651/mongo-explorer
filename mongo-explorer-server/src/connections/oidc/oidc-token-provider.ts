import { AzureOidcConfig } from '../../model/shared-models/connections/saved-connection.model';
import { AzureOidcFlow } from '../../model/shared-models/connections/connection-strategy-kind.model';
import { ConnectionContext } from '../connection-strategy';

/** An access token acquired for a Target Database. Memory-only, never persisted. */
export interface AcquiredToken {
    /** The raw access token. */
    accessToken: string;

    /** Seconds until the token expires, as the driver's callback expects. */
    expiresInSeconds: number;

    /** Absolute expiry as an ISO-8601 string, for the connection state machine. */
    expiresAt: string;
}

/**
 * Acquires an Entra ID access token. Separated from the strategy so that the four
 * flows differ only in how the token is obtained: once a token exists, the handoff
 * to the driver is identical.
 *
 * This seam is also what makes the strategy unit-testable on a machine with no
 * Azure access at all.
 */
export interface IOidcTokenProvider {
    /** Which flow this provider implements. */
    readonly flow: AzureOidcFlow;

    /** Human-readable label for the connection interface. */
    readonly displayName: string;

    /** Whether this flow needs something from the human. */
    readonly isInteractive: boolean;

    /** Acquires a token, prompting through the context when the flow is interactive. */
    acquireToken(config: AzureOidcConfig, context: ConnectionContext): Promise<AcquiredToken>;
}

/** Raised when a token cannot be acquired. */
export class OidcTokenError extends Error {
    constructor(message: string, readonly isConfigurationProblem = false) {
        super(message);
        this.name = 'OidcTokenError';
    }
}

/** Converts an Azure SDK token result into the shape the driver expects. */
export function toAcquiredToken(token: { token: string; expiresOnTimestamp: number; }): AcquiredToken {
    const expiresAtMs = token.expiresOnTimestamp;
    const secondsRemaining = Math.max(0, Math.floor((expiresAtMs - Date.now()) / 1000));

    return {
        accessToken: token.token,
        expiresInSeconds: secondsRemaining,
        expiresAt: new Date(expiresAtMs).toISOString(),
    };
}

/**
 * Normalises a configured token resource into the scope form the Azure SDK wants.
 *
 * TODO-Information: The correct resource for Azure Cosmos DB for MongoDB (vCore)
 * is unverified. Candidates are recorded in workspace/research/azure-vcore-oidc.md.
 * Obtain the real value from the Azure CLI or documentation on a machine with
 * cluster access rather than guessing here.
 */
export function toScope(tokenResource: string): string {
    const trimmed = tokenResource.trim();

    if (!trimmed) {
        throw new OidcTokenError(
            'No token resource is configured. The correct value for Azure vCore is unverified — see workspace/research/azure-vcore-oidc.md.',
            true
        );
    }

    return trimmed.endsWith('/.default') || trimmed.includes('://') === false
        ? trimmed
        : `${trimmed.replace(/\/$/, '')}/.default`;
}
