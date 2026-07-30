import { injectable } from 'inversify';
import {
    AzureCliCredential,
    ClientSecretCredential,
    DeviceCodeCredential,
    InteractiveBrowserCredential,
    ManagedIdentityCredential,
    TokenCredential,
} from '@azure/identity';
import { AzureOidcFlow } from '../../model/shared-models/connections/connection-strategy-kind.model';
import { AzureOidcConfig } from '../../model/shared-models/connections/saved-connection.model';
import { ConnectionContext } from '../connection-strategy';
import { AcquiredToken, IOidcTokenProvider, OidcTokenError, toAcquiredToken, toScope } from './oidc-token-provider';
import { errorMessage } from '../../utils/misc.util';

/** Shared token acquisition against an Azure SDK credential. */
async function acquire(credential: TokenCredential, scope: string, context: ConnectionContext): Promise<AcquiredToken> {
    try {
        const token = await credential.getToken(scope, { abortSignal: context.abortSignal });

        if (!token) {
            throw new OidcTokenError('Azure returned no token for the configured resource.');
        }

        return toAcquiredToken(token);
    } catch (error) {
        throw new OidcTokenError(`Token acquisition failed: ${errorMessage(error)}`);
    }
}

/**
 * Authorization code with PKCE, redirecting to a loopback listener.
 *
 * The default flow: because this application is local-only, the server can bind a
 * loopback redirect and open the system browser. That makes this both the best
 * experience available and easier here than it would be in a hosted application.
 */
@injectable()
export class AuthorizationCodeTokenProvider implements IOidcTokenProvider {
    readonly flow = AzureOidcFlow.AuthorizationCode;
    readonly displayName = 'Sign in with a browser';
    readonly isInteractive = true;

    async acquireToken(config: AzureOidcConfig, context: ConnectionContext): Promise<AcquiredToken> {
        const scope = toScope(config.tokenResource);

        context.report('Opening a browser to sign in to Microsoft Entra ID.');
        context.prompt({
            kind: 'notice',
            message: 'A browser window has been opened. Complete the sign-in there.',
        });

        const credential = new InteractiveBrowserCredential({
            tenantId: config.tenantId,
            clientId: config.clientId,
            redirectUri: 'http://localhost:2702/oauth/callback',
        });

        return await acquire(credential, scope, context);
    }
}

/** Device code flow, for when a browser redirect is unusable. */
@injectable()
export class DeviceCodeTokenProvider implements IOidcTokenProvider {
    readonly flow = AzureOidcFlow.DeviceCode;
    readonly displayName = 'Sign in with a device code';
    readonly isInteractive = true;

    async acquireToken(config: AzureOidcConfig, context: ConnectionContext): Promise<AcquiredToken> {
        const scope = toScope(config.tokenResource);

        const credential = new DeviceCodeCredential({
            tenantId: config.tenantId,
            clientId: config.clientId,
            userPromptCallback: info => {
                context.prompt({
                    kind: 'device-code',
                    message: info.message,
                    url: info.verificationUri,
                    userCode: info.userCode,
                });
            },
        });

        return await acquire(credential, scope, context);
    }
}

/** Azure managed identity, for when the application runs inside Azure. */
@injectable()
export class ManagedIdentityTokenProvider implements IOidcTokenProvider {
    readonly flow = AzureOidcFlow.ManagedIdentity;
    readonly displayName = 'Managed identity';
    readonly isInteractive = false;

    async acquireToken(config: AzureOidcConfig, context: ConnectionContext): Promise<AcquiredToken> {
        const scope = toScope(config.tokenResource);

        const credential = config.managedIdentityClientId
            ? new ManagedIdentityCredential({ clientId: config.managedIdentityClientId })
            : new ManagedIdentityCredential();

        context.report('Requesting a token from the instance metadata service.');
        return await acquire(credential, scope, context);
    }
}

/** Service principal client credentials, for automation. */
@injectable()
export class ClientCredentialsTokenProvider implements IOidcTokenProvider {
    readonly flow = AzureOidcFlow.ClientCredentials;
    readonly displayName = 'Service principal';
    readonly isInteractive = false;

    async acquireToken(config: AzureOidcConfig, context: ConnectionContext): Promise<AcquiredToken> {
        const scope = toScope(config.tokenResource);
        const clientSecret = await context.getSecret();

        if (!clientSecret) {
            throw new OidcTokenError('No client secret is stored for this connection.', true);
        }

        const credential = new ClientSecretCredential(config.tenantId, config.clientId, clientSecret);
        return await acquire(credential, scope, context);
    }
}

/**
 * Reuses a token from an existing Azure CLI login.
 *
 * Worth trying first on the work machine: if an `az login` session is already
 * present, this removes the interactive step entirely.
 */
@injectable()
export class AzureCliTokenProvider implements IOidcTokenProvider {
    readonly flow = AzureOidcFlow.AzureCli;
    readonly displayName = 'Existing Azure CLI login';
    readonly isInteractive = false;

    async acquireToken(config: AzureOidcConfig, context: ConnectionContext): Promise<AcquiredToken> {
        const scope = toScope(config.tokenResource);

        context.report('Reusing the token cache from the Azure CLI.');
        const credential = new AzureCliCredential({ tenantId: config.tenantId });

        return await acquire(credential, scope, context);
    }
}

/**
 * Returns a fixed token without contacting Azure. Exists so the OIDC strategy and
 * the connection state machine are testable on a machine with no Azure access.
 */
export class FakeTokenProvider implements IOidcTokenProvider {
    constructor(private readonly token = 'fake-access-token', private readonly lifetimeSeconds = 3600) { }

    readonly flow = AzureOidcFlow.AzureCli;
    readonly displayName = 'Fake provider (tests only)';
    readonly isInteractive = false;

    async acquireToken(): Promise<AcquiredToken> {
        const expiresAtMs = Date.now() + this.lifetimeSeconds * 1000;

        return {
            accessToken: this.token,
            expiresInSeconds: this.lifetimeSeconds,
            expiresAt: new Date(expiresAtMs).toISOString(),
        };
    }
}
