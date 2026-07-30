import fs from 'fs';
import path from 'path';
import { IAppConfig } from './model/app-config.model';

/** Maps configuration leaves to the environment variables that override them. */
const ConfigToEnvMap = {
    serverConfig: {
        port: 'MONGO_EXPLORER_PORT',
        bindAddress: 'MONGO_EXPLORER_BIND_ADDRESS',
    },
    mongo: {
        connectionString: 'MONGO_EXPLORER_MONGO_CONNECTION',
        databaseName: 'MONGO_EXPLORER_MONGO_DATABASE',
    },
    auth: {
        jwtSecret: 'MONGO_EXPLORER_JWT_SECRET',
        tokenExpiry: 'MONGO_EXPLORER_TOKEN_EXPIRY',
        secretEncryptionKey: 'MONGO_EXPLORER_SECRET_KEY',
        requireLogin: 'MONGO_EXPLORER_REQUIRE_LOGIN',
    },
    limits: {
        maxPageSize: 'MONGO_EXPLORER_MAX_PAGE_SIZE',
        defaultPageSize: 'MONGO_EXPLORER_DEFAULT_PAGE_SIZE',
        maxTimeMs: 'MONGO_EXPLORER_MAX_TIME_MS',
        defaultTimeMs: 'MONGO_EXPLORER_DEFAULT_TIME_MS',
        schemaSampleSize: 'MONGO_EXPLORER_SCHEMA_SAMPLE_SIZE',
        pipelinePreviewSize: 'MONGO_EXPLORER_PIPELINE_PREVIEW_SIZE',
        maxUndoSnapshotDocuments: 'MONGO_EXPLORER_MAX_UNDO_SNAPSHOT',
    },
    mcp: {
        enabled: 'MONGO_EXPLORER_MCP_ENABLED',
        path: 'MONGO_EXPLORER_MCP_PATH',
        defaultMode: 'MONGO_EXPLORER_MCP_MODE',
        activityLogLimit: 'MONGO_EXPLORER_ACTIVITY_LOG_LIMIT',
    },
};

/** Defaults used when app-config.json is absent, so a fresh clone can start. */
const defaultConfig: IAppConfig = {
    serverConfig: {
        port: 2701,
        bindAddress: '127.0.0.1',
    },
    mongo: {
        connectionString: 'mongodb://mongo.fingercraft.com:27017',
        databaseName: 'mongo-explorer',
    },
    auth: {
        jwtSecret: 'change-me-local-development-only',
        tokenExpiry: '30d',
        secretEncryptionKey: 'change-me-local-development-only',
        requireLogin: false,
    },
    limits: {
        maxPageSize: 1000,
        defaultPageSize: 50,
        maxTimeMs: 60_000,
        defaultTimeMs: 15_000,
        schemaSampleSize: 200,
        pipelinePreviewSize: 100,
        maxUndoSnapshotDocuments: 1000,
    },
    mcp: {
        enabled: true,
        path: '/mcp',
        defaultMode: 'collaborate',
        activityLogLimit: 500,
    },
    corsAllowed: ['http://localhost:27100', 'http://127.0.0.1:27100'],
};

let cachedConfig: IAppConfig | undefined;

/** Project root, one level above dist/ or src/. */
export function getProjectRoot(): string {
    return path.resolve(__dirname, '..');
}

/**
 * Loads app-config.json once, caches it, then overrides each leaf with its
 * matching environment variable when one is set.
 */
export async function getAppConfig(): Promise<IAppConfig> {
    if (cachedConfig) {
        return cachedConfig;
    }

    const configPath = path.join(getProjectRoot(), 'app-config.json');
    let loaded: IAppConfig = defaultConfig;

    if (fs.existsSync(configPath)) {
        const raw = await fs.promises.readFile(configPath, 'utf-8');
        loaded = mergeDeep(defaultConfig, JSON.parse(raw) as Partial<IAppConfig>);
    } else {
        console.warn(`app-config.json not found at ${configPath}; using built-in defaults.`);
    }

    applyEnvironmentOverrides(loaded as unknown as Record<string, unknown>, ConfigToEnvMap);
    resolveRelativePaths(loaded as unknown as Record<string, unknown>, getProjectRoot());

    cachedConfig = loaded;
    return cachedConfig;
}

/** Clears the cache. Used by tests only. */
export function resetAppConfigCache(): void {
    cachedConfig = undefined;
}

/** Recursively merges a partial override over a base object. */
function mergeDeep<T>(base: T, override: Partial<T>): T {
    const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };

    for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
        const existing = result[key];

        if (isPlainObject(value) && isPlainObject(existing)) {
            result[key] = mergeDeep(existing, value);
        } else if (value !== undefined) {
            result[key] = value;
        }
    }

    return result as T;
}

/** Walks the env map and overrides matching configuration leaves. */
function applyEnvironmentOverrides(target: Record<string, unknown>, map: Record<string, unknown>): void {
    for (const [key, mapped] of Object.entries(map)) {
        if (isPlainObject(mapped)) {
            const child = target[key];
            if (isPlainObject(child)) {
                applyEnvironmentOverrides(child, mapped);
            }
            continue;
        }

        const envValue = process.env[mapped as string];
        if (envValue === undefined) {
            continue;
        }

        target[key] = coerceToTypeOf(target[key], envValue);
    }
}

/** Converts an environment string to the type the existing default carries. */
function coerceToTypeOf(existing: unknown, raw: string): unknown {
    if (typeof existing === 'number') {
        return parseInt(raw, 10);
    }

    if (typeof existing === 'boolean') {
        return raw.toLowerCase() === 'true';
    }

    if (Array.isArray(existing)) {
        return raw.split(',').map(part => part.trim());
    }

    return raw;
}

/** Converts relative path values into absolute paths anchored at the root. */
function resolveRelativePaths(target: Record<string, unknown>, root: string): void {
    for (const [key, value] of Object.entries(target)) {
        if (isPlainObject(value)) {
            resolveRelativePaths(value, root);
            continue;
        }

        if (typeof value === 'string' && (value.startsWith('./') || value.startsWith('../'))) {
            target[key] = path.resolve(root, value);
        }
    }
}

/** True when the value is a non-array object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
