# App Intent and Engineering Design

## How to read this document

The **Usage**, **DB Separation & Intentions**, and **UI** intent statements are Richard's, preserved
as written. Everything under an *Engineering expansion* heading is a design decision derived from
them. Where a decision was a judgment call rather than a direct consequence, it's marked
**`[Judgment]`** so it's easy to find and veto.

Companion documents:
[project-overview.md](project-overview.md) ·
[architecture.md](architecture.md) ·
[connection-and-auth.md](connection-and-auth.md) ·
[project-standards.md](project-standards.md) ·
[feature-scope.md](feature-scope.md)

---

## Usage

This application is intended for a single-user usage. While utilizing the MEAN stack, it is intended to
function for a single user, and NOT be served outside the local machine.

### Engineering expansion — deployment model

**The server is a local companion process, not a hosted service.** It runs on the same machine as the
browser, serves exactly one human, and is never reachable from the network.

Concrete requirements:

- **Bind to the loopback interface explicitly.** `server.listen(port, '127.0.0.1')` — never
  `0.0.0.0`, never the default. This is one argument and it is the single most effective control in
  the application. Put it in `app-config.json` as `serverConfig.bindAddress` with `127.0.0.1` as the
  default, so it's deliberate rather than accidental.
- **CORS allows exactly one origin:** `http://localhost:27100` in dev, and the production origin when
  the client is served by the server itself. No wildcards.
- **No registration, no roles, no user administration.** Those screens do not exist.

### Engineering expansion — what single-user changes `[Judgment]`

This constraint arrived after the architecture docs were written and it **reverses two earlier calls.**
Both reversals are net simplifications:

| Earlier position | Revised | Why |
|---|---|---|
| Build JWT app auth and scope saved connections by `userId` from the start | **No user scoping on saved connections.** No `ownerId` field, no per-user queries. | With one user and no network exposure, ownership columns are pure ceremony. If multi-user ever arrives it's a migration — an honest cost, cheaper than carrying dead scoping through every query for a case that is now explicitly out of scope. |
| App login as a security boundary | **App login is a local lock, not a boundary.** | Nothing hostile can reach the port. A login screen defends only against someone at the keyboard. |

On the app-login question specifically: the setup skill scaffolds JWT auth, and there's no reason to
rip it out — but **do not build features on it.** Configure a single user, keep
`authMiddleware` in place so route signatures stay uniform, and treat `getUserIdFromRequest()` as
returning a constant. `[Judgment]` Default to **no login prompt at all** on first run; make it an
opt-in setting for someone who shares a machine. A password gate on a localhost-only single-user tool
is friction charging rent for security it doesn't provide.

**What still matters despite single-user:**

- **Credential encryption at rest is unaffected.** Saved Target Database passwords sit in a file on
  disk. The threat is anything that can read that file — backup sync, another process, a shared
  machine — none of which care that the app is single-user. Keep the encryption.
- **The read-only connection flag is unaffected.** It protects against *you*, not against an attacker.
  A production cluster does not care that only one person can reach the UI.
- **Bounded queries are unaffected.** `maxTimeMS` and page caps protect the target cluster and the
  local process, not a multi-tenant server.

### Engineering expansion — what single-user *enables*

Being local is not only a restriction; it unlocks capabilities a hosted app could not have. These are
worth designing for deliberately:

| Capability | Why local makes it possible |
|---|---|
| **OIDC authorization-code + PKCE with a `http://localhost:<port>/oauth/callback` redirect** | The server can bind a loopback redirect URI and open the system browser. This is the best Entra ID UX available and it is *easier* here than in a hosted app. `[Judgment]` Make this the **default** Azure sub-mode, ahead of device code. |
| Opening the system browser for consent | `child_process` on a local machine, no popup blockers, no cross-origin dance |
| Reading local TLS/X.509 certificate and key files by path | The files are on the same machine as the process |
| Spawning SSH tunnels | Local SSH agent and keys are available |
| Reading `~/.mongodb/`, `~/.azure/`, and existing `az` CLI token caches | `[Judgment]` Worth exploring — reusing an existing `az login` session may remove the interactive step entirely |
| Filesystem export/import at real sizes | Streaming to a local path instead of a browser download |

The OIDC redirect point is the most valuable item in this table. It should shape the Phase 2 design.

---

## Naming & Vocabulary

Fixed terms. Used in code, in the UI, in commit messages, and in these documents — no synonyms.

| Concept | Code identifier | User-facing label | Never call it |
|---|---|---|---|
| The database being examined and edited | `TargetDatabase` | **Target Database** | "the database", "remote DB", "user DB" |
| A configured, connectable Target Database | `TargetConnection` / `SavedConnection` | **Connection** | "profile", "server" |
| An established, live session to a Target Database | `LiveConnection` | **Active Connection** | "session", "client" |
| Mongo Explorer's own storage | `ApplicationDatabase` | **Application Data** | "the database", "metadata DB", "internal DB" |

`[Judgment]` **`ApplicationDatabase`** is my coinage — the intent document names `TargetDatabase` but
leaves the other side unnamed, and an unnamed half is exactly how the two get confused. It reads as the
deliberate counterpart to `TargetDatabase`, which is the point.

**This supersedes the "Internal DB" / "Target DB" shorthand** used in
[project-standards.md](project-standards.md) and [architecture.md](architecture.md). Those documents
are still correct in substance; the terms in this table are the ones to write in code. The
`[Internal DB]` / `[Target DB]` section tags in the standards remain useful as *annotations* — they're
markers, not identifiers.

