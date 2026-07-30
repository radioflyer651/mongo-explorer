# Architecture — Mongo Explorer

## Shape

```
┌──────────────────────────────┐
│  Browser (Angular)           │   port 27100 (dev)
│  - connection manager UI     │
│  - db / collection tree      │
│  - document grid + editor    │
│  - query bar, aggregations   │
└──────────────┬───────────────┘
               │ HTTPS (JWT app auth) + Socket.IO
┌──────────────▼───────────────┐
│  Node / Express (server)     │   port 2701 (dev)
│  ┌────────────────────────┐  │
│  │ Route factories        │  │  thin: validate, delegate, shape response
│  ├────────────────────────┤  │
│  │ Explorer services      │  │  [Target DB] browse, query, index, admin
│  ├────────────────────────┤  │
│  │ ConnectionManager      │  │  ← the heart of the app
│  │  + ConnectionStrategy  │  │    resolves credentials, builds MongoClient,
│  │    implementations     │  │    owns lifecycle, refreshes tokens
│  ├────────────────────────┤  │
│  │ MongoHelper + database/│  │  [Internal DB] our own store — never a target
│  └────────────────────────┘  │
└──────┬──────────────────┬────┘
       │                  │
       │                  └────────────► Internal DB  (mongo-explorer)
       │                                 saved connections, users, prefs
       ▼
  Target DBs — the databases being explored
  local · self-hosted · Atlas · Cosmos vCore · Cosmos RU
```

**Hard rule:** the browser never holds a MongoDB driver or a target-cluster credential it can use
directly. Every operation is an API call the server performs on the user's behalf.

---

## Why the server brokers everything

This is not just tidiness. It's what makes the primary goal achievable:

- **OIDC token acquisition and refresh** need a confidential-client-capable runtime and a place to
  cache tokens. A browser tab is neither.
- **SSH tunnels and TLS client certificates** are impossible from browser JavaScript.
- **Credential hygiene** — passwords and tokens live in one process we control, not in `localStorage`.
- **Connection pooling** — one `MongoClient` per logical connection, reused across requests, rather
  than a new handshake per user action.

The cost is that we cannot ship a static site. Accepted; it was never on the table.

---

## Two authentication axes — do not conflate

| | **App auth** | **Database auth** |
|---|---|---|
| Question | "Who is using Mongo Explorer?" | "How do we authenticate to *this cluster*?" |
| Mechanism | JWT issued by our server | Pluggable `ConnectionStrategy` |
| Scope | The whole app session | One saved connection |
| Lives in | `src/auth/`, `TokenService` on client | `src/connections/` |

A single logged-in app user may hold several open connections, each authenticated by a different
mechanism. There is deliberately **no** implicit link between the app JWT and any cluster credential.

> Open question: whether the app should support a pass-through mode where the app login *is* the
> Entra ID login, and that same identity is reused for vCore. See
> [open-questions.md](open-questions.md).

---

## Ports and configuration

| Service | Port | Configured in |
|---|---|---|
| Angular dev server | `27100` | `angular.json` → `serve.configurations.development.port` |
| Express / Socket.IO | `2701` | `app-config.json` → `serverConfig.port` (env-var overridable) |

Both numbers deliberately reference MongoDB's `27017`. Neither collides with existing local projects
(d-talk uses `54647` / `1062`).

**Internal database:** `mongo-explorer` on the shared instance at `mongo.example.com:27017`. This
is where saved connections, users, and preferences live — it is *not* a database the user browses.
Keeping our own store on a boring, always-available instance means the app is usable before any target
connection works.

