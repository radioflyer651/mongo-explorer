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
import { AzureOidcFlow, ConnectionStrategyKind } from '../../model/shared-models/connections/connection-strategy-kind.model';
import { AzureOidcConfig, SavedConnection } from '../../model/shared-models/connections/saved-connection.model';
import { AcquiredToken, IOidcTokenProvider } from '../oidc/oidc-token-provider';

/**
 * Microsoft Entra ID authentication over MONGODB-OIDC. The reason this project
 * exists: Compass cannot do this against Azure Cosmos DB for MongoDB (vCore) in
 * our environment.
 *
 * Nothing in this file has been verified against a real cluster — see
 * workspace/research/azure-vcore-oidc.md. The code path is complete; two
 * configuration values are unknown and are deliberately not guessed:
 *   1. The token resource (audience) the cluster expects.
 *   2. Whether the cluster requires a principal name as the connection user.
 */
@injectable()
export class AzureOidcStrategy implements IConnectionStrategy {
    constructor(tokenProviders: IOidcTokenProvider[]) {
        this.tokenProviders = new Map(tokenProviders.map(provider => [provider.flow, provider]));
    }

    private readonly tokenProviders: Map<string, IOidcTokenProvider>;

    readonly kind = ConnectionStrategyKind.AzureOidc;
    readonly displayName = 'Microsoft Entra ID (OIDC)';
    readonly requiresRefresh = true;

    /**
     * Default host allow-list pattern for Azure Cosmos DB vCore.
     *
     * The driver enforces ALLOWED_HOSTS for human OIDC flows, and its default
     * covers only MongoDB's own domains. An Azure vCore host is not among them,
     * which is the leading hypothesis for why OIDC fails there — so this is always
     * set explicitly and never left to the default.
     */
    static readonly defaultAllowedHosts: readonly string[] = [
        '*.mongocluster.cosmos.azure.com',
        '*.documents.azure.com',
    ];

    /** Flows whose credential type is registered under an Entra app registration. */
    private static readonly flowsNeedingClientId: readonly AzureOidcFlow[] = [
        AzureOidcFlow.AuthorizationCode,
        AzureOidcFlow.DeviceCode,
        AzureOidcFlow.ClientCredentials,
    ];

    validate(connection: SavedConnection): ConnectionValidationResult {
        const errors: ConnectionValidationError[] = [];
        const config = connection.config.azureOidc;

        if (!config) {
            errors.push({ path: 'azureOidc', message: 'Entra ID configuration is missing.' });
            return { isValid: false, errors };
        }

        if (!config.host?.trim()) {
            errors.push({ path: 'azureOidc.host', message: 'A cluster host is required.' });
        }

        if (!config.tenantId?.trim()) {
            errors.push({ path: 'azureOidc.tenantId', message: 'A directory (tenant) id is required.' });
        }

        if (!config.clientId?.trim() && AzureOidcStrategy.flowsNeedingClientId.includes(config.flow)) {
            errors.push({
                path: 'azureOidc.clientId',
                message: 'An application (client) id is required for this sign-in method.',
            });
        }

        if (!config.tokenResource?.trim()) {
            errors.push({
                path: 'azureOidc.tokenResource',
                message: 'A token resource is required. The correct value for Azure vCore is unverified — see the research notes.',
            });
        }

        if (!config.allowedHosts?.length) {
            errors.push({
                path: 'azureOidc.allowedHosts',
                message: 'At least one allowed host is required. The driver default excludes Azure hosts.',
            });
        }

        if (!this.tokenProviders.has(config.flow)) {
            errors.push({ path: 'azureOidc.flow', message: `No token provider is registered for the ${config.flow} flow.` });
        }

        return { isValid: errors.length === 0, errors };
    }

    async buildClientOptions(connection: SavedConnection, context: ConnectionContext): Promise<BuiltClientOptions> {
        const config = connection.config.azureOidc;

        if (!config) {
            throw new ConnectionStrategyError('Entra ID configuration is missing.', true);
        }

        const provider = this.tokenProviders.get(config.flow);

        if (!provider) {
            throw new ConnectionStrategyError(`No token provider is registered for the ${config.flow} flow.`, true);
        }

        /* Acquire once up front so a configuration problem surfaces before the
           driver handshake, where the error would be far more opaque. */
        context.report(`Acquiring an Entra ID token using ${provider.displayName}.`);
        const initialToken = await provider.acquireToken(config, context);

        /* The driver runs an entirely different SASL conversation depending on which
           of these two keys is set: OIDC_HUMAN_CALLBACK negotiates a two-step
           exchange (an empty first saslStart requesting IdP metadata from the
           server, then the JWT on the second step), while OIDC_CALLBACK sends the
           JWT immediately on the first message. A non-interactive credential type
           (Azure CLI, managed identity, client secret) has no IdP metadata
           round-trip to negotiate, and a server that only implements the one-step
           form will reject the empty first message — surfacing as a server-side
           "JWT missing" error that has nothing to do with the token itself. */
        const callbackKey = provider.isInteractive ? 'OIDC_HUMAN_CALLBACK' : 'OIDC_CALLBACK';

        const options: MongoClientOptions = {
            authMechanism: 'MONGODB-OIDC',
            authMechanismProperties: {
                /* Set explicitly. The driver's default allow-list covers only
                   MongoDB's own domains, which would refuse an Azure host before
                   a token is even requested. */
                ALLOWED_HOSTS: [...(config.allowedHosts ?? AzureOidcStrategy.defaultAllowedHosts)],

                /* We bring our own token acquisition rather than relying on the
                   driver's built-in Azure environment, which targets workload
                   identity rather than a human signing in. */
                [callbackKey]: this.createCallback(config, context, provider, initialToken),
            } as MongoClientOptions['authMechanismProperties'],
        };

        if (config.principalName) {
            options.auth = { username: config.principalName, password: '' };
        }

        applyTransportOptions(options, connection.config.transport);
        options.tls = connection.config.transport?.useTls ?? true;

        /* Azure Cosmos DB for MongoDB (vCore) is addressed via SRV records and has
           no fixed port — the connection string Azure's own portal generates is
           mongodb+srv://<host>/, never mongodb://<host>:<port>. Only build the
           direct, ported form when a port was explicitly configured. */
        const uri = config.port ? `mongodb://${config.host}:${config.port}` : `mongodb+srv://${config.host}`;

        return {
            uri,
            options,
            defaultDatabase: config.defaultDatabase,
            credentialExpiresAt: initialToken.expiresAt,
        };
    }

    /**
     * Builds the driver's OIDC callback. The driver re-invokes it whenever it needs
     * a fresh token, so the first call returns the token already acquired and later
     * calls go back to the provider — whose own cache makes that cheap.
     */
    private createCallback(
        config: AzureOidcConfig,
        context: ConnectionContext,
        provider: IOidcTokenProvider,
        initialToken: AcquiredToken
    ): unknown {
        let pending: AcquiredToken | undefined = initialToken;

        return async () => {
            if (pending) {
                const token = pending;
                pending = undefined;
                return { accessToken: token.accessToken, expiresInSeconds: token.expiresInSeconds };
            }

            const refreshed = await provider.acquireToken(config, context);
            return { accessToken: refreshed.accessToken, expiresInSeconds: refreshed.expiresInSeconds };
        };
    }
}
