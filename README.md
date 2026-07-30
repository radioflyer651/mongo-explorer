# Mongo Explorer

A web-based MongoDB client in the spirit of MongoDB Compass — browse and manage databases,
collections, documents, indexes, and users through a browser instead of a desktop app.

**The niche it exists to fill:** connecting to **Azure Cosmos DB for MongoDB (vCore)** using
**Microsoft Entra ID / OIDC**, which currently cannot be done from Compass in our environment.
Mongo Explorer is designed so a connection method is a pluggable strategy, and OIDC is a
first-class one.

---

## Running it

Open [mongo-explorer.code-workspace](mongo-explorer.code-workspace) in VS Code, then:

| Where you press F5 | What happens |
|---|---|
| **The workspace file** → pick *Mongo Explorer: server + client* | Starts both, opens a browser with the debugger attached |
| A file in **mongo-explorer-server** | Starts the API on `127.0.0.1:27050` with a debugger attached |
| A file in **mongo-explorer-client** | Runs `ng serve`, waits until it's actually listening, then opens the browser at `localhost:27100` |

Breakpoints work directly in `.ts` files on both sides. Stopping either half of the compound stops
both, so ports are never left held.

Command line equivalents:

```bash
cd mongo-explorer-server && npm start     # API, port 27050
cd mongo-explorer-client && npm start     # UI,  port 27100
```

The client needs the API running. First run creates the `mongo-explorer` Application Database
automatically.

---

## Status

**Built and running.** The server is verified end-to-end against a live MongoDB; the UI compiles and
serves. See [PROJECT_STATUS.md](PROJECT_STATUS.md) for what's verified and what isn't.

---

## Layout

| Folder | What lives there |
|---|---|
| [mongo-explorer-client/](mongo-explorer-client/) | Angular frontend (standalone components, PrimeNG) |
| [mongo-explorer-server/](mongo-explorer-server/) | Node/Express backend (TypeScript, Inversify, MongoDB driver) |
| [workspace/](workspace/) | Planning docs, architecture, research. No runnable code. |
| [scripts/](scripts/) | Repeatable dev/ops scripts |

Open [mongo-explorer.code-workspace](mongo-explorer.code-workspace) in VS Code to get all four
folders at once.

---

## Ports

| Service | Port |
|---|---|
| Angular dev server | `27100` |
| Express / Socket.IO | `27050` (bound to `127.0.0.1`) |

Both echo MongoDB's `27017` so they're easy to remember, and neither is a default that collides
with other local projects. `2701` was the original choice but collides with `CmRcService` (SCCM
Remote Control), which auto-starts on corporate-managed Windows machines — `27050` avoids it.

The server binds the loopback interface only. It's single-user by design and must not be reachable
from the network — that's also why the MCP endpoint carries no auth token.

---

## Start here

1. [workspace/project-overview.md](workspace/project-overview.md) — what this is and why
2. [workspace/architecture.md](workspace/architecture.md) — how the pieces fit
3. [workspace/connection-and-auth.md](workspace/connection-and-auth.md) — the core problem domain
4. [workspace/feature-scope.md](workspace/feature-scope.md) — the feature phases
5. [workspace/open-questions.md](workspace/open-questions.md) — decisions still needed

## Next step

Run `/mean-stack-project-setup` to install and configure both projects.
