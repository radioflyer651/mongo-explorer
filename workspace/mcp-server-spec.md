# MCP Server Specification — Mongo Explorer

## Purpose

Mongo Explorer exposes a **Model Context Protocol** server so Claude (or any MCP client) can work
inside the application alongside the user: read the Target Database, see exactly what the user is
looking at, drive the UI, compose aggregation pipelines, draft shell commands, and **propose** data
changes.

The MCP surface is a peer of the mouse and the keyboard — another way to drive the same commands. It
is not a back door to the database, and it is not a second, parallel implementation of the app's
behavior.

Companion documents:
[engineer-design.md](engineer-design.md) ·
[architecture.md](architecture.md) ·
[project-standards.md](project-standards.md) ·
[connection-and-auth.md](connection-and-auth.md)

`[Judgment]` tags mark decisions that were mine rather than direct consequences of stated intent.

---

## The inviolable rule

> **Claude never writes to a Target Database. Only the user executes data changes.**

Restated so there is no room to interpret it:

- Claude may **read** the Target Database freely.
- Claude may **change what the UI shows** — filters, views, tabs, pipeline stages, shell input —
  subject to the [MCP mode switch](#the-mcp-mode-switch).
- Claude may **stage a proposal** describing a data change. The proposal renders in the UI as a diff.
- **The user executes it.** Or doesn't.

**There is no MCP tool that applies a proposal, and there must never be one.** This is not a permission
that could be granted in some future mode — it is the absence of a code path. See
[Red lines](#red-lines).

The distinction that makes this workable: *reading* and *staging* are both non-destructive, and
between them they cover almost everything useful. Claude can analyze a collection, find the malformed
documents, write the exact update, show you the diff, and explain it. You press the button.

---

## Trust model

### The MCP mode switch

The user needs a visible, immediate way to stop an AI from touching their working state. Per intent:
*"an obvious switch that blocks or enables the MCP to change user elements."*

`[Judgment]` **Three positions**, rendered as a segmented control in the **application toolbar** — a
permanent fixture, never inside a settings dialog:

| Mode | Claude can read app state | Claude can read Target Database | Claude can change UI state | Claude can stage proposals | Claude can execute data changes |
|---|---|---|---|---|---|
| **Off** | no | no | no | no | **never** |
| **Observe** | yes | yes | no | yes | **never** |
| **Collaborate** *(default)* | yes | yes | yes | yes | **never** |

- The binary the intent document asks for is **Observe ↔ Collaborate**. `Off` is a cheap addition and
  the honest answer to "I want it to stop entirely."
- The last column is not a setting. No mode enables it.
- **State is displayed at all times**, with a distinct icon and color per mode, plus a tooltip naming
  what is currently permitted. A mode the user has to go looking for is not a control.
- `[Judgment]` Mode persists in the Application Database across restarts, but **drops to `Observe`
  automatically when a Connection is marked read-only** — if the user has flagged a cluster as
  hands-off, the AI's UI-driving privileges are the least of what should tighten.
- `[Judgment]` A keyboard shortcut (`Ctrl+Shift+A`) toggles Collaborate ↔ Observe, so it can be hit
  instantly mid-work.
- Every mode change is logged to the [activity log](#attribution-and-undo) with a timestamp.

**Enforced server-side.** The mode is checked in the MCP server before dispatch, not in the Angular
client. A client that fails to render the switch correctly must not be able to widen what Claude can
do.

### Protecting the user's work

The mode switch answers "stop entirely." It does not answer the subtler fear — *Claude overwrites what
I was in the middle of doing.* Three additional mechanisms do:

#### ◈ Dirty-State Veto

**Any MCP mutation that would discard uncommitted user work fails.** It does not win, and it does not
silently merge.

```typescript
/** Returned when an MCP mutation would destroy unsaved user state. */
export interface DirtyStateVeto {
    readonly code: 'dirty_state_veto';
    /** What is unsaved, in user-facing terms. */
    readonly blockedBy: readonly DirtyRegion[];
    /** What the tool would have changed. */
    readonly attemptedChange: string;
    /** Guidance for the caller: ask the user, or target a different surface. */
    readonly remedy: string;
}

export interface DirtyRegion {
    readonly surface: 'documentEdits' | 'pipelineBuilder' | 'shellInput' | 'connectionEditor';
    readonly description: string;
    readonly itemCount?: number;
}
```

Dirty regions include staged document edits, an edited-but-unrun pipeline, unsent shell input, and an
open connection editor with changes. Claude receives the veto as a structured error naming exactly
what is dirty, so it can ask rather than guess.

`[Judgment]` The veto is **not** overridable by a `force` parameter. A force flag would be used, and
then it would be used by default.

#### Attribution

Every UI change Claude makes is visually marked as AI-originated — a subtle badge on the affected
control, and an entry in the activity log. The user can always answer "did I do that, or did Claude?"

#### Undo

Every MCP-originated UI change is individually undoable from the activity log, and
`Ctrl+Shift+Z` `[Judgment]` reverts the most recent one. UI state changes are cheap to invert; there is
no excuse for a one-way door here.

---

## Architecture

### Where the server lives

```
┌──────────────────────────┐
│ Claude (MCP client)      │
└───────────┬──────────────┘
            │ MCP — Streamable HTTP (127.0.0.1) or stdio shim
┌───────────▼──────────────────────────────────────────┐
│ Express server (port 2701)                           │
│  ┌────────────────────────────────────────────────┐  │
│  │ src/mcp/                                       │  │
│  │  mcp-server.ts        tool + resource registry │  │
│  │  mcp-mode.service.ts  mode gate                │  │
│  │  app-session.service.ts  UI state mirror       │  │
│  │  proposal.service.ts  staged data proposals    │  │
│  └───────────────┬────────────────────────────────┘  │
│                  │ same commands, same services       │
│  ┌───────────────▼────────────────────────────────┐  │
│  │ explorer/  ·  connections/  ·  database/       │  │
│  └────────────────────────────────────────────────┘  │
└──────────┬───────────────────────────────┬───────────┘
           │ Socket.IO                     │
┌──────────▼───────────────┐    ┌──────────▼───────────┐
│ Angular client           │    │ Target Databases     │
│ - renders app state      │    │ (read-only for MCP)  │
│ - applies MCP UI changes │    └──────────────────────┘
│ - owns Execute buttons   │
└──────────────────────────┘
```

**The MCP server is a module inside the Express app, not a separate process.** `[Judgment]` For a
single-user localhost application this is strictly better than a sidecar: it shares the Inversify
container, the `ConnectionManager`, live connections, and the proposal store directly — no IPC, no
duplicated auth, no second place for `LiveConnection` lifecycles to live.

### Transports

| Transport | Use |
|---|---|
| **Streamable HTTP** at `http://127.0.0.1:2701/mcp` | Primary. Bound to loopback like the rest of the server. |
| **stdio shim** — `scripts/mcp-stdio-bridge.ts` | Thin adapter for clients that only speak stdio. Forwards to the HTTP endpoint; holds no logic of its own. |

Both use the official `@modelcontextprotocol/sdk`. `[Judgment]` Verify the SDK's current transport and
tool-registration API during Phase 0 and pin the version — the surface has moved between releases, and
this spec describes intent, not a frozen API signature.

### The app session state mirror

UI state lives in the browser; the MCP server runs in Node. The client **publishes its view state to
the server** over the existing Socket.IO channel, and the server holds an authoritative mirror that
MCP reads. MCP UI mutations travel the other way — server → socket → client — and are applied by the
client's command dispatcher, exactly as if a menu item had been clicked.

```typescript
/** Server-side mirror of what the user is currently looking at. */
export interface AppSessionState {
    readonly mcpMode: McpMode;
    readonly activeConnection?: ActiveConnectionSummary;
    readonly openTabs: readonly TabSummary[];
    readonly activeTabId?: string;
    readonly currentView?: CurrentViewState;
    readonly pipeline?: PipelineBuilderState;
    readonly shell?: ShellSessionState;
    readonly pendingProposals: readonly ProposalSummary[];
    readonly dirtyRegions: readonly DirtyRegion[];
    /** Incremented on every change; lets a caller detect it acted on stale state. */
    readonly revision: number;
}

/** The state of the collection view the user is looking at right now. */
export interface CurrentViewState {
    readonly connectionId: ObjectId;
    readonly databaseName: string;
    readonly collectionName: string;
    readonly viewId: string;                       // 'table' | 'json' | 'list' | ...
    readonly filter?: string;                      // Extended JSON
    readonly projection?: string;
    readonly sort?: string;
    readonly limit: number;
    readonly skip: number;
    readonly selectedDocumentCount: number;
    /** True when the visible page was capped or timed out. */
    readonly isPartial: boolean;
    readonly isReadOnlyConnection: boolean;
}
```

**`revision` is load-bearing.** Mutating tools accept an optional `expectedRevision`; a mismatch
returns `stale_state` rather than applying a change based on a view the user has since moved on from.
`[Judgment]` Optimistic concurrency against a human is unusual but correct here — the user is an
independent writer of the same state.

**No active browser session.** Read-only Target Database tools still work (the server can hold a
`LiveConnection` without a UI). UI tools fail with `no_active_session`. Reporting that clearly beats
appearing to succeed.

**Multiple browser tabs.** `[Judgment]` The most recently focused window is the primary session and the
only one MCP drives. Others render the same state read-only. Single-user means this needs to be
correct, not clever.

---

## Enforcement — five layers

Defense in depth, ordered from outermost. A single-layer guarantee on this rule would be inadequate.

| # | Layer | What it stops |
|---|---|---|
| 1 | **Tool surface** — no write tools exist | Claude cannot call `update_documents`, because there is no such tool |
| 2 | **Mode gate** — checked in the MCP dispatcher | UI mutation while in `Observe` or `Off` |
| 3 | **Dirty-state veto** | Clobbering unsaved user work |
| 4 | **Read-only connection flag** | Any mutation, proposal or otherwise, against a flagged cluster |
| 5 | **◈ Actor-Gated Write Path** — service layer | Everything else, structurally |

### ◈ Actor-Gated Write Path

Layers 1–4 are policy. Layer 5 is structure, and it is the one that survives a bug in the other four.

**Every write path into a Target Database takes an actor**, and the write refuses a non-user actor at
the lowest level — inside the `explorer/` service, below the routes, below MCP, below the UI:

```typescript
/** Who initiated an operation. Threaded to every Target Database write. */
export type OperationActor = 'user' | 'mcp' | 'system';

/** Guard invoked at the top of every Target Database write in explorer/. */
export function assertUserActor(actor: OperationActor, operation: string): void {
    if (actor !== 'user') {
        throw new ForbiddenActorError(
            `Operation '${operation}' requires a user actor; received '${actor}'. ` +
            `AI-originated writes to a Target Database are structurally prohibited.`
        );
    }
}
```

The actor is not optional, not defaulted, and not inferred. A new write method that forgets it does not
compile. `[Judgment]` This makes the guarantee cheap to audit — one grep for `assertUserActor` across
`explorer/` write methods, and the answer is either complete or obviously not.

A CI check `[Judgment]`: every exported method in `src/explorer/**` whose name matches
`/^(insert|update|delete|drop|create|rename|replace|bulk)/` must call `assertUserActor`.

---

## Resources

Resources are the read surface for app state. They are subscribable — `notifications/resources/updated`
fires when the user changes something, so Claude can follow along rather than poll.

| URI | Contents |
|---|---|
| `mongo-explorer://app/state` | Full `AppSessionState`. The "what am I looking at" resource. |
| `mongo-explorer://app/mode` | Current MCP mode and what it permits. Always readable, even in `Off`. |
| `mongo-explorer://view/current` | The visible page of documents, as Extended JSON, with truncation flags |
| `mongo-explorer://view/selection` | Currently selected documents |
| `mongo-explorer://connections` | Saved connections — **names, hosts, and strategy kinds only, never credentials** |
| `mongo-explorer://connection/{id}/databases` | Database list for a connection |
| `mongo-explorer://connection/{id}/{db}/collections` | Collection list with counts and sizes |
| `mongo-explorer://connection/{id}/{db}/{coll}/schema` | Inferred schema from a sample |
| `mongo-explorer://connection/{id}/{db}/{coll}/indexes` | Index list |
| `mongo-explorer://pipeline/current` | Aggregation builder state, stage by stage |
| `mongo-explorer://shell/transcript` | Shell history and results |
| `mongo-explorer://proposals` | Pending proposals with their diffs |
| `mongo-explorer://activity` | Attribution log — who changed what, user or AI |

**Credentials never appear in any resource.** The connections resource returns a redacted summary. This
is not a filter applied at serialization time; the resource builder never receives the secret fields.

---

## Tools

Annotated with MCP tool hints so a client can reason about safety before calling:
`readOnlyHint`, `destructiveHint`, `idempotentHint`.

### Session and control

| Tool | Mode | Notes |
|---|---|---|
| `get_app_state` | Observe+ | Returns `AppSessionState` including `revision` |
| `get_mcp_mode` | any | Readable even in `Off`, so Claude can say *why* it can't act |
| `get_activity_log` | Observe+ | Recent changes with actor attribution |

### Target Database inspection — read-only, always available from Observe up

| Tool | Notes |
|---|---|
| `list_databases` | |
| `list_collections` | Counts, sizes, index counts |
| `get_collection_stats` | |
| `list_indexes` | |
| `count_documents` | Bounded by `maxTimeMS` like everything else |
| `find_documents` | Filter, projection, sort, limit. Server page cap applies and truncation is reported. |
| `sample_documents` | `$sample`-based; the cheap way to understand shape |
| `infer_schema` | Field paths, BSON types, presence frequency, from a sample |
| `explain_query` | |
| `get_server_info` | Version, deployment kind, detected feature support |

These are the tools that make Claude useful, and none of them can change anything. **Every one reports
truncation explicitly** — a silently capped result set would lead Claude to confident wrong
conclusions, which is worse than an error.

### Navigation and view control — UI mutation, requires Collaborate

| Tool | Notes |
|---|---|
| `open_connection` | May return `pending_user_interaction` when the strategy needs a device code or consent — Claude cannot complete an interactive auth on the user's behalf |
| `disconnect_connection` | |
| `open_collection` | Opens a tab and focuses it |
| `close_tab` / `focus_tab` | |
| `set_active_view` | `table` / `json` / `list` / … Rejects a view whose `supports()` returns false |
| `set_query` | Filter, projection, sort, limit, skip. Validates as Extended JSON before applying. |
| `run_query` | Read-only execution against the Target Database — permitted, because reading is permitted |
| `set_column_visibility` | |
| `set_selection` | Selects documents by `_id`; `_id` is `unknown`, not `ObjectId` |
| `clear_selection` | |

`set_query` is the workhorse. "Show me the documents where `status` is null and `updatedAt` is older
than 30 days" becomes a filter Claude writes into the user's filter bar, where the user can see it,
edit it, and run it. That is the collaboration model in one sentence.

### Aggregation pipeline

| Tool | Mode | Notes |
|---|---|---|
| `get_pipeline` | Observe+ | Full builder state |
| `set_pipeline` | Collaborate | Replaces all stages. Dirty-state veto applies. |
| `add_stage` / `update_stage` / `remove_stage` | Collaborate | Stage-level editing |
| `toggle_stage` | Collaborate | Enable/disable without deleting |
| `reorder_stages` | Collaborate | |
| `preview_pipeline` | Observe+ | Read-only execution of a stage prefix, sampled and capped. **Refuses any pipeline containing `$out` or `$merge`.** |
| `explain_pipeline` | Observe+ | |
| `save_pipeline` | Collaborate | Writes to the **Application Database**, not a Target Database |
| `export_pipeline_code` | Observe+ | Node driver / mongosh / Python |

**`$out` and `$merge` are write stages.** A pipeline containing either is a data mutation wearing
read-only clothing, and it is the single most likely way this whole design gets accidentally
circumvented. Rules:

- `preview_pipeline` and `explain_pipeline` **hard-refuse** pipelines containing write stages —
  detected structurally on the parsed pipeline, not by string matching.
- A pipeline with a write stage can only be **proposed**, via `propose_pipeline_run`, and executed by
  the user.
- The builder UI marks such a pipeline with the destructive treatment and names the target collection.

### Mongo shell

| Tool | Mode | Notes |
|---|---|---|
| `get_shell_transcript` | Observe+ | History, inputs, results |
| `set_shell_input` | Collaborate | Writes into the input buffer. **Does not execute.** |
| `run_shell_command` | Observe+ | **Classified read-only commands only** — see [Shell tiers](#shell-access-through-mcp) |
| `get_shell_result` | Observe+ | Result of a given transcript entry |
| `propose_shell_command` | Observe+ | Stages a command for user execution |

### Proposals — the only path to a data change

| Tool | Notes |
|---|---|
| `propose_document_update` | Filter + update document, or a full replacement |
| `propose_document_insert` | |
| `propose_document_delete` | |
| `propose_bulk_operation` | Update-many / delete-many. Must include an affected-count estimate. |
| `propose_index_create` / `propose_index_drop` | |
| `propose_collection_operation` | Create, rename, drop |
| `propose_pipeline_run` | For pipelines with `$out` / `$merge` |
| `propose_shell_command` | |
| `get_pending_proposals` | |
| `withdraw_proposal` | Claude can retract its own proposal |

### Tools that do not exist, deliberately

Listed so their absence is legible as a decision rather than an oversight:

`update_documents` · `delete_documents` · `insert_documents` · `drop_collection` ·
`drop_database` · `create_index` · `execute_shell` · `run_pipeline_with_out` ·
**`apply_proposal`** · `set_mcp_mode` · `set_connection_read_only` · `get_connection_credentials`

Note the last four. Claude cannot widen its own permissions, cannot clear the read-only flag, cannot
read a stored credential, and cannot press the button.

---

## Proposals — the ◈ Propose-Don't-Commit contract

### Lifecycle

```
Claude calls propose_*
        │
        ▼
  Proposal staged  ──► rendered in the Proposals panel with a diff
        │                        │
        │                        ├──► user Applies   ──► executed with actor 'user' ──► applied
        │                        ├──► user Rejects   ──► rejected
        │                        └──► user Edits     ──► becomes a user-authored change, applied
        │
        └──► Claude withdraws / session ends / staleness expiry ──► withdrawn
```

**A proposal is data, not an intention to act.** Nothing in the server acts on one. The only code that
executes a proposal is reached from a user gesture in the client, and it runs with `actor: 'user'`
because a human pressed it.

### Shape

```typescript
/** A data change described by an AI, awaiting user execution. */
export interface DataProposal {
    readonly id: string;
    readonly createdAt: string;
    readonly actor: 'mcp';
    readonly kind: ProposalKind;

    readonly connectionId: ObjectId;
    readonly databaseName: string;
    readonly collectionName?: string;

    /** One-sentence plain-language statement of what this does. Required. */
    readonly summary: string;

    /** Why Claude is proposing it. Required — an unexplained change is not reviewable. */
    readonly rationale: string;

    /** The exact operation, as Extended JSON. What executes is what is shown. */
    readonly operation: ProposalOperation;

    /** Real count from countDocuments, not an estimate. undefined if it could not be determined. */
    readonly affectedCount?: number;

    /** Whether the operation is reversible, and how. */
    readonly reversal: ProposalReversal;

    readonly status: 'pending' | 'applied' | 'rejected' | 'withdrawn' | 'stale';
}

/** Whether the user can get back to where they were. */
export type ProposalReversal =
    | { readonly kind: 'none'; readonly explanation: string; }
    | { readonly kind: 'inverse-operation'; readonly operation: ProposalOperation; }
    | { readonly kind: 'snapshot'; readonly documentCount: number; };
```

**Requirements:**

1. **What executes is exactly what was displayed.** The applied operation is the stored
   `operation` — the client does not rebuild it, and the server does not adjust it. Any divergence
   between the reviewed diff and the executed statement would make review theater.
2. **`summary` and `rationale` are mandatory.** A proposal the user cannot evaluate in ten seconds is a
   rubber stamp waiting to happen.
3. **`affectedCount` comes from a real `countDocuments`** where feasible. "This will update
   *approximately* some documents" is not a basis for consent.
4. **Proposals go stale.** `[Judgment]` A proposal whose collection has been written to since it was
   created is marked `stale` and cannot be applied without regeneration. The document Claude reasoned
   about is not the document on disk any more.
5. **Bulk and drop proposals require the same typed confirmation** a user-authored one would. Being
   AI-authored earns no shortcuts — and no extra obstacles either.
6. **`reversal` is computed, not asserted.** For updates, capture the affected documents' prior state
   as a snapshot where the count is small enough `[Judgment]` (configurable cap, default 1,000), so
   Apply is genuinely undoable. Where it isn't possible, say so in the confirmation.

### The Proposals panel

A first-class UI surface, not a toast:

- Persistent, collapsible panel with a badge count. Visible from anywhere in the app.
- Each proposal renders as a **diff** using the existing cell renderers — same `null`-vs-absent
  distinction, same BSON type badges, same expand affordances. A proposal is reviewed with the same
  tools as the data.
- Commands per proposal, in the command registry like everything else: `proposal.apply`,
  `proposal.reject`, `proposal.edit`, `proposal.explain`, `proposal.copyAsShellCommand`,
  `proposal.copyAsDriverCode`.
- **Apply is never the default focused action.** `[Judgment]` No Enter-key accidents.
- `proposal.edit` opens the operation in the normal editor and converts it into a user-authored staged
  change. `[Judgment]` This is the most valuable command in the panel — "almost right" is Claude's most
  common output, and editing beats regenerating.

---

## Aggregation pipeline through MCP

The builder's design lives in
[engineer-design.md § Aggregation Pipeline Builder](engineer-design.md#aggregation-pipeline-builder).
What matters here:

- The pipeline is **stage-addressable**. Claude adds, edits, disables, and reorders individual stages
  rather than replacing the whole thing, so the user's work on stages 1–3 survives Claude's
  contribution to stage 4.
- `preview_pipeline` accepts a **stage index** and previews the prefix up to it — the same
  per-stage preview the user sees. This is how Claude debugs a pipeline: run to stage 3, look at the
  output, fix stage 3.
- Previews are **sampled and capped**, and always labeled as previews in the result. Claude must not
  report a preview count as a result count.
- Write stages are refused for execution and can only be proposed.
- `[Judgment]` `explain_pipeline` is worth exposing early. Claude reading an explain plan and saying
  "stage 2 can't use your index because of the `$expr`" is among the highest-value things it can do
  here, and it is purely read-only.

---

## Shell access through MCP

The shell's design lives in [engineer-design.md § Mongo Shell](engineer-design.md#mongo-shell). Its
two tiers matter enormously to what MCP can safely do:

### Tier A — Command runner (over `LiveConnection`)

Structured `db.runCommand()` execution through the existing connection. Commands are **classified** by
name against an allowlist of read-only commands (`find`, `aggregate`, `count`, `distinct`, `explain`,
`listCollections`, `listIndexes`, `collStats`, `dbStats`, `serverStatus`, `buildInfo`, `hello`, …).

- `run_shell_command` **executes classified read-only commands directly.** This is reading, and reading
  is permitted. `[Judgment]` Allowing it is what makes the shell useful to Claude rather than
  decorative.
- Anything not on the allowlist — or anything unclassifiable — is refused and must be proposed.
- The allowlist is an **allowlist, not a denylist.** An unknown command is refused, not permitted.

### Tier B — Full `mongosh`

Real shell semantics: arbitrary JavaScript, cursors, helpers, `db.collection.find().forEach(...)`.

**Claude cannot execute anything in Tier B. Ever.** The honest reason: *classifying arbitrary
JavaScript as read-only is undecidable.* `db.foo.find()` is a read; `db.foo.find().forEach(d =>
db.foo.deleteOne(d))` is not, and no practical static analysis separates them reliably. Rather than
pretend otherwise:

- `set_shell_input` writes into the buffer. The user reads it and presses Enter.
- `propose_shell_command` stages it with a rationale.
- `get_shell_transcript` and `get_shell_result` let Claude read what the user ran and reason about it.

`[Judgment]` This is the right place to be conservative. A shell is a general-purpose interpreter
pointed at a production database; there is no safe subset worth the effort of proving.

---

## Structured errors

Every refusal is a structured, actionable error — never a bare failure. Claude should be able to
explain to the user exactly why it could not act.

```typescript
export type McpRefusal =
    | { code: 'mode_blocked'; currentMode: McpMode; requiredMode: McpMode; hint: string; }
    | { code: 'dirty_state_veto'; blockedBy: DirtyRegion[]; attemptedChange: string; remedy: string; }
    | { code: 'read_only_connection'; connectionName: string; }
    | { code: 'writes_prohibited'; operation: string; hint: string; }
    | { code: 'write_stage_present'; stages: string[]; hint: string; }
    | { code: 'unclassifiable_command'; hint: string; }
    | { code: 'no_active_session'; hint: string; }
    | { code: 'stale_state'; expectedRevision: number; actualRevision: number; }
    | { code: 'pending_user_interaction'; interaction: InteractionPrompt; }
    | { code: 'result_truncated'; returned: number; cap: number; hint: string; };
```

`hint` is written for a model, in the imperative: *"Use propose_document_update to stage this change for
the user to execute."* An error that only says "forbidden" wastes a turn.

`writes_prohibited` deserves specific care. Its hint should never suggest a workaround exists, because
none does — it should point at the proposal path and stop.

---

## Notifications

The server emits MCP notifications so Claude tracks reality rather than a stale snapshot:

| Trigger | Notification |
|---|---|
| User changes view, filter, tab, or selection | `resources/updated` on `app/state`, `view/current` |
| User changes MCP mode | `resources/updated` on `app/mode` |
| Proposal applied, rejected, or gone stale | `resources/updated` on `proposals` |
| User runs a shell command | `resources/updated` on `shell/transcript` |
| Pipeline edited | `resources/updated` on `pipeline/current` |
| Connection state changes | `resources/updated` on `app/state` |

`[Judgment]` Debounce UI-state notifications (~250 ms). A user dragging a column boundary should not
generate a hundred notifications.

---

## Client configuration

`[Judgment]` Ship a **Copy MCP configuration** command in the app's settings screen that emits the
right JSON for the running instance — port included — rather than documenting it in a README the user
has to reconcile by hand.

For Claude Code:

```bash
claude mcp add --transport http mongo-explorer http://127.0.0.1:2701/mcp
```

For clients requiring stdio, point at the bridge in [../scripts/](../scripts/). Verify both against the
pinned SDK version in Phase 0.

The endpoint is loopback-only, consistent with the rest of the server. `[Judgment]` No auth token on
the MCP endpoint in the initial version — anything that can reach loopback on this machine can already
read the config file with the real credentials in it, so a token would be ceremony. Revisit
immediately if the app ever becomes non-local, and note it in
[open-questions.md](open-questions.md) so the assumption is not silently inherited.

---

## Red lines

Changes that violate the design intent. Not backlog items — things that should be argued about
explicitly before anyone writes them:

1. **An `apply_proposal` tool**, or any MCP-reachable path that executes a Target Database write.
2. **A `force` parameter** on any mutating tool, defeating the dirty-state veto.
3. **A mode that permits AI-executed data changes.**
4. **An MCP tool that changes the MCP mode**, clears the read-only flag, or otherwise widens Claude's
   own permissions.
5. **Exposing credentials or tokens** through any tool or resource.
6. **Executing anything in Tier B of the shell** from MCP.
7. **Silent truncation** in any read tool — the mechanism by which Claude becomes confidently wrong.
8. **Bypassing `assertUserActor`** in a new `explorer/` write method.

---

## Phasing

| Phase | Contents |
|---|---|
| **M1** — foundation | MCP server module, Streamable HTTP transport, mode switch (UI + server gate), `app/state` and `app/mode` resources, `get_app_state`, `get_mcp_mode`, actor-gated write path with CI check |
| **M2** — read surface | All Target Database inspection tools, schema inference, `view/current` and `view/selection` resources, truncation reporting, resource notifications |
| **M3** — UI control | Navigation and query tools, dirty-state veto, attribution log, per-change undo, stale-revision handling |
| **M4** — proposals | Proposal service, Proposals panel with diff rendering, `propose_*` tools, snapshot-based reversal, staleness detection |
| **M5** — pipeline | Pipeline tools, stage-prefix preview, write-stage refusal, explain, code export |
| **M6** — shell | Transcript resource, `set_shell_input`, Tier A classified `run_shell_command`, `propose_shell_command` |

M1 is not optional groundwork to be deferred — the actor gate and the mode switch must exist **before**
the first tool that touches anything, or they get retrofitted onto code that already assumes it can
write.

---

## Verification checklist

Concrete, testable assertions. These are the tests that make the guarantee real rather than documented:

- [ ] No exported MCP tool performs a Target Database write — asserted by a test enumerating the
      registered tool list against a denied-name set
- [ ] `assertUserActor` is called by every write method in `src/explorer/**` — CI check
- [ ] Every mutating tool is refused in `Observe` and `Off` — parameterized test across the tool list
- [ ] A staged document edit blocks a conflicting `set_query`, returning `dirty_state_veto`
- [ ] A pipeline containing `$out` is refused by `preview_pipeline` and by `explain_pipeline`
- [ ] An unrecognized shell command is refused by `run_shell_command`
- [ ] No resource payload contains a credential, token, or unredacted connection string — asserted by
      a serialization test over every resource with a seeded secret
- [ ] Applying a proposal executes byte-identical Extended JSON to what the diff displayed
- [ ] A proposal whose collection changed after creation is marked `stale` and cannot be applied
- [ ] A truncated read result sets the truncation flag, verified against a collection larger than the cap
- [ ] Mode changes and every MCP-originated UI change appear in the activity log with correct actor