> **Terminology, used consistently across all docs:** the **Internal DB** is Mongo Explorer's own
> store; a **Target DB** is a database the user connected to and is exploring. They are governed by
> different rules. See
> [project-standards.md § Two MongoDB contexts](project-standards.md#-two-mongodb-contexts--read-this-before-anything-else) —
> that section is required reading before writing any server code.

---

## Server folder plan

Follows the standard backend layout, plus one project-specific area:

```
src/
├── index.ts                 # reflect-metadata first import
├── container.ts             # Inversify composition root
├── tokens.ts
├── config.ts
├── setup-express.ts
├── system-setup.ts
├── mongo-helper.ts          # OUR metadata DB only — not target clusters
├── auth/                    # app auth: jwt.ts, auth-middleware.ts
├── connections/             # ← project-specific, the heart of the app
│   ├── connection-manager.service.ts
│   ├── live-connection.ts
│   └── strategies/
│       ├── connection-strategy.ts          # IConnectionStrategy contract
│       ├── connection-string.strategy.ts
│       ├── scram.strategy.ts
│       ├── x509.strategy.ts
│       ├── azure-oidc.strategy.ts          # the reason this project exists
│       └── ...
├── explorer/                # domain services over a LiveConnection
│   ├── database-explorer.service.ts
│   ├── collection-explorer.service.ts
│   ├── document.service.ts
│   ├── query.service.ts
│   ├── pipeline.service.ts          # aggregation builder execution + preview
│   ├── shell.service.ts             # Tier A command runner over LiveConnection
│   ├── index-admin.service.ts
│   ├── operation-actor.ts           # OperationActor + assertUserActor
│   └── server-status.service.ts
├── mcp/                     # MCP server — see mcp-server-spec.md
│   ├── mcp-server.ts                # tool + resource registration
│   ├── mcp-mode.service.ts          # Off / Observe / Collaborate gate
│   ├── app-session.service.ts       # server-side mirror of the browser's UI state
│   └── proposal.service.ts          # staged data proposals, never executed by MCP
├── database/                # [Internal DB] DB services — our store only
│   ├── db-service.ts
│   ├── saved-connection-db.service.ts
│   └── auth-db.service.ts
├── server/                  # route factories, one per concern
└── model/
    ├── app-config.model.ts
    └── shared-models/       # source of truth; copied to client
```

`explorer/` services take a `LiveConnection`, never a connection string. That single constraint is
what keeps the OIDC path from leaking into forty files.

Three structural rules that follow, all spelled out in
[project-standards.md § Target Database Context](project-standards.md#backend-standards--target-database-context):

- `mongo-helper.ts` and `database/` are **Internal DB only**. `connections/` and `explorer/` are
  **Target DB only**. Nothing crosses.
- Target-side services are **not container singletons** — they're scoped to a `LiveConnection` and
  obtained through `ConnectionManager`. The container binds factories here, not instances. Binding one
  as a singleton with a captured connection surfaces later as one query hitting the wrong cluster.
- **Every Target DB write takes an `OperationActor` and refuses non-user actors** via
  `assertUserActor()`. This is what makes AI-initiated writes structurally impossible rather than
  merely disallowed — `src/mcp/` sits above this gate like everything else. See
  [mcp-server-spec.md](mcp-server-spec.md).

---

## Client folder plan

Standard Angular layout from the project standards, with feature areas. **Angular runs zoneless** —
`provideZonelessChangeDetection()` in `app.config.ts`, no zone.js polyfill. Services stay RxJS;
components consume state as signals via `toSignal()`. See
[project-standards.md § Frontend Standards](project-standards.md#frontend-standards-angular).

```
src/app/
├── components/
│   ├── component-base/
│   ├── connections/          # connection list, connection editor, connect dialog
│   ├── explorer/             # db tree, collection list, collection detail
│   ├── documents/            # document grid, JSON editor, document detail
│   ├── query/                # filter bar, projection/sort, aggregation builder
│   ├── indexes/
│   ├── admin/                # users, roles, server status
│   └── login/
├── services/
│   ├── explorer/
│   │   └── api-clients/      # ApiClientBase + ClientApiService + specialized
│   ├── connection-state.service.ts
│   ├── page-size.service.ts
│   └── token.service.ts
├── routing/
└── app.routes.ts             # single flat routes file, auth-guarded subtree
```

---

## Real-time (Socket.IO)

Used sparingly, only where polling would be wrong:

- Connection state changes (connected / reconnecting / token expired / dropped).
- Long-running operation progress (large query, index build, export).
- Live `serverStatus` / ops metrics, when that view is open.

Everything else is request/response. Socket.IO is not a general transport here.

---

## Shared models contract

`mongo-explorer-server/src/model/shared-models/` is the source of truth and is copied verbatim to
`mongo-explorer-client/src/model/shared-models/`. Interfaces and constants only. The client declares
`mongodb` as an ambient module aliasing `ObjectId` to `string`.

Anticipated shared model groups:

- `connections/` — `SavedConnection`, `ConnectionStrategyKind`, `ConnectionState`, per-strategy
  credential shapes
- `explorer/` — `DatabaseSummary`, `CollectionSummary`, `IndexInfo`, `QueryRequest`,
  `QueryResultPage`, `SchemaSample`
- `auth/` — app user and token payload shapes
- `socket-messaging/` — event-name constants paired with message interfaces

---

## Known architectural risks

| Risk | Why it matters | Mitigation |
|---|---|---|
| Token expiry mid-session | OIDC access tokens are short-lived; a pooled `MongoClient` outlives them | Driver-level OIDC callback that re-acquires on demand; surface `token expired` as a first-class connection state |
| Large result sets | A naive `find().toArray()` on a big collection kills the server | Cursor-based pagination with hard server-side caps from the start |
| `ObjectId` / BSON round-tripping | JSON loses BSON types; a "save" could silently corrupt a document | Use Extended JSON at the API boundary, not plain JSON. Decide this before writing the document editor. |
| Destructive operations | This tool can drop a production database | Confirmation flows and an optional per-connection read-only flag |
| Credential storage at rest | Saved connections may hold passwords | Encrypt secrets at rest in the metadata DB; key from `app-config.json`. See [open-questions.md](open-questions.md). |
