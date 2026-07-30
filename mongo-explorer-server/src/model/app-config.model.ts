/** Root shape of app-config.json. */
export interface IAppConfig {
    /** HTTP and socket server settings. */
    serverConfig: IServerConfig;

    /** Application Database connection. Never a Target Database. */
    mongo: IMongoConfig;

    /** Authentication settings for the application's own local lock. */
    auth: IAuthConfig;

    /** Limits applied to every Target Database operation. */
    limits: ILimitsConfig;

    /** Model Context Protocol server settings. */
    mcp: IMcpConfig;

    /** Origins permitted by CORS. Exactly the local client, never a wildcard. */
    corsAllowed: string[];
}

/** HTTP and socket server settings. */
export interface IServerConfig {
    /** Port to listen on. */
    port: number;

    /**
     * Interface to bind. Defaults to the loopback address: this application is
     * single-user and must not be reachable from the network.
     */
    bindAddress: string;
}

/** Application Database connection settings. */
export interface IMongoConfig {
    /** Connection string for the application's own storage. */
    connectionString: string;

    /** Database name for the application's own storage. */
    databaseName: string;
}

/** Authentication settings for the application's own local lock. */
export interface IAuthConfig {
    /** Secret used to sign the application JWT. */
    jwtSecret: string;

    /** Token lifetime, as a jsonwebtoken duration string. */
    tokenExpiry: string;

    /**
     * Key used to encrypt stored connection secrets at rest. Required even though
     * the application is single-user: the threat is anything that can read the
     * file, which does not care how many users there are.
     */
    secretEncryptionKey: string;

    /**
     * Whether a login is required. Defaults to false — a password gate on a
     * loopback-only single-user tool charges friction for security it does not
     * provide.
     */
    requireLogin: boolean;
}

/** Limits applied to every Target Database operation. */
export interface ILimitsConfig {
    /** Hard ceiling on documents returned by a single query page. */
    maxPageSize: number;

    /** Default page size when the client does not specify one. */
    defaultPageSize: number;

    /** Hard ceiling on any operation's time budget, in milliseconds. */
    maxTimeMs: number;

    /** Default time budget when the client does not specify one. */
    defaultTimeMs: number;

    /** Documents sampled when inferring a collection's shape. */
    schemaSampleSize: number;

    /** Default sample size for aggregation previews. */
    pipelinePreviewSize: number;

    /**
     * Largest affected-document count for which an undo snapshot is captured
     * before applying a proposal.
     */
    maxUndoSnapshotDocuments: number;
}

/** Model Context Protocol server settings. */
export interface IMcpConfig {
    /** Whether the MCP endpoint is mounted at all. */
    enabled: boolean;

    /** Path the streamable HTTP transport is served from. */
    path: string;

    /**
     * Mode to start in. Persisted mode from the Application Database wins once
     * one has been stored.
     */
    defaultMode: string;

    /** How many activity log entries to retain in memory. */
    activityLogLimit: number;
}
