# PROJECT_STATUS — Mongo Explorer

**Last updated:** 2026-07-30
**Phase:** Built. Server verified end-to-end against a live MongoDB. Client compiles and serves;
**not yet visually verified in a browser.**

---

## Bottom line

Both projects are installed, compile clean, and run. The server was exercised end-to-end against the
real MongoDB at `mongo.fingercraft.com:27017` — real databases listed, capability detection correct,
50 MCP tools registered, and all four AI-safety guarantees verified live over the MCP protocol.

The one thing not verified: **the Angular UI has not been opened in a browser.** It builds and the dev
server serves it, but there is no browser automation on this machine, so rendering and interaction are
unproven. That is the first thing to do next.

Azure OIDC is structurally complete and **unverified** — by design, there is no cluster access here.

---

## What runs

```bash
# Server — port 2701, bound to 127.0.0.1
cd mongo-explorer-server && npm start

# Client — port 27100
cd mongo-explorer-client && npm start
```

| Check | Result |
|---|---|
| `tsc --noEmit` (server) | clean, ~2s |
| `ng build` (client) | clean, 4.55 MB dev bundle |
| `node --test test/safety.test.ts` | **49/49 pass** |
| `npm run check:actor-gate` | intact, 7 files scanned |
| `node scripts/sync-shared-models.ts --check` | 14 files in sync |
| Server boot | listening, MCP endpoint mounted |
| Live database read | real databases listed from `mongo.fingercraft.com` |
| Capability detection | correctly identified self-hosted MongoDB 6.0.5 |

---

## Verified live over MCP

Against a real connection, through the actual protocol:

1. **Read permitted** — `find_documents` returned real documents as Extended JSON.
2. **UI change refused in Observe** — `set_query` returned `mode_blocked` with an actionable hint.
3. **Proposal refused on a read-only connection** — `read_only_connection`.
4. **`apply_proposal` does not exist** — `Tool apply_proposal not found`.

Also observed working: connecting a read-only connection **auto-narrowed Collaborate → Observe** and
persisted that to the Application Database, exactly as designed.

---

## Built

### Server (`mongo-explorer-server`)
- Config loader with env-var override; **binds `127.0.0.1`**
- Inversify composition root; every binding by hand
- Application Database layer: `MongoHelper`, `DbService`, 7 DB services, AES-256-GCM secret cipher
- **Connection strategies:** connection-string, SCRAM, X.509, and **Azure OIDC** with five
  `@azure/identity` token providers (auth-code, device-code, managed identity, client credentials,
  Azure CLI) plus a fake for tests
- `LiveConnection` state machine (9 states incl. `AwaitingUserInteraction`, `CredentialExpiring`);
  `ConnectionManager` with pooling, capability detection, interactive-prompt channel
- **Target Database services:** database/collection explorer, query (find/count/sample/schema/explain),
  documents, indexes, **pipeline**, **shell Tier A**, server status — all stateless, all bounded
- **`assertUserActor` actor gate** on every write + CI check script
- App auth (JWT, off by default), Zod envelope validation, route factories, global error handler
- Socket.IO server; redaction utility; Extended JSON utilities
- **MCP server: 50 tools**, 8 resources, session-based Streamable HTTP transport, mode gate,
  session mirror, proposal service, activity log, prohibited-tool assertion at boot

### Client (`mongo-explorer-client`)
- Angular 22 **zoneless**, PrimeNG, design tokens, three global SCSS files
- **◈ Command registry** + toolbar, context menu, and keyboard-shortcut renderers
- **◈ View registry** + table, JSON, and list views with a `ViewHost`
- **◈ Cell renderer registry** + value, null/absent, and complex/binary renderers
- `WorkspaceService` (tabs, view state, staged edits), `ConnectionStateService`, `ExplorerDataService`
- `AiSessionService` — socket bridge, state publishing, MCP mutation dispatch **through the command
  registry**, dirty-region reporting
- Explorer sidebar (connections + database/collection tree, interactive-auth prompts), collection detail
  (query bar, view switcher, partial-results banner, pagination), connection editor (all four
  strategies incl. Entra ID fields)
- **AI mode switch** (3 positions, permanent toolbar fixture), **Proposals panel** (diff review, typed
  confirmation, apply/reject)
- **Pipeline builder** (stage palette, per-stage preview, disable-without-delete, reorder, write-stage
  warning, code export) and **shell panel** (Tier A, classification hints, AI-authored attribution)

### Workspace
- `scripts/sync-shared-models.ts` (with `--check` for CI)
- `scripts/verify-ui.ts` — drives the live UI over the DevTools Protocol, no dependencies
- `mongo-explorer-server/scripts/check-actor-gate.ts`
- `CLAUDE.md` in both projects; `APP-CONFIG.md`; `app-config.json`

---

## First browser run: four dead controls

Every one of these compiled, served, and typechecked cleanly. The lesson recorded in
[mongo-explorer-client/CLAUDE.md](mongo-explorer-client/CLAUDE.md): **a green build says nothing about
whether a control works.**

