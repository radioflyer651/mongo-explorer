# CLAUDE.md — mongo-explorer-server

Node/Express backend for **Mongo Explorer**. Brokers every MongoDB connection and hosts the MCP
server.

## Stack

Node + Express 5 · TypeScript (strict) · MongoDB driver 6 · Inversify + reflect-metadata · Socket.IO ·
Zod · jsonwebtoken + bcryptjs · `@modelcontextprotocol/sdk` · `@azure/identity`

`ts-node src/index.ts` for dev, `tsc` → `node dist/index.js` for build.

## Running

**F5** in this project starts the API with a debugger attached — see
[.vscode/launch.json](.vscode/launch.json). Breakpoints work directly in `.ts` files. The workspace
file has a *server + client* compound that starts both.

```bash
npm start          # ts-node, port 2701, bound to 127.0.0.1
npm run typecheck  # tsc --noEmit
npm test           # node --test over test/
npm run check:actor-gate
```

Config: `app-config.json` (gitignored) — schema in [APP-CONFIG.md](APP-CONFIG.md). Every leaf is
env-var overridable.

**Port 2701, bound to `127.0.0.1`.** Single-user, never network-reachable. Do not change
`bindAddress` — the MCP endpoint has no auth precisely because it is loopback-only.

## ⚠ Two MongoDB contexts — read before touching anything

| | **Application Database** | **Target Database** |
|---|---|---|
| What | Our own store: users, saved connections, pipelines, prefs, logs | Whatever cluster the user is exploring |
| Schema | Ours, known, typed | Unknown, arbitrary, untrusted |
| Access | `MongoHelper` → `DbService` → `src/database/` | `ConnectionManager` → `LiveConnection` → `src/explorer/` |

**Nothing crosses.** A `MongoHelper` never receives a Target Database — that is the defining mistake
available in this codebase. Conveniences that are correct on the left and **data-corrupting** on the
right: `nullToUndefined`, ObjectId-conversion middleware, typing `_id` as `ObjectId`,
collection-name constants, typed entity interfaces.

`null` is a real BSON value in a target document, distinct from an absent field. Never collapse it.

## ⚠ AI writes are structurally prohibited

**Claude never writes to a Target Database. Only the user executes data changes.** Five layers:

1. No write tool exists in the MCP surface. `PROHIBITED_TOOL_NAMES` in
   [src/mcp/mcp-server.ts](src/mcp/mcp-server.ts) is asserted at start-up — registering one fails the boot.
2. Mode gate — [src/mcp/mcp-mode.service.ts](src/mcp/mcp-mode.service.ts), server-side.
3. Dirty-state veto — [src/mcp/app-session.service.ts](src/mcp/app-session.service.ts).
4. Read-only connection flag, checked in the service layer.
5. **`assertUserActor` / `assertWriteAllowed`** — [src/explorer/operation-actor.ts](src/explorer/operation-actor.ts).
   Every write method in `src/explorer/**` calls one as its first statement and refuses
   `actor: 'mcp'`. The actor is a required parameter, so a new write method that forgets it does not
   compile. `npm run check:actor-gate` asserts this mechanically.

There is no `apply_proposal` tool and there must never be one. Read
[../workspace/mcp-server-spec.md § Red lines](../workspace/mcp-server-spec.md#red-lines) before adding
anything to the MCP surface.

## Folder map

```
src/
├── index.ts               # reflect-metadata first import; binds 127.0.0.1
├── container.ts           # Inversify composition root, every binding by hand
├── tokens.ts · config.ts · setup-express.ts · system-setup.ts
├── mongo-helper.ts        # [Application DB] ONLY
├── auth/                  # APP auth (JWT). Not database auth.
├── database/              # [Application DB] services on DbService
├── connections/           # [Target DB] strategy contract, LiveConnection, ConnectionManager
│   ├── strategies/        # connection-string, scram, azure-oidc, x509
│   └── oidc/              # IOidcTokenProvider + 5 Azure flows + a fake for tests
├── explorer/              # [Target DB] stateless services; take a LiveConnection per call
├── mcp/                   # MCP server, mode gate, session mirror, proposals, activity
│   └── tools/             # read · ui · pipeline+shell · proposal registrations
├── server/                # route factories, socket server, middleware
└── model/shared-models/   # SOURCE OF TRUTH; copied to client
```

## Patterns that matter here

- **`explorer/` services are stateless.** They take a `LiveConnection` as a parameter on every call
  rather than capturing one, which is what stops a connection leaking between operations.
- **Every Target Database call is bounded** — explicit `limit`, `maxTimeMS`, and a server cap the
  client cannot raise. No unbounded `.toArray()` anywhere.
- **Truncation is always reported** (`isPartial`, `partialReason`). Silent capping makes the app lie.
- **Extended JSON at the boundary** via `BSON.EJSON` from the driver — see
  [src/utils/ejson.util.ts](src/utils/ejson.util.ts).
- **Redact before logging** — [src/utils/redaction.util.ts](src/utils/redaction.util.ts). Driver errors
  reach the user largely intact minus secrets; opaque errors are what this project exists to escape.
- **Route factories** take dependencies as parameters. Never import a service from a global.
- **`$out` / `$merge` are writes** — detected structurally in
  [src/explorer/pipeline.service.ts](src/explorer/pipeline.service.ts), refused for preview and explain.
- **Shell is Tier A only** — `db.runCommand()` over the existing `LiveConnection`, so it reuses OIDC
  auth. Read-only commands are an **allow-list**; unknown commands are refused, not permitted. Full
  `mongosh` (Tier B) is not implemented and is never MCP-executable.

## MCP tool inference gotcha

The SDK infers tool argument types from Zod schemas. At ~50 tools that inference exhausted the
TypeScript compiler's heap — and because `ts-node` typechecks at run time, it broke `npm start` too.
`defineTool` in [src/mcp/mcp-tool-context.ts](src/mcp/mcp-tool-context.ts) erases the generic and each
handler declares its arguments explicitly. Compile went from OOM to ~2s. **Do not "simplify" this back
to `server.registerTool` directly.**

## Azure OIDC status

Structurally complete, **unverified** — no cluster access from this machine. The five token providers
use `@azure/identity` for real. What is unknown is configuration, not code: the token resource
(audience) and whether the cluster needs a principal name. `ALLOWED_HOSTS` is always set explicitly
because the driver's default excludes Azure hosts — the leading hypothesis for why OIDC fails there.
See [../workspace/research/azure-vcore-oidc.md](../workspace/research/azure-vcore-oidc.md).

## Shared models

`src/model/shared-models/` is the source of truth. After changing it run:

```bash
node ../scripts/sync-shared-models.ts          # copy to client
node ../scripts/sync-shared-models.ts --check  # CI drift check
```
