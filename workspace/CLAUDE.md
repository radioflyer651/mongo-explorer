# CLAUDE.md — workspace folder

## What this folder is

Planning docs, architecture notes, and research for **Mongo Explorer**. **No runnable code lives
here.** Scripts go in [../scripts/](../scripts/); application code goes in the client and server
folders.

## What Mongo Explorer is

A browser-based MongoDB client comparable to MongoDB Compass. Its reason for existing is connecting to
**Azure Cosmos DB for MongoDB (vCore)** using **Microsoft Entra ID / OIDC** — something we cannot
currently do from Compass. General-purpose Compass parity makes it usable; the OIDC path justifies it.

## Read these, in order

| Doc | What it covers |
|---|---|
| [project-overview.md](project-overview.md) | Purpose, audiences, principles, non-goals |
| [architecture.md](architecture.md) | System shape, ports, folder plans, risks |
| [connection-and-auth.md](connection-and-auth.md) | **The core domain.** Connection strategy model, state machine, credential rules |
| [feature-scope.md](feature-scope.md) | Phased feature list |
| [engineer-design.md](engineer-design.md) | App intent + UI/interaction design. Command registry, view registry, pipeline builder, shell, AI integration. |
| [mcp-server-spec.md](mcp-server-spec.md) | **MCP server contract.** Tool surface, enforcement layers, proposal lifecycle. |
| [project-standards.md](project-standards.md) | **The authoritative coding playbook.** Self-contained. |
| [open-questions.md](open-questions.md) | Unresolved decisions — check before assuming |
| [research/azure-vcore-oidc.md](research/azure-vcore-oidc.md) | OIDC hypotheses, all explicitly unverified |

## ⚠ Two MongoDB contexts

This app **uses** MongoDB and **operates on** MongoDB. Never conflate them:

- **Internal DB** — Mongo Explorer's own store (users, saved connections, prefs). Known schema,
  trusted, exactly one. Accessed via `MongoHelper` → `DbService` → `database/`.
- **Target DB** — whatever cluster the user connected to and is exploring. Unknown schema, untrusted,
  many, possibly production. Accessed via `ConnectionManager` → `LiveConnection` → `explorer/`.

Several standard conveniences are **data-corrupting** on the target side — `nullToUndefined`, the
ObjectId-conversion middleware, typing `_id` as `ObjectId`, collection-name constants, singleton
service bindings. Read
[project-standards.md § Two MongoDB contexts](project-standards.md#-two-mongodb-contexts--read-this-before-anything-else)
before writing any server code. It is the most important section in the repo.

## Standards

[project-standards.md](project-standards.md) is **authoritative and self-contained.** Where it
disagrees with `~/.claude/skills/mean-stack-project-setup/references/project-standards.md`, our
document wins — that reference is stale on Angular change detection (it says Zone.js; we are
**zoneless**), on component state (it says RxJS subscriptions; we use **signals**), and on the shared
Mongo host (it says `.run`; correct is **`.com`**).

## Cross-cutting decisions already made

- **Ports:** client `27100`, server `2701`.
- **Internal DB:** `mongo-explorer` on `mongo.fingercraft.com:27017`.
- **Angular is zoneless.** `provideZonelessChangeDetection()`, no zone.js polyfill. Services stay
  RxJS; components consume state as signals via `toSignal()`.
- **The server brokers all MongoDB access.** The browser never holds a driver or a target-cluster
  credential. This is a hard boundary and the thing that makes OIDC possible.
- **App auth (JWT) and database auth (connection strategies) are separate axes.** Conflating them is
  the most likely early design mistake.
- **`MongoHelper` serves only the Internal DB** — never a user's target cluster. Biggest structural
  difference from previous projects using the same playbook.
- **Extended JSON at the API boundary**, not plain JSON, for anything carrying document data.

## ⚠ AI writes are structurally prohibited

The app hosts an MCP server so Claude can drive the UI, read the Target Database, compose pipelines,
and **propose** data changes. **Claude never writes to a Target Database — only the user executes data
changes.** This is not a setting:

- No MCP tool performs a write. There is no `apply_proposal` tool and there must never be one.
- Every write method in `src/explorer/**` calls `assertUserActor(actor, …)` and refuses
  `actor: 'mcp'` at the lowest level, below routes and below MCP.
- A visible **AI mode switch** (Off / Observe / Collaborate) in the application toolbar gates UI
  changes, enforced server-side.
- Read the [red lines](mcp-server-spec.md#red-lines) before adding anything to the MCP surface.

## Things that will bite

- No unbounded `.toArray()` against a target cluster, anywhere. Every call gets `limit` + `maxTimeMS`
  + a server-side cap.
- Never log a credential, token, or unredacted connection string.
- Target-side services are **not** container singletons — they're scoped to a `LiveConnection`.
- `null` is a real BSON value in target documents. Do not collapse it to `undefined`.
- Azure/OIDC code written on this machine is **structural only** — it cannot be verified here. Mark
  unfinished seams with `// TODO-Immediate:`.

## Permissions

Claude may execute npm, ng, tsc, and file-creation commands in this workspace without per-step
confirmation.

## Session continuity

Read [../PROJECT_STATUS.md](../PROJECT_STATUS.md) at session start. Update it before any handoff,
compaction, or stopping point.