| Bug | Cause | Symptom |
|---|---|---|
| Right-click and every `...` button did nothing | Three components each held a private `menuRequest` signal; the single `<app-command-menu>` was bound to the shell's, which nothing ever set | No menu anywhere |
| The database tree never appeared | `computed(() => connections.activeConnectionId)` — a `computed` over a plain getter has no signal dependency, so it cached `undefined` forever and the `@if` gating the whole Databases section was permanently false | Clicking a connection appeared to do nothing |
| Row selection and the field menu were inert | `*ngComponentOutlet` was given an `outputs` binding, which Angular does not support (NG0303); every event a registry-rendered view emitted was dropped | Cell right-click and row selection did nothing |
| A greyed-out pager button still paged | `[class.is-disabled]` is styling, not `[disabled]` | Page position read `51–50 of 19` with zero rows |

Fixed by [context-menu.service.ts](mongo-explorer-client/src/app/core/commands/context-menu.service.ts)
(one menu, one owner), `toSignal` bridging, imperative view creation via `ViewContainerRef`, and real
`[disabled]` attributes backed by handler-level guards.

---

## Not done / known gaps

| Gap | Detail |
|---|---|
| **Browser verification** | ✅ **Done.** The interaction path is verified end-to-end against a live MongoDB by `node scripts/verify-ui.ts` — 16/16 checks, real pointer events. Four dead-control bugs were found and fixed in the process (see the log below). Surfaces still unverified: the pipeline builder, the shell panel, the Proposals panel, and the connection editor's save path. |
| **Azure OIDC verification** | Structural only. Unknown: the token resource (audience) and whether a principal name is required. Code path complete. See [workspace/research/azure-vcore-oidc.md](workspace/research/azure-vcore-oidc.md). |
| Shell Tier B (`mongosh`) | Not implemented. Cannot share our `LiveConnection`; may be unavailable for OIDC connections entirely. Never MCP-executable. |
| Inline cell editing | Staging model and `stagedEdits` exist; the in-grid edit affordance and apply flow are not wired. |
| Undo of AI UI changes | `undoPayload` is captured and logged; the `Ctrl+Shift+Z` reversal is not implemented. |
| Command palette (`Ctrl+K`) | Registry supports it; no palette component. |
| Index create/drop UI | Server endpoints and MCP tools exist; no interface. |
| Users/roles, currentOp UI | Server endpoints exist; no interface. |
| Export results (JSON/CSV) | Not implemented. |
| Saved queries / history UI | Server stores history; no interface. |
| SSH tunnel, AWS IAM strategies | Not implemented (Phase 8). |
| Monaco editor | Installed but unused — plain textareas in the pipeline builder and shell. |
| `git init` | Still not a repository. |

---

## Next steps

1. **Open `http://localhost:27100` and fix whatever the UI does wrong.** Nothing else is worth doing
   before this.
2. Replace the placeholder secrets in `mongo-explorer-server/app-config.json`
   (`jwtSecret`, `secretEncryptionKey` are dev-only strings).
3. Wire inline cell editing into the staged-edit buffer, then AI-change undo.
4. On the work machine: run the `ALLOWED_HOSTS` + pasted-token probe from the research notes before
   writing any more OIDC code.

---

## Key decisions and reasoning

| Decision | Reasoning |
|---|---|
| Ports `27100` / `2701` | Echo `27017`; no collision with d-talk or multi-chat |
| Server binds `127.0.0.1` | Single-user by intent. One argument, and the most effective control in the codebase — it is also why the MCP endpoint needs no auth. |
| Angular 22, not 20 | PrimeNG 22 requires it, and the standards specify zoneless. Global CLI is 20; used `npx @angular/cli@22`. |
| `bcryptjs` over `bcrypt` | Native builds fail on Windows without VS build tools. Pure-JS, same API. Deviation from the playbook, noted. |
| `defineTool` erases the SDK's Zod generic | The SDK's inference OOM'd `tsc` at ~50 tools, and `ts-node` typechecks at runtime, so it broke `npm start` too. OOM → 2s compile. |
| MCP session-based transport, not stateless | One shared stateless transport 500s on the second request. Sessions also enable resource-update notifications. |
| `explorer/` services are stateless | They take a `LiveConnection` per call rather than capturing one — prevents a connection leaking between operations without needing per-connection DI scopes. |
| `assertUserActor` as the load-bearing guard | Policy in four layers plus structure in one. A required parameter means a forgotten guard does not compile; a grep proves the rest. |
| Standards copied into the repo | The skill's reference had drifted (stale Angular stack, wrong Mongo host) and this repo moves machines. |
| Single-user → no connection ownership | Reversed the earlier plan. With one user and no network exposure, ownership columns are ceremony. |

---

## Environment notes

- **Not the work machine.** No Azure vCore cluster or tenant. All Azure work is structural.
- `mongo.fingercraft.com:27017` **is** reachable from here and holds the `mongo-explorer` Application
  Database (created and indexed during verification).
- Node 26.3.1, npm 11.16.0, global Angular CLI 20 (client generated with `npx @angular/cli@22`).
- `app-config.json` contains **dev-only placeholder secrets**. Replace before storing real credentials.
- A test connection named `fingercraft-local-test` was created during verification and is flagged
  `isApplicationDatabase: true`. Delete it if you don't want it.

---

## Open questions

See [workspace/open-questions.md](workspace/open-questions.md). Q1 (secret encryption) was answered in
code with AES-256-GCM; confirm that is what you wanted. Q3 (`bson` EJSON) and Q4 (test framework —
`node --test` on the server, nothing yet on the client) were decided by implementation and are worth a
look.
