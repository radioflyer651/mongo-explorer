# app-config.json

Configuration for the Mongo Explorer server. **Gitignored** — it holds secrets.

Every leaf can be overridden by an environment variable. Environment wins over the file.

---

## serverConfig

| Key | Type | Env var | Notes |
|---|---|---|---|
| `port` | number | `MONGO_EXPLORER_PORT` | Default `27050`. |
| `bindAddress` | string | `MONGO_EXPLORER_BIND_ADDRESS` | **Default `127.0.0.1`. Do not change this.** Mongo Explorer is single-user and must not be reachable from the network. Binding `0.0.0.0` exposes every saved connection to anything that can reach the host, and the MCP endpoint has no auth precisely because it is loopback-only. |

## mongo — the **Application Database**

Mongo Explorer's own storage: users, saved connections, saved pipelines, preferences, logs.
**This is not a database the user browses.** Target Databases are configured at runtime through the
connection interface, never here.

| Key | Type | Env var |
|---|---|---|
| `connectionString` | string | `MONGO_EXPLORER_MONGO_CONNECTION` |
| `databaseName` | string | `MONGO_EXPLORER_MONGO_DATABASE` |

```json
"mongo": {
    "connectionString": "mongodb://mongo.example.com:27017",
    "databaseName": "mongo-explorer"
}
```

## auth

Application authentication only — "who is using Mongo Explorer". Entirely separate from Target
Database authentication.

| Key | Type | Env var | Notes |
|---|---|---|---|
| `jwtSecret` | string | `MONGO_EXPLORER_JWT_SECRET` | Signs the application token. |
| `tokenExpiry` | string | `MONGO_EXPLORER_TOKEN_EXPIRY` | jsonwebtoken duration, e.g. `30d`. |
| `secretEncryptionKey` | string | `MONGO_EXPLORER_SECRET_KEY` | **Required.** AES-256-GCM key material for encrypting stored connection secrets at rest. Change this and existing saved passwords become unreadable. |
| `requireLogin` | boolean | `MONGO_EXPLORER_REQUIRE_LOGIN` | Default `false`. A password gate on a loopback-only single-user tool is friction charging rent for security it doesn't provide. Turn it on if you share the machine. |

`secretEncryptionKey` matters even though the application is single-user: the threat is anything that
can read the file — a backup sync, another process, a shared machine — none of which care how many
users there are.

## limits

Applied to **every** Target Database operation. The client cannot exceed them.

| Key | Type | Env var | Default | Notes |
|---|---|---|---|---|
| `maxPageSize` | number | `MONGO_EXPLORER_MAX_PAGE_SIZE` | 1000 | Hard ceiling on documents per page. |
| `defaultPageSize` | number | `MONGO_EXPLORER_DEFAULT_PAGE_SIZE` | 50 | |
| `maxTimeMs` | number | `MONGO_EXPLORER_MAX_TIME_MS` | 60000 | Hard ceiling on any operation's time budget. |
| `defaultTimeMs` | number | `MONGO_EXPLORER_DEFAULT_TIME_MS` | 15000 | |
| `schemaSampleSize` | number | `MONGO_EXPLORER_SCHEMA_SAMPLE_SIZE` | 200 | Documents sampled to infer shape. |
| `pipelinePreviewSize` | number | `MONGO_EXPLORER_PIPELINE_PREVIEW_SIZE` | 100 | Default aggregation preview sample. |
| `maxUndoSnapshotDocuments` | number | `MONGO_EXPLORER_MAX_UNDO_SNAPSHOT` | 1000 | Largest affected count for which an undo snapshot is captured before applying a proposal. Above this, the confirmation tells the user the change is irreversible. |

Raising `maxPageSize` or `maxTimeMs` is how you make the tool hang against a large collection. They
exist to protect both the target cluster and this process.

## mcp

| Key | Type | Env var | Default | Notes |
|---|---|---|---|---|
| `enabled` | boolean | `MONGO_EXPLORER_MCP_ENABLED` | `true` | Set `false` to not mount the MCP endpoint at all. |
| `path` | string | `MONGO_EXPLORER_MCP_PATH` | `/mcp` | Streamable HTTP transport path. |
| `defaultMode` | string | `MONGO_EXPLORER_MCP_MODE` | `collaborate` | `off`, `observe`, or `collaborate`. A mode persisted in the Application Database wins over this once one has been stored. |
| `activityLogLimit` | number | `MONGO_EXPLORER_ACTIVITY_LOG_LIMIT` | 500 | Attribution log entries retained in memory. |

**No mode permits an AI to execute a Target Database write.** That is not configurable — it is the
absence of a code path, enforced by `assertUserActor` below the routes and below the MCP server.

## corsAllowed

Origins permitted by CORS. Exactly the local client, never a wildcard.

```json
"corsAllowed": ["http://localhost:27100", "http://127.0.0.1:27100"]
```

---

## First-run checklist

1. Replace `<your-jwt-secret>` and `<your-secret-encryption-key>` with real values.
2. Confirm the Application Database at `mongo.example.com:27017` is reachable, or point
   `mongo.connectionString` at a local instance.
3. Leave `bindAddress` as `127.0.0.1`.
4. `npm start`.