User-facing copy never mentions the Application Database at all. The user did not ask for a tool with
its own database; from their side it's "settings" and "saved connections."

---

## DB Separation & Intentions

The database used by this project is NOT intended to be the same one that is being examined by this
application. While certainly possible, ensure that the two topics are not confused, and remain
separate. The MongoDB being worked with and edited is called the TargetDatabase. User facing
identification will coin this as Target Database.

### Engineering expansion

The full rule set lives in
[project-standards.md § Two MongoDB contexts](project-standards.md#-two-mongodb-contexts--read-this-before-anything-else)
and [§ Target Database Context](project-standards.md#backend-standards--target-database-context). The
short version:

- `ApplicationDatabase` access: `MongoHelper` → `DbService` → `src/database/`. Known schema, typed
  entities, `ObjectId` ids, collection-name constants.
- `TargetDatabase` access: `ConnectionManager` → `LiveConnection` → `src/explorer/`. Unknown schema,
  `Document`/`unknown` payloads, Extended JSON at the boundary, no collection constants, bounded
  queries always.
- **Nothing crosses.** A `MongoHelper` never receives a Target Database. An `explorer/` service never
  receives a connection string.

**"While certainly possible" — the same-instance case.** Nothing stops a user from pointing a
Connection at `mongo.fingercraft.com` and browsing the `mongo-explorer` database itself. That must
work; it's a legitimate thing to do and blocking it would be paternalistic. But:

- `[Judgment]` The Application Database **never appears as a pre-populated Connection.** The user has
  to type it, deliberately.
- `[Judgment]` When a Connection resolves to the same host *and* database as the Application Database,
  show a **persistent, non-blocking banner**: *"This connection is Mongo Explorer's own application
  data. Changes here affect the app itself."* One warning, dismissible per session, no modal.
- The code path is unchanged — it goes through `LiveConnection` like any other Target Database. The
  separation is architectural, not conditional. **Never** add a branch that routes a Target Database
  operation through `MongoHelper` because it happens to point at our database.

### Guarding against confusion in review

Three cheap, mechanical checks worth having `[Judgment]`:

1. A lint rule or CI grep: no import from `src/explorer/**` or `src/connections/**` may reference
   `mongo-helper`, `database/db-service`, or `db-collection-names.constants`.
2. Nothing in `src/database/**` may import from `src/connections/**` or `src/explorer/**`.
3. Type-level: `explorer/` service methods take `LiveConnection` as their first parameter, so a
   `MongoHelper` cannot be passed without a compile error. Make the parameter positions consistent so
   the mistake is impossible rather than merely discouraged.

---

## UI

UI is a first class citizen when considering interaction. Making the UI intuitive with features being
conspicuous is a must. Main control features must be identified and used in a consistent manner. Right
click menus and toolbars are required for operations throughout the application. These are the first
places to consider adding functionality. Further, other control elements, such as cells for tables,
should be planned to allow widgets and buttons to be included in the content of these items to enhance
controls.

Interaction and Grid development will be ongoing and iterative. This should be extensible and avoid
locking the application into features like these. Like Compass and other similar applications, we will
need to be able to have different views for different scenarios and/or needs. Table view, JSON view,
list views, etc.

### Engineering expansion — the load-bearing decision

"Right click menus and toolbars are required throughout" plus "used in a consistent manner" plus
"ongoing and iterative" has exactly one correct engineering answer, and getting it wrong early is
expensive:

> **Do not build menus and toolbars.** Build a **command registry**, and make context menus, toolbars,
> keyboard shortcuts, and in-cell buttons all *projections* of it.

If a context menu item and a toolbar button are separate pieces of code, they drift — different labels,
different icons, one gets the new enablement rule and the other doesn't, and a feature added to the
toolbar silently never reaches the right-click menu. That drift is guaranteed on an iterative
timeline. One registry with four renderers makes consistency structural instead of a review burden.

### ◈ Command Registry Pattern

**One declaration per operation. Every surface renders from it.**

```
                      ┌──► ContextMenuHost      (right-click)
                      │
AppCommand ──► CommandRegistry ──► ToolbarHost   (toolbars)
 (declared once)      │
                      ├──► KeybindingHost        (shortcuts)
                      │
                      └──► CellActionHost        (in-cell buttons)
```

```typescript
/** A single user-invocable operation, rendered identically wherever it appears. */
export interface AppCommand<TContext extends CommandContext = CommandContext> {
    /** Stable dotted identifier, e.g. 'collection.drop'. Never displayed. */
    readonly id: string;

    /** Menu and tooltip text. Sentence case, no trailing ellipsis unless it opens a dialog. */
    readonly label: string;

    /** Icon class, from the canonical icon map below. */
    readonly icon: string;

    /** Which context kinds this command applies to. */
    readonly appliesTo: readonly CommandContextKind[];

    /** Grouping key; renderers insert separators between groups. */
    readonly group: CommandGroup;

    /** Sort order within the group. */
    readonly order: number;

    /** Optional keyboard shortcut, e.g. 'ctrl+enter'. */
    readonly keybinding?: string;

    /** True for operations that destroy or overwrite data. Drives styling and confirmation. */
    readonly isDestructive?: boolean;

    /** Whether the command appears at all for this context. */
    isVisible(context: TContext): boolean;

    /** Whether it can be invoked, and if not, why not. */
    isEnabled(context: TContext): CommandEnablement;

    /** Performs the operation. Renderers do not implement behavior. */
    execute(context: TContext): Promise<void> | void;
}

/** Enablement carries its reason so disabled controls can explain themselves. */
export type CommandEnablement =
    | { readonly enabled: true; }
    | { readonly enabled: false; readonly reason: string; };
```

**Rules:**

1. **Visible-but-disabled beats hidden.** Hiding a command teaches the user it doesn't exist.
   Disabling it with `reason` surfaced as a tooltip teaches them *why*. Reserve `isVisible` for
   commands that are genuinely inapplicable (a document command on a database node), not for ones
   that are merely unavailable right now.
2. **`reason` is mandatory and user-facing.** "Connection is read-only", "No documents selected",
   "Not supported by this server". A disabled control with no explanation is the most common way a
   capable tool feels broken.
3. **Renderers contain zero behavior.** A toolbar button calls `command.execute(context)`. If a
   renderer needs a special case, the command's declaration is wrong.
4. **Adding a feature means adding a command.** Per the intent document, the registry is the *first*
   place to look. A feature that lives only in a dialog and never appears as a command is incomplete.
5. **Confirmation is declarative.** `isDestructive` drives the confirmation flow and the danger
   styling centrally — never per call site. See [Destructive actions](#destructive-actions).

**Context is a discriminated union**, so commands and renderers agree on what's selected:

```typescript
export type CommandContext =
    | { readonly kind: 'connection'; readonly connectionId: ObjectId; readonly state: ConnectionState; }
    | { readonly kind: 'database'; readonly connectionId: ObjectId; readonly databaseName: string; }
    | { readonly kind: 'collection'; readonly connectionId: ObjectId; readonly databaseName: string; readonly collectionName: string; readonly isReadOnly: boolean; }
    | { readonly kind: 'document'; readonly documentIds: readonly unknown[]; /* Target _ids: any BSON type */ }
    | { readonly kind: 'field'; readonly path: string; readonly value: unknown; readonly bsonType: BsonTypeName; }
    | { readonly kind: 'index'; readonly indexName: string; }
    | { readonly kind: 'queryResult'; readonly resultId: string; readonly selectedCount: number; };

export type CommandContextKind = CommandContext['kind'];
```

Note `documentIds: readonly unknown[]` — a Target Database `_id` is not an `ObjectId` and must not be
typed as one. See [project-standards.md](project-standards.md#backend-standards--target-database-context).

**Command groups** `[Judgment]` — fixed set, so ordering is consistent everywhere:

| Group | Contents |
|---|---|
| `open` | Open, open in new tab, open in view |
| `create` | Insert document, create collection, create index |
| `edit` | Edit, duplicate, rename |
| `clipboard` | Copy, copy as EJSON, copy field path, copy query |
| `query` | Filter by this value, use as filter, explain, add to pipeline |
| `transfer` | Export, import |
| `admin` | Indexes, validation rules, stats |
| `connection` | Connect, disconnect, refresh, edit connection |
| `destructive` | Delete, drop, delete many — **always last, always visually separated** |

### Context menus

Required on every selectable surface: connection nodes, database nodes, collection nodes, grid rows,
grid cells, field rows in the document tree, index rows, tab headers, and query-history entries.

- One shared `<app-context-menu>` wrapper over PrimeNG's `ContextMenu`, fed by
  `registry.commandsFor(context)`. No component builds its own `MenuItem[]`.
- `[Judgment]` **Right-click sets selection if the target isn't already selected**, then opens the
  menu — matching every file explorer ever shipped. Right-clicking inside an existing multi-selection
  preserves it.
- `[Judgment]` The same command list is reachable from an **overflow `pi-ellipsis-v` button** on hover
  for every row. Right-click alone is undiscoverable, and the intent document is explicit that
  features must be conspicuous.
- Submenus only for genuine hierarchy ("Copy as ▸ EJSON / JSON / CSV"). Never for grouping
  convenience.

### Toolbars

- One `<app-toolbar>` component, fed the same way. A toolbar is a filtered, ordered projection of the
  commands for the current context.
- `[Judgment]` Three toolbar tiers, so placement is predictable rather than per-screen:
  1. **Application toolbar** — connection selector, global refresh, settings, and the **AI mode
     switch** (see [AI Integration](#ai-integration--mcp-server)). Always present.
  2. **Context toolbar** — operations on the current collection or database. Below the tab strip.
  3. **Selection toolbar** — appears when a selection exists, showing selection-scoped commands and
     the count. `[Judgment]` Prefer this over a modal for bulk operations; it keeps the data visible
     while acting on it.
- Overflow collapses into a `pi-ellipsis-v` menu at narrow widths, driven by `PageSizeService`.
- Icon-only buttons **always** carry a tooltip with the label and keybinding. An unlabeled icon is not
  conspicuous.

### ◈ View Registry Pattern

"We will need to be able to have different views for different scenarios" and "avoid locking the
application into features like these" means views are **registered descriptors**, not a hard-coded
switch.

```typescript
/** A way of presenting a set of Target Database documents. */
export interface DocumentViewDescriptor {
    /** Stable identifier, e.g. 'table', 'json', 'list'. */
    readonly id: string;

    readonly label: string;
    readonly icon: string;
    readonly order: number;

    /** The component rendered for this view. */
    readonly component: Type<IDocumentView>;

    /** Whether this view can present the given context at all. */
    supports(context: CollectionViewContext): boolean;

    readonly capabilities: DocumentViewCapabilities;
}

/** What a view can do, so the shell can enable or disable surrounding controls. */
export interface DocumentViewCapabilities {
    /** Supports in-place editing of values. */
    readonly canEdit: boolean;
    /** Supports row/document selection. */
    readonly canSelect: boolean;
    /** Supports multi-selection. */
    readonly canMultiSelect: boolean;
    /** Virtualizes, and so tolerates large pages. */
    readonly virtualizes: boolean;
    /** Renders deeply nested documents without flattening. */
    readonly handlesNesting: boolean;
}
```

**Views to ship, in order:** `table` (phase 1), `json` (phase 1), `list` (phase 1),
`tree` (phase 3), `schema` (phase 4), `diff` `[Judgment]` (later — comparing two documents is a
recurring real need Compass handles poorly).

**Rules:**

1. **The shell owns data; views own presentation.** A view receives documents as an input signal and
   emits intent (`selectionChange`, `editRequested`, `commandInvoked`). A view never calls an API
   client, never paginates, never queries. This is what keeps views cheap to add — the expensive part
   is already solved once.
2. **Views are swappable without losing state.** Filter, sort, projection, pagination, and selection
   live in the shell's `CollectionViewState`, not inside the view. Switching table → JSON keeps the
   same page and the same selection. `[Judgment]` This is the difference between a view switcher that
   feels like a lens and one that feels like a reload.
3. **View choice persists per collection**, in the Application Database, keyed by
   connection + database + collection. Someone who always wants JSON for one collection shouldn't
   re-choose it. `[Judgment]`
4. **Capabilities drive the surrounding chrome.** The shell disables edit commands when
   `canEdit === false`, with `reason: 'This view is read-only'`.
5. **No view is privileged.** The table view is the default, not the base class. Nothing in the shell
   may assume rows and columns.

### Grids and cell content

The intent document specifically requires that cells host widgets and buttons. That means cell
rendering is also a registry, not a template with a `@switch`.

```typescript
/** Renders a single field value inside a grid cell. */
export interface ICellRenderer {
    readonly id: string;
    /** Higher wins when several renderers match. */
    readonly priority: number;
    /** Whether this renderer handles the given value. */
    matches(value: unknown, field: FieldDescriptor): boolean;
    readonly component: Type<ICellRendererComponent>;
}
```

**Renderers to ship** `[Judgment]`, priority order:

| Renderer | Handles | In-cell affordance |
|---|---|---|
| `objectid` | `ObjectId` | copy button; "find references" if a related collection is detectable |
| `date` | `Date`, `Timestamp` | localized display, absolute value on hover, copy ISO |
| `boolean` | `Boolean` | real checkbox, editable in place |
| `number` | `Int32`, `Long`, `Double`, `Decimal128` | right-aligned, type badge where lossy |
| `binary` | `Binary`, `UUID` | size + subtype summary, expand button, never raw bytes inline |
| `subdocument` | nested objects | field-count summary, expand-in-drawer button |
| `array` | arrays | length badge, expand button, first-element preview |
| `null` | `null` vs absent | **visually distinct from a missing field** — this distinction is data |
| `string-long` | strings over ~120 chars | truncated with an expand button |
| `string` | fallback | plain text, editable in place |

Two of these matter more than they look:

- **`null` vs absent must be visually distinct.** In MongoDB they are different, and the app must never
  imply otherwise. `[Judgment]` `null` renders as a dimmed `null` literal; an absent field renders as
  an empty cell with a subtly different background. Both get a tooltip stating which they are.
- **`binary` must never dump bytes into a cell.** It destroys the grid and helps no one.

**Grid requirements:**

- Virtualized rows from day one. `[Judgment]` Assume the table view meets a 1,000-document page and a
  200-key document; both are ordinary in real databases.
- Columns are **derived from a sample, not assumed** — schemaless data means the column set is a
  hypothesis. Show a "fields seen in N of M sampled documents" affordance so the user knows the column
  list is inferred.
- Column show/hide/reorder/pin, persisted per collection alongside view choice.
- Cell selection distinct from row selection — field-scoped commands ("filter by this value") need a
  cell context.

### Inline editing and BSON fidelity

- Editing a value **never changes its BSON type implicitly.** The type is shown, and changing it is a
  deliberate act via a type selector. A string that looks numeric stays a string.
- Edits are staged and **applied explicitly**, not on blur. `[Judgment]` A grid that writes to a
  production database on focus-loss is a hazard, not a convenience. Show a pending-changes count in
  the selection toolbar with Apply and Revert commands.
- The JSON view edits Extended JSON directly in Monaco, with schema-free syntax validation and a
  clear parse-error state. Round-tripping is verified against `EJSON` before the save command enables.
- `[Judgment]` Every write shows what it will do before doing it — the generated filter and update
  document. This is both a safety feature and the best MongoDB teaching tool in the app.

### Destructive actions

Centralized, declarative, never per-call-site:

- `isDestructive` commands render in the `destructive` group, visually separated, in the danger token
  color.
- Confirmation tiers `[Judgment]`:
  - **Single document delete** — inline confirm, undoable within the session where feasible.
  - **Bulk delete / update many** — modal stating the exact affected count, obtained by a real
    `countDocuments` first, not an estimate.
  - **Drop collection / drop database** — modal requiring the user to **type the name**.
- A read-only Connection disables all of them at the registry level with
  `reason: 'This connection is marked read-only'`. Enforced again server-side —
  the disabled button is UX, not the control.

### Loading, empty, and error states

"UI is a first class citizen" applies most to the states that are usually afterthoughts. Every data
surface has four defined states, and they are components, not `*ngIf` fragments:

| State | Requirement |
|---|---|
| Loading | Skeleton matching the eventual layout, not a spinner over blankness. Cancellable when the underlying query is. |
| Empty | Distinguish *no documents in this collection* from *no documents matched your filter* — the second offers "clear filter". |
| Error | The driver's actual message (post-redaction), the operation attempted, and a retry command. Never "Something went wrong". |
| Partial | Explicit when results were capped or timed out: *"Showing first 1,000 of an unknown total — the query hit the page cap."* Silent truncation reads as completeness. |

The Partial state is not optional. Bounded queries are mandatory per the standards, which means
truncation is routine, which means hiding it would make the tool lie regularly.

### Keyboard

Shortcuts are a command-registry projection — `keybinding` on the declaration, one host resolving them.

`[Judgment]` Reserved bindings: `Ctrl+Enter` run query · `Ctrl+S` apply staged edits ·
`Ctrl+R` refresh · `Ctrl+F` focus filter · `Ctrl+Shift+F` focus find-in-results ·
`Delete` delete selection (with confirmation) · `Ctrl+C` copy selection as EJSON ·
`Escape` cancel edit / close drawer · `F2` edit cell · `Ctrl+K` command palette ·
`Ctrl+Shift+A` toggle AI mode Collaborate ↔ Observe · `Ctrl+Shift+Z` undo the last AI-originated
UI change · `Ctrl+Shift+P` focus the pipeline builder · `Ctrl+Backtick` focus the shell.

The two `Ctrl+Shift` AI bindings are deliberately reachable without leaving the keyboard — a lock the
user has to go find with the mouse is a lock they won't reach in time.

`[Judgment]` A **command palette** (`Ctrl+K`) is nearly free once the registry exists — it's a fifth
renderer over the same data — and it's the best possible answer to "features must be conspicuous."
Schedule it as soon as the registry has real content.

---

### Icons

Use PrimeNG's icons and/or FontAwesome's icons for UI usage.

Use common icons for common applications.

#### Engineering expansion — canonical icon map

Icons are declared **only** on command and view descriptors. No component hard-codes an icon class;
that's how the same operation ends up with three different glyphs.

`[Judgment]` PrimeIcons is the default (it ships with PrimeNG and matches its visual weight);
FontAwesome fills gaps. **Verify each name against the installed PrimeIcons version during Phase 0** —
the set changes between releases, and a wrong class renders as nothing at all, silently.

**Objects**

| Concept | Icon |
|---|---|
| Connection / server | `pi pi-server` |
| Target Database | `pi pi-database` |
| Collection | `pi pi-table` |
| Document | `pi pi-file` |
| Field | `pi pi-tag` |
| Index | `pi pi-sort-alt` |
| Database user / role | `pi pi-users` / `pi pi-shield` |
| Aggregation pipeline | `pi pi-sitemap` |

**Operations** — one glyph per concept, application-wide

| Operation | Icon |
|---|---|
| Connect / disconnect | `pi pi-sign-in` / `pi pi-sign-out` |
| Refresh | `pi pi-refresh` |
| Create / insert | `pi pi-plus` |
| Edit | `pi pi-pencil` |
| Duplicate | `pi pi-clone` |
| Copy | `pi pi-copy` |
| Delete / drop | `pi pi-trash` |
| Filter | `pi pi-filter` |
| Search / find | `pi pi-search` |
| Run query | `pi pi-play` |
| Explain plan | `pi pi-bolt` |
| Export / import | `pi pi-download` / `pi pi-upload` |
| Query history | `pi pi-history` |
| Saved query | `pi pi-bookmark` |
| Settings | `pi pi-cog` |
| Overflow menu | `pi pi-ellipsis-v` |
| Expand / collapse | `pi pi-chevron-right` / `pi pi-chevron-down` |

**Views**

| View | Icon |
|---|---|
| Table | `pi pi-table` |
| JSON | `pi pi-code` |
| List | `pi pi-list` |
| Tree | `pi pi-sitemap` |
| Schema | `pi pi-chart-bar` |

**Status**

| State | Icon |
|---|---|
| Connected | `pi pi-check-circle` |
| Connecting / refreshing | `pi pi-spin pi-spinner` |
| Awaiting user action (device code, consent) | `pi pi-external-link` |
| Credential expiring | `pi pi-clock` |
| Auth failed | `pi pi-lock` |
| Read-only connection | `pi pi-ban` |
| Warning | `pi pi-exclamation-triangle` |
| Destructive | `pi pi-trash` |

**Pipeline, shell, and AI**

| Concept | Icon |
|---|---|
| Aggregation pipeline / builder | `pi pi-sitemap` |
| Pipeline stage | `pi pi-circle-fill` (small) |
| Stage enabled / disabled | `pi pi-eye` / `pi pi-eye-slash` |
| Preview stage output | `pi pi-search-plus` |
| Mongo shell | `pi pi-terminal` |
| Run shell command | `pi pi-play` |
| AI mode — Collaborate | `pi pi-sparkles` |
| AI mode — Observe | `pi pi-eye` |
| AI mode — Off | `pi pi-ban` |
| Pending proposals | `pi pi-inbox` |
| Proposal apply / reject | `pi pi-check` / `pi pi-times` |
| AI-originated change (attribution badge) | `pi pi-sparkles` |
| Activity log | `pi pi-history` |

`[Judgment]` Status icons carry a color token *and* a distinct shape — never color alone. Connection
state is the most important signal in the app and it must survive a colorblind user and a bad monitor.
The same rule applies to the AI mode indicator and the AI-attribution badge — "did a human do this"
must be legible without color.

---

## Aggregation Pipeline Builder

A robust pipeline tool is a headline feature, not a convenience. It is where a MongoDB power user
actually spends their time, and it is where Compass is strongest — so parity here is table stakes.

### Structure

The pipeline is a **list of addressable stages**, never a single blob of text that happens to parse.
Everything else follows from that:

```typescript
/** One stage of an aggregation pipeline in the builder. */
export interface PipelineStage {
    /** Stable id, so edits and previews survive reordering. */
    readonly id: string;
    /** Operator name including the dollar sign, e.g. '$match'. */
    readonly operator: string;
    /** Stage body as Extended JSON text — the user's literal input, not a reformat. */
    readonly body: string;
    /** Disabled stages are skipped but retained. */
    readonly isEnabled: boolean;
    /** Free-text note, saved with the pipeline. */
    readonly comment?: string;
}

/** Full builder state. Mirrored to the MCP session state. */
export interface PipelineBuilderState {
    readonly connectionId: ObjectId;
    readonly databaseName: string;
    readonly collectionName: string;
    readonly stages: readonly PipelineStage[];
    readonly mode: 'stages' | 'text';
    /** True when the pipeline contains $out or $merge. */
    readonly hasWriteStage: boolean;
    readonly isDirty: boolean;
}
```

### Requirements

- **Per-stage editing** in Monaco, with Extended JSON validation and operator-aware completion.
- **Per-stage output preview.** Running the prefix up to stage *N* and showing the result is the single
  most valuable feature in the whole tool — it turns pipeline authoring from guesswork into iteration.
- **Enable/disable a stage without deleting it.** Bisecting a broken pipeline is the normal debugging
  method, and deleting to test is how people lose work.
- **Drag to reorder**, with previews invalidating downstream of the moved stage only.
- **Stage palette** listing operators grouped by purpose, with a one-line description and an insertable
  skeleton. `[Judgment]` Discovery matters more here than anywhere else in the app — most users know
  six operators and need the seventh.
- **Text mode ↔ stage mode**, round-trippable. Power users paste a whole pipeline from somewhere else;
  they must not be forced through a form to do it. `[Judgment]` Round-trip fidelity is a hard
  requirement: paste, switch to stages, switch back, and the text must be semantically identical.
  Comments and formatting may normalize; semantics may not.
- **Explain integration** per pipeline, surfacing index usage per stage.
- **Save and load named pipelines** to the Application Database, scoped to a collection.
- **Export as code** — Node driver, `mongosh`, Python. Cheap to implement, disproportionately useful.
- **Promote to shell** — send the pipeline to the [Mongo Shell](#mongo-shell) as a runnable command.
- Results render through the **View Registry**, so a pipeline result is viewable as a table, JSON, or
  list like any other document set. `[Judgment]` No bespoke result grid — that is exactly the lock-in
  the intent document warns against.

### Previews are previews

- A preview appends a `$limit` to the previewed prefix and carries `maxTimeMS`. It is **labeled as a
  preview**, with the sample size shown.
- A preview count is **never** presented as a result count. This is the Partial-state rule from
  [Loading, empty, and error states](#loading-empty-and-error-states), and pipelines are where it gets
  violated most easily.
- `[Judgment]` Preview sample size is user-adjustable with a sane default (100), because the right value
  depends entirely on the stage — `$match` needs volume, `$group` needs correctness.

### `$out` and `$merge` are writes

A pipeline containing `$out` or `$merge` **writes to a collection.** It looks like a read operation and
it is not, and this is the most likely way a safety model gets accidentally circumvented.

- The builder detects write stages **structurally**, on the parsed pipeline — not by string matching.
- `hasWriteStage` drives destructive styling on the Run command, and the confirmation names the target
  collection explicitly.
- Preview and explain **refuse** a pipeline containing a write stage; there is no safe partial run.
- A read-only Connection disables Run entirely for such a pipeline.
- Claude may compose one but never execute one. See
  [mcp-server-spec.md](mcp-server-spec.md#aggregation-pipeline).

---

## Mongo Shell

Per intent: execute commands against the Target Database through the Mongo CLI, with its own UI and
interactivity.

### Two tiers, and why

`[Judgment]` Shipping one shell would force a bad trade. Two tiers with different guarantees is the
better answer:

| | **Tier A — Command runner** | **Tier B — Full `mongosh`** |
|---|---|---|
| Mechanism | `db.runCommand()` over the existing `LiveConnection` | Real `mongosh` — child process initially, embedded worker later |
| Auth | **Reuses the app's connection**, including OIDC | Needs its own connection |
| Semantics | Structured commands only | Full JavaScript, cursors, helpers |
| Classifiable as read-only | **Yes**, by command name against an allowlist | **No** — undecidable |
| Available to Claude | Read-only commands execute directly | Never executes; input buffer and proposals only |
| Phase | 5 (with the shell UI) | 6 |

**Tier A comes first, and it is not a stopgap.** It reuses the exact auth path that is the entire point
of this project — which means the shell works against Azure vCore over OIDC on day one, with no second
credential flow. Most real shell usage is `runCommand`-shaped anyway: `collStats`, `explain`,
`serverStatus`, `listIndexes`, `currentOp`.

**Tier B's honest limitation:** a `mongosh` subprocess cannot share our `LiveConnection`, so it
re-authenticates independently. For a connection-string or SCRAM Connection that is trivial. **For an
OIDC Connection it is a real problem** — the token lives in our process, and handing it to a subprocess
is either impossible or unwise depending on how `mongosh` accepts it. Record this as a known limitation
rather than discovering it in Phase 6: Tier B may simply be unavailable for OIDC Connections, and
Tier A may be the only shell those clusters get. That is an acceptable outcome and worth stating up
front.

### UI

- **Transcript pane** — an append-only log of entries, each with input, timing, and result. Not a
  terminal emulator; a structured, addressable list.
- **Monaco input** with multi-line editing, history navigation, and completion over database and
  collection names from the live connection.
- **Results render through the View Registry.** A shell result that returns documents is viewable as a
  table or JSON like anything else. `[Judgment]` This is a significant advantage over a real terminal
  and the main reason to build a shell UI rather than telling people to open a console.
- **Per-entry commands**, in the registry: re-run, copy input, copy result as EJSON, promote to
  pipeline, promote to a filter in the current view, explain this.
- **Danger treatment.** Tier B can do anything, including `db.dropDatabase()`. `[Judgment]` On a
  read-only Connection, Tier B is **disabled entirely** rather than filtered — we cannot classify
  arbitrary JavaScript, and pretending we can would be worse than refusing.
- Long-running commands are cancellable, with `maxTimeMS` applied by default and shown in the entry.

### Claude in the shell

Summarized here; the full contract is in
[mcp-server-spec.md § Shell access through MCP](mcp-server-spec.md#shell-access-through-mcp):

- Reads the transcript and results freely.
- Executes **Tier A classified read-only commands** directly — that is reading.
- Writes into the **input buffer** for Tier B, and the user presses Enter.
- Stages a proposal for anything else.

---

## AI Integration — MCP Server

Full specification: **[mcp-server-spec.md](mcp-server-spec.md)**. Summarized here because it changes
the UI in ways that must be designed alongside everything else.

### The shape of it

Mongo Explorer hosts an MCP server so Claude can read the Target Database, see what the user is
looking at, drive the UI, compose pipelines, draft shell commands, and **propose** data changes.

> **Claude never writes to a Target Database. Only the user executes data changes.**

This is structural, not configurable: no MCP tool performs a write, and every write path in
`src/explorer/**` refuses a non-user actor at the lowest level. There is no `apply_proposal` tool and
there must never be one.

### The MCP surface is a projection of the command registry

MCP is the **fifth renderer** over the same [Command Registry](#-command-registry-pattern) that feeds
context menus, toolbars, keybindings, and cell buttons:

```
                      ┌──► ContextMenuHost      (right-click)
                      ├──► ToolbarHost          (toolbars)
AppCommand ──► Registry ──► KeybindingHost      (shortcuts)
                      ├──► CellActionHost       (in-cell buttons)
                      └──► McpToolHost          (Claude)   ← same declarations
```

`[Judgment]` This is the whole reason the registry was worth building. Without it, MCP would be a
parallel implementation of every operation, drifting from the UI immediately. With it, exposing an
operation to Claude is a **classification on the existing declaration**, not new code:

```typescript
/** How a command is exposed over MCP. Declared on the command itself. */
export interface CommandMcpExposure {
    /** Omit to keep a command out of the MCP surface entirely. */
    readonly toolName?: string;
    /** read: executes freely. ui: gated by MCP mode. propose: stages for the user only. */
    readonly classification: 'read' | 'ui' | 'propose' | 'never';
    /** JSON Schema for the tool's arguments. */
    readonly inputSchema?: object;
}
```

`classification: 'never'` is the default for anything that writes. A command whose `execute` touches a
Target Database write path and declares anything other than `'never'` or `'propose'` is a bug the CI
check in [mcp-server-spec.md](mcp-server-spec.md#-actor-gated-write-path) catches.

### UI elements this adds

Three new first-class surfaces:

#### 1. The AI mode switch

A segmented control in the **application toolbar**, permanently visible — never in a settings dialog.
Per intent: an obvious switch that blocks or enables the MCP from changing user elements.

| Mode | Read app state | Read Target DB | Change UI | Stage proposals | Execute data changes |
|---|---|---|---|---|---|
| **Off** | — | — | — | — | **never** |
| **Observe** | yes | yes | — | yes | **never** |
| **Collaborate** *(default)* | yes | yes | yes | yes | **never** |

- Distinct icon **and** color per mode, with a tooltip naming exactly what is currently permitted.
- `Ctrl+Shift+A` toggles Collaborate ↔ Observe, so it can be hit instantly mid-thought.
- Enforced server-side. A client that mis-renders the switch cannot widen what Claude may do.
- `[Judgment]` Drops to `Observe` automatically when the active Connection is read-only.

#### 2. The Proposals panel

A persistent, collapsible panel with a badge count, reachable from anywhere.

- Each proposal renders as a **diff using the existing cell renderers** — same `null`-vs-absent
  distinction, same BSON badges. A proposal is reviewed with the same tools as the data.
- Every proposal carries a mandatory plain-language **summary**, a **rationale**, a real
  **affected-count**, and its **reversibility**.
- Commands per proposal: apply, reject, **edit**, explain, copy as shell command, copy as driver code.
- **Apply is never the default focused action.** No Enter-key accidents.
- `[Judgment]` **Edit** is the most valuable command here. "Almost right" is an AI's most common output,
  and converting a proposal into a user-authored staged change beats regenerating it.
- Bulk and drop proposals require the same typed confirmation a user-authored one would. AI authorship
  earns no shortcuts and no extra obstacles.

#### 3. Attribution and the activity log

The mode switch answers *"stop entirely."* It does not answer the subtler fear — *Claude overwrites what
I was in the middle of doing.* Three mechanisms do:

- **◈ Dirty-State Veto.** Any MCP mutation that would discard uncommitted user work **fails**, with a
  structured error naming exactly what is dirty so Claude can ask instead of guessing. `[Judgment]` Not
  overridable by a `force` flag — a force flag would be used, and then used by default.
- **Attribution.** Every AI-originated change carries a badge on the affected control and an activity
  log entry. The user can always answer "did I do that?"
- **Undo.** Every MCP-originated UI change is individually reversible from the log; `Ctrl+Shift+Z`
  reverts the most recent. UI state is cheap to invert — there is no excuse for a one-way door.

### Staged edits are the shared surface

Claude's proposals land in **the same staging buffer** as the user's own edits — the pending-changes
mechanism from [Inline editing and BSON fidelity](#inline-editing-and-bson-fidelity). Claude is not a
special code path; it is another editor of the same staged state, and the Apply button was always going
to be the user's.

That is the cleanest expression of the whole model: the app already required humans to apply their edits
explicitly. Extending that to an AI required a permission gate and an attribution trail, not a new
architecture.

---

## Extensibility — what must stay open

The intent document is explicit that interaction and grid work is iterative and must not lock the
application in. Concretely, these five seams stay open, and a change that closes one is a design
regression:

1. **Commands** — a new operation is a new `AppCommand` registration. It appears in context menus,
   toolbars, the palette, and keybindings with no renderer changes.
2. **Views** — a new view is a `DocumentViewDescriptor` plus a component implementing `IDocumentView`.
   No shell changes, no `switch` to extend.
3. **Cell renderers** — a new type affordance is an `ICellRenderer` registration.
4. **Connection strategies** — a new auth mechanism is an `IConnectionStrategy` implementation. See
   [connection-and-auth.md](connection-and-auth.md).
5. **Explorer services** — a new Target Database capability is a service taking a `LiveConnection`.

**Anti-patterns that close these seams**, called out so they're recognizable in review:

- A `switch (viewId)` anywhere in the shell.
- A context menu component building its own `MenuItem[]`.
- A toolbar button with an `onClick` containing logic instead of `command.execute()`.
- A cell template with a chain of `@if` on BSON type.
- A component importing `MongoHelper`, or an `explorer/` service importing a connection string.
- **An MCP tool that implements an operation instead of dispatching a registered command.** That is the
  parallel implementation the registry exists to prevent, and it will drift from the UI within weeks.
- A bespoke result grid for pipeline or shell output instead of the View Registry.

---

## Consequences for other documents

Recorded here rather than silently propagated:

| Document | Change |
|---|---|
| [open-questions.md](open-questions.md) | Q2 (app user model) is **resolved**: single-user, no scoping. Q5 (SSO-through) is narrowed — with a localhost redirect available, auth-code + PKCE is the default rather than device code. New: MCP endpoint auth deferred on loopback-only grounds; revisit if the app ever becomes non-local. |
| [project-standards.md](project-standards.md) | "Internal DB" / "Target DB" remain valid as section annotations; `TargetDatabase` and `ApplicationDatabase` are the code identifiers. **Add the actor-gated write rule** — every Target Database write takes an `OperationActor` and refuses non-user actors. |
| [architecture.md](architecture.md) | Add `serverConfig.bindAddress` (`127.0.0.1`) to config. The client shell gains the command registry, view registry, and cell-renderer registry as named subsystems. Server gains `src/mcp/`. |
| [feature-scope.md](feature-scope.md) | Phase 1 gains the command registry and view registry — foundational, not polish. Pipeline builder, shell, and MCP get their own phases. |
| [mcp-server-spec.md](mcp-server-spec.md) | New document. The full MCP contract, enforcement layers, tool surface, and proposal lifecycle. |

---

## Deliberately deferred

- Multi-user, remote hosting, and anything that follows from them.
- Theming beyond light/dark via the existing design tokens.
- A plugin API for third parties. The registries are internal extension points, not a public surface.
- Undo/redo as a general framework for *data* operations. Per-operation undo where cheap; no
  command-pattern history stack until something demands it. **UI-state undo is not deferred** — it is
  required for AI attribution.
- MCP **prompts** and **sampling**. Tools and resources first; there is no evidence yet that either
  earns its complexity here.
- MCP **elicitation** for confirming data changes. `[Judgment]` Deliberately rejected, not deferred:
  confirmation belongs in the app where the data and the diff are visible, not in a chat transcript
  where the user is reading prose about their database instead of looking at it.
