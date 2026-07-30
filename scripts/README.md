# scripts/

Repeatable dev and ops scripts for Mongo Explorer. Prefer a script over re-deriving a procedure —
it's cheaper now and survives across sessions and machines.

## Conventions

- **TypeScript (Node)** by default; plain JS for throwaway utilities; Python for data-heavy work;
  Bash (WSL) for env setup and CLI chaining.
- Every script opens with a comment header: **purpose, inputs, required setup.**
- Scripts never contain secrets. Read them from env vars or `app-config.json`.
- Run them with `node scripts/<name>.ts` — Node strips the types. That means **no constructor
  parameter properties, no `enum`, no `namespace`**: strip-only mode cannot erase them and the
  script will refuse to start.

## Written

| Script | Purpose |
|---|---|
| `sync-shared-models.ts` | Copy `server/src/model/shared-models/` → `client/src/model/shared-models/`. Server is the source of truth. `--check` reports drift and exits non-zero, for CI. |
| `verify-ui.ts` | Drive the running UI with **real pointer events** and assert each interaction did something. Requires both halves running. Exits non-zero on any failure. |

### verify-ui.ts

```bash
node scripts/verify-ui.ts                              # all checks, headless
node scripts/verify-ui.ts --database chamber           # pick the database to expand
node scripts/verify-ui.ts --connection my-cluster      # pick the saved connection
node scripts/verify-ui.ts --keep-open                  # visible browser, left running
```

This exists because **a UI that compiles is not a UI that works.** Every bug it was written to
catch — a context-menu signal nobody rendered, a `computed` over a plain getter, an
`ngComponentOutlet` outputs binding Angular does not support — built and served perfectly while
doing nothing at all on click. There is no browser test runner in this project; this script speaks
the Chrome DevTools Protocol directly over Node's built-in `WebSocket`, so it needs no dependencies.

It asserts hit-testability before every click, so a miss is reported as an invalid test rather than
as a broken feature.

## Planned

| Script | Purpose |
|---|---|
| `oidc-probe.ts` | Minimal `MONGODB-OIDC` connection attempt against Azure vCore with explicit `ALLOWED_HOSTS` and a pasted token. **The first thing to run on the work machine** — see [../workspace/research/azure-vcore-oidc.md](../workspace/research/azure-vcore-oidc.md). |
| `seed-test-data.ts` | Populate a local MongoDB with varied BSON types and collection sizes for UI testing. |
| `dev.ps1` | Start client and server together for local development. |
