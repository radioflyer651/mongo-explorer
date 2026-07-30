# Feature Scope — Mongo Explorer

Phased feature list. **This is a skeleton awaiting detailed definition** — the phases and headings are
the intended shape, and the next session will fill in per-feature specifics.

Nothing here is committed until it appears in [../PROJECT_STATUS.md](../PROJECT_STATUS.md) as active.

---

## Phase 0 — Foundation *(what `/mean-stack-project-setup` produces)*

- [ ] Angular client installed and serving on `27100`, **zoneless** (`provideZonelessChangeDetection()`,
      no zone.js polyfill)
- [ ] Express server compiling and listening on `2701`
- [ ] Inversify container, config loader, `MongoHelper` for the **Internal DB**
- [ ] App auth: login, JWT, auth middleware, auth guard
- [ ] Shared models folder wired on both sides
- [ ] Base SCSS + design tokens, `ComponentBase`, `PageSizeService`, API client base
- [ ] `CLAUDE.md` in each project folder

The setup skill's bundled standards reference is stale — see
[project-standards.md § Divergences](project-standards.md#divergences-from-the-setup-skill-reference).

---

## Phase 1 — Connect and browse

The minimum viable Compass. Fully buildable and testable on this machine.

**Connections**
- [ ] `IConnectionStrategy` / `LiveConnection` / `ConnectionManager` core
- [ ] Connection-string strategy
- [ ] SCRAM strategy (host/port/user/password/authSource/TLS form)
- [ ] Saved connections CRUD, secrets encrypted at rest
- [ ] Connection state over Socket.IO; connect/disconnect/reconnect UI
- [ ] Test-connection button that reports a real, unredacted-but-scrubbed error

**Browse**
- [ ] Database list with sizes and collection counts
- [ ] Collection list with document count, size, index count
- [ ] Collection detail: paginated document view (cursor-based, hard server-side page cap)
- [ ] Document detail view — tree view and raw Extended JSON view
- [ ] Basic filter bar (`find` filter, projection, sort, limit, skip)

**Decide before writing the document view:** Extended JSON at the API boundary. See
[architecture.md](architecture.md) risk table.

---

## Phase 2 — Azure OIDC *(the reason for the project)*

Structure buildable here; verification requires the work machine. See
[research/azure-vcore-oidc.md](research/azure-vcore-oidc.md).

- [ ] `IOidcTokenProvider` interface + fake implementation for tests
- [ ] `AzureOidcStrategy` with explicit `ALLOWED_HOSTS` handling
- [ ] Interactive-prompt channel (device code display, consent URL, MFA notice)
- [ ] Token cache + refresh; `credential-expiring` state surfaced in UI
- [ ] Sub-modes: device code, auth code + PKCE, managed identity, client credentials
- [ ] Connection editor UI for Entra ID fields (tenant, client, resource, sub-mode)
- [ ] **Verification pass on the work machine against a real cluster**

---

## Phase 3 — Write and edit

Where the tool stops being read-only and starts needing guard rails.

- [ ] Document insert / update / delete, with Extended JSON round-trip fidelity
- [ ] Inline field editing in the grid, with BSON type preservation
- [ ] Bulk operations (update many, delete many) behind explicit confirmation
- [ ] Per-connection read-only flag enforced server-side, not just hidden in the UI
- [ ] Collection create / rename / drop
- [ ] Database create / drop
- [ ] Confirmation pattern for destructive actions (type the name to confirm)

---

## Phase 4 — Aggregation Pipeline Builder

A headline feature, not a convenience. Design in
[engineer-design.md § Aggregation Pipeline Builder](engineer-design.md#aggregation-pipeline-builder).

- [ ] Stage-addressable pipeline model (`PipelineStage`, stable stage ids)
- [ ] Per-stage Monaco editing with Extended JSON validation
- [ ] **Per-stage output preview** (prefix execution, sampled, capped, labeled as a preview)
- [ ] Enable/disable a stage without deleting it
- [ ] Drag to reorder, invalidating previews downstream only
- [ ] Stage palette with descriptions and insertable skeletons
- [ ] Text mode ↔ stage mode, semantically round-trippable
- [ ] `$out` / `$merge` structural detection → destructive treatment, preview and explain refused
- [ ] Explain integration with per-stage index usage
- [ ] Save / load named pipelines to the Application Database
- [ ] Export as code (Node driver, `mongosh`, Python)
- [ ] Promote to shell; results render through the View Registry

---

## Phase 5 — Mongo Shell (Tier A)

Design in [engineer-design.md § Mongo Shell](engineer-design.md#mongo-shell).

- [ ] Command runner over the existing `LiveConnection` — `db.runCommand()`, reuses OIDC auth
- [ ] Read-only command **allowlist** classification (allowlist, never denylist)
- [ ] Transcript pane — append-only, addressable entries with timing
- [ ] Monaco input with history and database/collection completion
- [ ] Results render through the View Registry
- [ ] Per-entry commands: re-run, copy, promote to pipeline, promote to filter, explain
- [ ] `maxTimeMS` default and cancellation

---

## Phase 6 — Query analysis and administration

- [ ] Query history per connection
- [ ] Saved / favorite queries
- [ ] Explain plan viewer (standalone)
- [ ] Schema sampling and inferred-shape display
- [ ] Export results (JSON, CSV) with a size ceiling
- [ ] Index list, create, drop; index build progress
- [ ] Database users and roles (where the deployment supports it)
- [ ] `serverStatus` / metrics view, live over Socket.IO
- [ ] Current operations list with kill-op
- [ ] Validation rules (JSON Schema) view and edit

---

## Phase 7 — MCP server

Full spec: **[mcp-server-spec.md](mcp-server-spec.md)**, which carries its own M1–M6 breakdown.

**M1 is not deferrable groundwork** — the actor gate and the mode switch must exist *before* the first
tool that touches anything, or they get retrofitted onto code that already assumes it can write.

- [ ] **M1** MCP module, Streamable HTTP transport, AI mode switch (UI + server gate), `app/state` and
      `app/mode` resources, **actor-gated write path + CI check**
- [ ] **M2** Read surface — all Target Database inspection tools, schema inference, `view/current`,
      truncation reporting, resource notifications
- [ ] **M3** UI control — navigation and query tools, dirty-state veto, attribution log, per-change undo
- [ ] **M4** Proposals — proposal service, Proposals panel with diff rendering, `propose_*` tools,
      snapshot reversal, staleness detection
- [ ] **M5** Pipeline tools — stage-prefix preview, write-stage refusal, explain, code export
- [ ] **M6** Shell tools — transcript resource, `set_shell_input`, Tier A `run_shell_command`,
      `propose_shell_command`

---

## Phase 8 — Extended connectivity

- [ ] X.509 client certificate strategy
- [ ] SSH tunnel transport decorator (wraps any strategy)
- [ ] Advanced TLS options (CA file, insecure toggle with a loud warning)
- [ ] Full `mongosh` shell (Tier B) — **known limitation:** cannot share our `LiveConnection`, so it
      re-authenticates independently and may be unavailable for OIDC Connections. Never MCP-executable.
- [ ] AWS IAM strategy *(only if a real need appears)*

---

## Deliberately deferred

| Idea | Why not now |
|---|---|
| Charts / dashboards | Different product. Compass's own charting is barely used. |
| Multi-user collaboration on a connection | No demand; large complexity |
| Cluster-to-cluster migration | Different tool |
| Desktop packaging (Electron/Tauri) | Web-first is the point; revisit only if the server-brokered model proves awkward |
| Non-MongoDB databases | Out of scope permanently |
| MCP prompts and sampling | Tools and resources first; no evidence either earns its complexity |
| MCP elicitation for change confirmation | **Rejected, not deferred.** Confirmation belongs in the app where the diff is visible, not in a chat transcript. |
| An AI-executes-writes mode | **Rejected permanently.** See [mcp-server-spec.md § Red lines](mcp-server-spec.md#red-lines). |
