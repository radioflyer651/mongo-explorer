# CLAUDE.md — mongo-explorer-client

Angular frontend for **Mongo Explorer**.

## Stack

Angular 22 · **zoneless** (`provideZonelessChangeDetection()`, no zone.js polyfill) · PrimeNG 22 +
PrimeIcons · Bootstrap (layout utilities only) · SCSS · RxJS **in services** · **signals** in
components · socket.io-client · `bson` for Extended JSON

⚠ **PrimeNG 22 is licensed, not MIT.** Without a key it draws an "Invalid PrimeUI License" banner on
every page. This project qualifies for the free Community licence; the key goes in
`primeUiLicenseKey` in both environment files and is already plumbed to `providePrimeNG`. See
[PRIME-LICENSE.md](PRIME-LICENSE.md). Do not suppress the banner — it is the only warning that the
key has expired, and the licence forbids removing its mechanisms.

## Running

**F5** in this project runs `ng serve`, waits for it to actually be listening, then opens a browser
with the debugger attached — see [.vscode/launch.json](.vscode/launch.json). Breakpoints work directly
in `.ts` files. The workspace file has a *server + client* compound that starts both.

```bash
npm start                    # ng serve, port 27100
npm run build                # production build
npx ng build --configuration development
```

Dev server binds IPv6 `localhost:27100`; the server's CORS allows both `localhost` and `127.0.0.1`.
The server must be running on `127.0.0.1:27050`.

## Component rules

- Extend `ComponentBase`, call `super()`, constructor first.
- Separate `.html` and `.scss` files. No inline templates.
- **Consume state as signals, not subscriptions.** Bridge service observables with `toSignal(...)` in
  the constructor. Hold async-set view state in `signal()`; derive with `computed()`.
- Subscriptions are for imperative work only, and always pipe `takeUntil(this.ngDestroy$)`. Never call
  `.unsubscribe()`.
- **Never call `HttpClient` directly.** Components use services; services use API clients.
- Reference `--color-*` tokens from [src/styles.scss](src/styles.scss). Hard-coded colours are an
  anti-pattern.

## ⚠ The three registries — do not bypass them

Everything interactive is a projection of a registry. A `switch` on a view id, a component building its
own `MenuItem[]`, or a chain of `@if` on BSON type is a design regression.

| Registry | Add a feature by | Files |
|---|---|---|
| **◈ Commands** | Registering an `AppCommand` | [src/app/core/commands/](src/app/core/commands/) |
| **◈ Views** | A `DocumentViewDescriptor` + component | [src/app/core/views/](src/app/core/views/) |
| **◈ Cell renderers** | An `ICellRenderer` | [src/app/core/cells/](src/app/core/cells/) |

Commands are declared **once** in
[command-registrations.ts](src/app/core/commands/command-registrations.ts) and rendered by the toolbar,
the context menu, keyboard shortcuts, in-cell buttons, **and the MCP tool surface**. That is what stops
an AI's capabilities drifting from the interface's.

Command rules:
- **Visible-but-disabled beats hidden.** `isVisible` is for genuinely inapplicable commands only.
- **`isEnabled` must return a reason when disabled** — it is surfaced as a tooltip. A disabled control
  that won't say why is how a capable tool comes to feel broken.
- Renderers contain **no behaviour**. They call `execute`.
- A context is only useful if commands apply to it. Adding a right-click target with **no registered
  commands for its `kind`** produces a menu that opens empty and so appears broken.

### Raising a context menu

There is **one** `<app-command-menu>`, in the shell, and it renders
[context-menu.service.ts](src/app/core/commands/context-menu.service.ts). Surfaces call
`contextMenu.openAt(context, event)`; nothing else. A component that keeps its own `menuRequest`
signal raises menus nobody renders — right-click and every `...` button silently did nothing for
exactly this reason.

## ⚠ AI integration

