/**
 * The authentication mechanism a connection uses to reach its Target Database.
 * A connection is a strategy plus a state machine, never merely a string.
 */
export enum ConnectionStrategyKind {
    /** A complete mongodb:// or mongodb+srv:// URI supplied by the user. */
    ConnectionString = 'connection-string',

    /** Host, port, and credentials assembled into a SCRAM connection. */
    Scram = 'scram',

    /** Microsoft Entra ID via MONGODB-OIDC. The reason this project exists. */
    AzureOidc = 'azure-oidc',

    /** TLS client certificate authentication. */
    X509 = 'x509',
}

/** How an Azure Entra ID access token is obtained. */
export enum AzureOidcFlow {
    /** Authorization code with PKCE, redirecting to a loopback listener. */
    AuthorizationCode = 'authorization-code',

    /** Device code flow, for when a browser redirect is unusable. */
    DeviceCode = 'device-code',

    /** Azure managed identity via the instance metadata service. */
    ManagedIdentity = 'managed-identity',

    /** Service principal client credentials, for automation. */
    ClientCredentials = 'client-credentials',

    /** Reuse a token from an existing Azure CLI login. */
    AzureCli = 'azure-cli',
}