[ai-session.service.ts](src/app/services/ai-session.service.ts) publishes interface state to the server
and applies MCP-originated mutations **by dispatching registered commands** — the same path a menu item
takes. An AI is not a special code path.

- The **AI mode switch** ([ai-mode-switch](src/app/components/ai/ai-mode-switch/)) is a permanent
  toolbar fixture, never in a settings dialog.
- The **Proposals panel** ([proposals-panel](src/app/components/ai/proposals-panel/)) is where the user
  applies a change. Apply is never the default focused action; bulk and drop require typing the
  collection name.
- Unsaved work is reported as `dirtyRegions` so the server can veto any AI mutation that would discard
  it. Staged edits live in [workspace.service.ts](src/app/services/workspace.service.ts) — the same
  buffer a human's edits use.

## Things that will bite

- **A Target Database `_id` is not an `ObjectId`.** It can be any BSON type. `src/types/mongodb.d.ts`
  aliases `ObjectId` to `string` for **our** entity ids only.
- **`null` and absent are different** and render differently
  ([null-cell](src/app/components/cells/null-cell/)). That distinction is data.
- **Use Extended JSON**, not `JSON.parse`, for anything carrying document data —
  [ejson.util.ts](src/app/core/ejson.util.ts).
- **Partial results must be shown as partial.** Bounded queries make truncation routine.
- View state lives in the **shell** (`WorkspaceService`), not inside a view, so switching views keeps
  the page and selection.
- Zoneless means nothing outside a signal or an event triggers change detection. Writing to a plain
  field will not re-render.
- **`computed()` over a non-signal never updates.** `computed(() => service.someGetter)` has nothing
  to depend on, so it evaluates once and caches that value forever. Bridge the observable instead:
  `toSignal(service.something$, { initialValue: undefined })`. This silently hid the whole database
  tree behind an `@if` that was permanently false.
- **`*ngComponentOutlet` cannot bind outputs.** It supports `Inputs`, `Injector`, `Content`,
  `NgModule`, `EnvironmentInjector` — there is no `Outputs`. Binding one throws NG0303 at runtime and
  every event the dynamic component emits is dropped. Registry-rendered components are therefore
  created with `ViewContainerRef.createComponent` and their outputs subscribed by hand — see
  [view-host.component.ts](src/app/components/views/view-host/view-host.component.ts).
- **`[class.is-disabled]` disables nothing.** It is styling. Without `[disabled]` the button still
  fires, and the handler must guard too — a keyboard shortcut or an MCP-dispatched command reaches it
  without going near the button. The two command renderers are the deliberate exception: they stay
  clickable so `invoke` can surface the *reason* instead of doing nothing.

## Verifying the interface

`node scripts/verify-ui.ts` (from the workspace root, with both halves running) drives the real UI
with real pointer events and asserts each interaction did something. **Run it after touching anything
in the interaction path.** Every bug listed above compiled and served cleanly while doing nothing on
click, so the build passing is not evidence.

## Folder map

```
src/
├── app/
│   ├── core/            # commands, views, cells registries · icons · ejson helpers
│   ├── components/
│   │   ├── component-base/ · commands/ · cells/ · views/
│   │   ├── connections/ · explorer/ · pipeline/ · shell/ · ai/
│   ├── services/        # workspace, connection-state, ai-session, explorer/
│   │   └── explorer/api-clients/
│   ├── app.ts · app.config.ts · app.routes.ts
├── model/shared-models/ # AUTO-COPIED from the server. Never edit here.
├── environments/ · types/
└── styles.scss · layout.scss · buttons.scss
```

## Shared models

`src/model/shared-models/` is a **verbatim copy** of the server's. Every file carries a banner saying
so. **Never edit these here** — change the server, then run from the workspace root:

```bash
node scripts/sync-shared-models.ts
```

## Icons

Declared only in [src/app/core/icons.ts](src/app/core/icons.ts) and referenced from command and view
descriptors. No component hard-codes an icon class.
