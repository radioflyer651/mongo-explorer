# Project Standards — Mongo Explorer

## Status of this document

**This document is authoritative and self-contained.** It is the playbook for Mongo Explorer. Read it
here; do not go looking for a canonical copy elsewhere.

**Lineage:** incorporated from `E:\development\multi-chat\workspace\project-standards.md`
(2026-07-29), which is the current form of the shared playbook. It supersedes the older copy bundled
with the `mean-stack-project-setup` skill reference, which is **stale** on two counts — see
[Divergences from the setup-skill reference](#divergences-from-the-setup-skill-reference) at the end.

Earlier I argued against keeping a local copy, on the grounds that it would drift. That reasoning was
wrong for this project, for two reasons: the *reference* had already drifted, and this repo is moving
to a different machine where an absolute path into a sibling project won't resolve. Self-contained
wins.

---

## ⚠ Two MongoDB contexts — read this before anything else

Mongo Explorer uses MongoDB **and** operates on MongoDB. These are completely different things
governed by completely different rules, and conflating them is the single most damaging mistake
available in this codebase.

| | **Internal DB** | **Target DB** |
|---|---|---|
| Also called | app database, metadata DB, our store | subject database, target cluster, the user's cluster |
| What it is | Mongo Explorer's own persistence: users, saved connections, preferences, logs | Whatever database the user connected to and is exploring |
| Who owns the schema | We do. Known, versioned, typed. | Nobody. Arbitrary, unknown, schemaless. |
| How many | Exactly one, fixed at startup | Zero to many, created at runtime by user action |
| Trust | Trusted | Untrusted data, untrusted shapes, possibly production |
| Access path | `MongoHelper` → `DbService` → per-entity DB services | `ConnectionManager` → `LiveConnection` → `explorer/` services |
| Server folders | `src/database/`, `src/mongo-helper.ts` | `src/connections/`, `src/explorer/` |
| Standards | The whole **Backend Standards** playbook applies verbatim | **Different rules.** See [Target Database Context](#backend-standards--target-database-context) |

**Whenever this document says "MongoDB," "the database," `MongoHelper`, `DbService`, `ObjectId`, or
`shared-models` entity interfaces, it means the Internal DB** unless a section explicitly says
otherwise. Sections are tagged `[Internal DB]` or `[Target DB]` wherever it could be in doubt.

The rules that look like harmless conveniences on the internal side and are **data-corrupting** on the
target side:

| Convenience | Fine for Internal DB | Wrong for Target DB |
|---|---|---|
| `nullToUndefined` at the boundary | Yes — our schemas don't use `null` meaningfully | **No.** `null` is a real BSON value, distinct from an absent field. Collapsing them silently rewrites the user's document. |
| ObjectId ↔ hex-string conversion middleware | Yes — our IDs are all `ObjectId` | **No.** It would walk a user's document and mutate any field that *looks* like a hex ObjectId. Use Extended JSON instead. |
| `ObjectId` as the type of `_id` | Yes — always true for our entities | **No.** A target `_id` can be a string, number, date, subdocument — anything. |
| Collection-name constants | Yes — our collections are fixed | **No.** Target collection names *are* user data. |
| Typed entity interfaces | Yes | **No.** Target documents have no compile-time shape. |
| Binding services as container singletons | Yes | **No.** A target-side service is scoped to a `LiveConnection`, not to the process. |

---

## Workspace & Project Layout

### Multi-project workspace

Related projects live as sibling folders under one workspace root, opened together via a VS Code
`.code-workspace` file:

```
mongo-explorer/
├── mongo-explorer.code-workspace   # { folders: [client, server, workspace, scripts] }
├── mongo-explorer-client/          # Angular frontend
├── mongo-explorer-server/          # Node/Express backend
├── workspace/                      # planning docs, design notes, research — no runnable code
└── scripts/                        # repeatable dev/ops scripts
```

The `workspace/` folder is for plans, analyses, and reference documents. Code does not live there.

### Ports

Memorable, **non-default** ports, to avoid collisions with other tooling and other projects:

| Service | Port | Configured in |
|---|---|---|
| Angular dev server | `27100` | `angular.json` → `serve.configurations.development.port` |
| Express / Socket.IO | `2701` | `app-config.json` → `serverConfig.port`, env-var overridable |

Both echo MongoDB's `27017`. Neither is a default (`4200`), and neither collides with d-talk's
`54647` / `1062` or multi-chat's ports.

### Environment & config files

- **Frontend:** two files in `src/environments/` — `environment.ts` (production) and
  `environment.development.ts` (dev). Wire the swap in `angular.json` under
  `build.configurations.development.fileReplacements`.
- **Backend:** a single `app-config.json` at the project root, **gitignored**, loaded once at startup,
  cached, and overrideable per-leaf by environment variables (see [Config loading](#config-loading)).
  Document the schema in `APP-CONFIG.md` with placeholder example values.
- Never commit secrets. Template config uses placeholders like `<your-jwt-secret>`.
- **Internal DB `[Internal DB]`** — the shared MongoDB instance is at **`mongo.fingercraft.com:27017`**.
  Mongo Explorer's own database name is `mongo-explorer`:
  ```json
  "mongo": {
      "connectionString": "mongodb://mongo.fingercraft.com:27017",
      "databaseName": "mongo-explorer"
  }
  ```
  This is our store. It is **not** a database the user browses, and it must never appear in the
  connection list by default.

---

## Cross-Cutting Code Standards

These rules apply to **both** client and server TypeScript.

### TypeScript style rules

- **Strict mode** is on: `strict: true`, `noImplicitOverride`, `noImplicitReturns`,
  `noFallthroughCasesInSwitch`; on the client also `noPropertyAccessFromIndexSignature` and Angular's
  `strictTemplates`.
- **Never use single-line `if`.** Always brace the body, even for one statement:
  ```typescript
  if (x === 1) {
      callSomeFunction();
  }
  ```
- **Avoid `any`.** When unavoidable, leave an inline comment explaining why.
  - *Project-specific sanctioned exception:* target-database document payloads have no compile-time
    shape. Use the driver's `Document` type or `unknown` — not `any` — and see
    [Target Database Context](#backend-standards--target-database-context).
- **Prefer `interface` over `class`** for data shapes. Anything shared between client and server
  **must** be an `interface` (browser/Node compat, no constructor coupling).
- **No default exports.** Export every symbol by name:
  ```typescript
  export const thisExample = 12;
  export class SomeClass { /* ... */ }
  ```
- **Constructor first.** In a class, the constructor is the first member.
- **Prefer `undefined` over `null`** for absence. Only use `null` where it's already required (DOM
  APIs, MongoDB results — convert `null` to `undefined` at the boundary via a `nullToUndefined`
  helper). **`[Internal DB]` only** — see the warning table above; target documents keep their `null`s.
- **Don't use the `String()` / `Number()` constructors as casts.** Use `.toString()`, `parseInt()`, etc.
- **Vertical whitespace matters.** Separate logical blocks with blank lines so the structure of a
  function reads visually.

### Comments

- **Default to no comments.** Code should be self-explanatory through naming.
- When a block does need a comment, it's one short line stating *what* the block accomplishes
  (`// Sort the list by name.`), not a narration of the syntax.
- **JSDoc all exported items** — functions, methods, classes, interfaces, properties. A sentence or
  two. `/** ... */` for one-liners.
- **Never commit speculative or scratch comments.** Two exceptions, both prefixed:
  - `// TODO-Immediate: ...` — placeholder code the developer must address before accepting the change.
  - `// TODO-Information: ...` — a note the developer should read before accepting.
- **Comments must be complete sentences with proper grammar.**
- Don't write comments that describe history (`// added for X`, `// fix for issue #123`). That belongs
  in commit messages and PR descriptions.

### Naming

- **Files:** kebab-case (`saved-connection.service.ts`, `collection-detail.component.ts`).
- **Classes / interfaces / types:** PascalCase. Don't prefix interfaces with `I` *except* for ones
  defining a "contract" implemented by multiple classes (`IConnectionStrategy`,
  `IOidcTokenProvider`). Pure data interfaces use plain PascalCase (`SavedConnection`,
  `CollectionSummary`).
- **Variables / functions / methods:** camelCase.
- **Constants & enum-likes:** SCREAMING_SNAKE_CASE for socket-event name constants
  (`CONNECTION_STATE_CHANGED`); regular constants are camelCase.
- **Observables:** suffix with `$` (`connectionList$`, `currentConnection$`).
- **Private RxJS subjects backing public observables:** prefix with `_` (`_connectionList` → exposed
  as `connectionList$`).
- **CSS classes:** lowercase-with-dashes (`collection-card-wrapper`).

---

## Frontend Standards (Angular)

### Stack

- **Angular** (standalone components — no NgModules)
- **PrimeNG** as the primary UI component library
- **Bootstrap** for layout utilities only (`d-flex`, `d-none d-lg-block`) — loaded as a CDN stylesheet
  from `angular.json`
- **SCSS** for all styling (`schematics.@schematics/angular:component.style: "scss"` in `angular.json`)
- **RxJS** for streams and async transport **in services** (HTTP, socket events, reload pipelines) —
  *not* for component view state
- **Signals** for component reactivity — `toSignal()` bridges service observables; view state lives in
  `signal()` / `computed()`
- **socket.io-client** for real-time
- **Monaco Editor** where rich text editing is needed — via `@monaco-editor/loader`. Likely load-bearing
  here for the document JSON editor and the aggregation pipeline editor.
- **Zoneless change detection** (Angular 22 default; `provideZonelessChangeDetection()` in
  `app.config.ts`, **no zone.js polyfill**)

> This is the biggest change from the older playbook, which specified Zone.js and RxJS-subscription
> component state. Do not scaffold this project the old way — see
> [Divergences](#divergences-from-the-setup-skill-reference).

### Project structure

```
src/
├── app/
│   ├── components/
│   │   ├── component-base/         # Shared ComponentBase class
│   │   ├── connections/            # connection list, editor, connect dialog
│   │   ├── explorer/               # database tree, collection list, collection detail
│   │   ├── documents/              # document grid, JSON editor, document detail
│   │   ├── query/                  # filter bar, projection/sort, aggregation builder
│   │   ├── indexes/
│   │   ├── admin/                  # target-cluster users, roles, server status
│   │   └── login/                  # app login — not database login
│   ├── services/
│   │   ├── explorer/               # domain services (state, orchestration)
│   │   │   └── api-clients/        # HTTP clients (one per concern)
│   │   ├── connection-state.service.ts
│   │   ├── page-size.service.ts    # Generic, reusable across projects
│   │   └── token.service.ts        # App JWT only
│   ├── routing/                    # Route guards, route helpers
│   ├── app.config.ts               # provideZonelessChangeDetection()
│   ├── app.routes.ts               # Single flat routes definition
│   └── app.component.ts
├── environments/
│   ├── environment.ts              # production
│   └── environment.development.ts  # dev (file-replaced by angular.json)
├── model/
│   ├── shared-models/              # IDENTICAL copy of server's shared-models
│   └── <client-only-types>/
├── types/                          # incl. mongodb.d.ts ambient ObjectId alias
├── utils/
├── styles.scss                     # Global styles + design tokens
├── layout.scss                     # Layout utility classes
└── buttons.scss                    # Button-specific shared rules
```

### Component pattern

**Every major component extends `ComponentBase`,** in
`src/app/components/component-base/component-base.component.ts`. It exposes a `ngDestroy$` observable
that fires once on destroy.

```typescript
// component-base.component.ts — ~20 lines, copy verbatim into new projects
import { Component } from '@angular/core';
import { Subject } from 'rxjs';

@Component({
    selector: 'app-component-base',
    imports: [],
    template: ''
})
export class ComponentBase {
    private onDestroy = new Subject<void>();

    /** Emits when ngOnDestroy is called.
     *   Pipe takeUntil(this.ngDestroy$) on every subscription in the component. */
    protected ngDestroy$ = this.onDestroy.asObservable();

    ngOnDestroy() {
        this.onDestroy.next();
        this.onDestroy.complete();
    }
}
```

**Component file requirements:**

- `@Component` must include `selector`, `imports`, `templateUrl`, and `styleUrl` — separate `.html`
  and `.scss` files, no inline templates.
- Always include `CommonModule` and `FormsModule` in `imports`. Add PrimeNG modules as needed.
- The class **must** have a constructor (even if empty), and the constructor is the first member.
- The class **must** extend `ComponentBase` and call `super()`.
- **Consume state as signals, not subscriptions (zoneless).** Bridge a service observable with
  `toSignal(service.x$)` — call it in the constructor, which is an injection context, to keep
  constructor DI — and read `x()` in the template. Hold asynchronously-set view state (flags toggled
  in callbacks, collections mutated by socket events, objects loaded then edited) in writable
  `signal()`s; update via `.set()` / `.update()` with immutable values for arrays and objects. Use
  `computed()` for derived view state.
- **Subscriptions are for imperative work only** — route params that call `service.load()`, socket
  handlers whose body writes a signal, and fire-and-forget actions (navigate, toast,
  `service.reload()`). Every such subscription pipes `takeUntil(this.ngDestroy$)`; **never** call
  `.unsubscribe()` manually.
- Inject services in the constructor with `readonly`. Inject preemptively if you might use them —
  easier to delete than to add.
- **Never call `HttpClient` directly** from a component. Components use domain services; domain
  services use API clients.
- PrimeNG dialogs whose visibility flag is set asynchronously bind `[visible]` + `(visibleChange)` to
  a `signal`, not `[(visible)]`. Edited objects held in a signal can still use
  `[(ngModel)]="obj.field"` via an `@let` alias — ngModel mutates the held object in place, and the
  form event ticks change detection.

**Canonical example:**

```typescript
@Component({
    selector: 'app-connection-list',
    imports: [CommonModule, FormsModule, RouterModule, CardModule, /* ... */],
    templateUrl: './connection-list.component.html',
    styleUrl: './connection-list.component.scss'
})
export class ConnectionListComponent extends ComponentBase {
    /** Saved connections, or undefined until first load. */
    readonly connections: Signal<SavedConnectionListing[] | undefined>;
    /** True while a connect attempt is in flight. */
    readonly connecting = signal(false);

    constructor(
        readonly connectionsService: ConnectionsService,
        readonly confirmationService: ConfirmationService,
        private readonly router: Router,
    ) {
        super();
        // Bridge the service observable to a signal; template reads connections().
        this.connections = toSignal(this.connectionsService.connectionListing$);
    }

    connect(connectionId: ObjectId) {
        this.connecting.set(true);
        this.connectionsService.connect(connectionId)
            .pipe(takeUntil(this.ngDestroy$))         // retained: imperative action
            .subscribe({
                next: c => { this.connecting.set(false); this.router.navigate(['/explore', c._id]); },
                error: () => this.connecting.set(false),
            });
    }
}
// imports: { signal, computed, Signal } from '@angular/core'; { toSignal } from '@angular/core/rxjs-interop';
```

### Service pattern

Services are **the source of state**, and they stay **RxJS** — the signals rule changes the component
layer, not the service layer. Components bridge service observables to signals and rarely hold their
own non-trivial state.

- `@Injectable({ providedIn: 'root' })` for singletons (the default).
- Services usually call `this.initialize()` from their constructor to wire up streams.
- **State is exposed as observables** (`xxx$`), with optional snapshot getters for current value
  (`xxx`). Components bridge these to signals at the edge; **the service itself does not expose
  signals.**
- **Reload streams:** data fetched from the API is paired with a private `Subject<void>` that triggers
  a re-fetch:
  ```typescript
  private _reloadConnectionList = new Subject<void>();

  reloadConnectionList() {
      this._reloadConnectionList.next();
  }

  // The data observable starts with `undefined` so it fetches immediately,
  //   then refetches whenever something calls reloadConnectionList().
  connectionListing$: Observable<SavedConnectionListing[]> = this._reloadConnectionList.pipe(
      startWith(undefined),
      switchMap(() => this.apiClient.getConnections()),
      shareReplay(1)
  );
  ```
- **CRUD methods return Observables that trigger reload on success** rather than blocking on a
  re-fetch:
  ```typescript
  createConnection(config: NewDbItem<SavedConnection>) {
      return this.client.createConnection(config).pipe(
          switchMap(result => {
              this._reloadConnectionList.next();
              return of(result);
          })
      );
  }
  ```
- **Async helpers** that don't fit RxJS comfortably can be plain `async` methods using
  `lastValueFrom(...)` to bridge.

### API client pattern

API clients live under `src/app/services/<domain>/api-clients/` in a small hierarchy:

1. **`api-client-base.service.ts`** — abstract base. Holds `HttpClient`, `TokenService`, an
   `HttpOptionsBuilder`, the API base URL, and a `parseToken()` helper.
2. **`api-client-internals.ts`** — `HttpOptionsBuilder` and `OptionsBuilderInternal`, a fluent
   options-builder that attaches the JWT auth header
   (`.buildOptions().addAuthToken().build()`, or the shortcut `withAuthorization()`).
3. **`api-client.service.ts`** — the main `ClientApiService`, covering the major CRUD endpoints.
4. **Specialized clients** — split out when a concern has its own lifecycle. Anticipated here:
   `connections-api-client.service.ts`, `explorer-api-client.service.ts`,
   `documents-api-client.service.ts`, `admin-api-client.service.ts`.

**Pattern rules:**

- All methods return RxJS `Observable`s, even for one-shot HTTP calls.
- Auth is automatic: every call except `/login` and `/register` uses
  `this.optionsBuilder.withAuthorization()`.
- `ObjectId` types all **our** entity IDs in method signatures (aliased to `string` in the browser —
  see [Shared Models Contract](#shared-models-contract)).
  **`[Target DB]`** A target document's `_id` is **not** typed `ObjectId` — it can be any BSON value.
  Type it as `unknown` / an Extended JSON value.
- Strongly type request and response bodies using interfaces from `src/model/shared-models/`.
  **`[Target DB]`** Target *documents* have no interface. The *envelope* around them does.
- Token storage and parsing live in `TokenService`; the JWT is decoded with
  `JSON.parse(atob(token.split('.')[1]))`.

### Routing

- A **single flat `app.routes.ts`** with a deeply nested `children` tree — not per-feature routing
  modules.
- Auth-protected branches live under a parent route guarded by `authenticatedGuard` (a
  `CanActivateFn` returning `Observable<boolean | UrlTree>`).
- Nested routes mirror the URL hierarchy:
  `/explore/:connectionId/databases/:dbName/collections/:collectionName`. Detail components read
  params from `ActivatedRoute.params`.
- A wildcard `path: '**'` redirects to `''`, which redirects to the home page.

### SCSS pattern

**Three global SCSS files**, all imported into `styles.scss`:

| File | Purpose |
|---|---|
| `src/styles.scss` | Design tokens, base typography, body/html sizing, app-wide utilities, `:root` custom properties |
| `src/layout.scss` | Layout-utility placeholders/classes (`%fit-container`, `.fit-container-scroll`, `.open-height`) |
| `src/buttons.scss` | Shared button rules (e.g. `p-button:not(:first-child) { margin-left: 1em }`) |

**Design tokens via `:root` CSS custom properties** — define in `styles.scss`, override locally in
component SCSS:

```scss
:root {
    // Surfaces
    --color-surface-panel: #f7f7f7;
    --color-surface-page: #ffffff;
    // Borders
    --color-border: #e0e0e0;
    // Brand
    --color-brand-primary: var(--p-primary-color, #3b82f6);
    // Typography
    --font-family-base: "Segoe UI", Arial, sans-serif;
}
```

Project-specific token needs: **destructive-action** and **read-only-connection** colors, plus
per-BSON-type colors for the document viewer. Add them as `--color-*` tokens rather than hard-coding
in component SCSS.

**Component SCSS rules:**

- Class names are **lowercase-with-dashes**.
- Nest classes to **mirror containment in the HTML**. A class appearing under multiple parents goes
  under the **lowest common ancestor**.
- **Use Bootstrap and PrimeNG classes for layout** — don't write new ones for `d-flex`, `d-block`,
  gutter spacing.
- Don't create new global classes when an existing one fits.
- Don't introduce new classes for stylable PrimeNG elements unless customizing their children
  explicitly.
- Hard-coded color values are an anti-pattern — reference the `--color-*` properties from
  `styles.scss`.

### Responsive behavior

`PageSizeService` is the single source of truth for window-size reactivity:

- `pageResized$: Observable<{ width, height }>` — emits on `window.resize`, with `startWith` of the
  current value.
- `isSkinnyPage$ / isSkinnyPage` — true when width < 1024px.
- `isFullWidthDrawers`, `isFullScreenDialogs` — booleans for layout decisions.
- `standardDrawerStyle`, `standardDialogStyle` — getter style objects for PrimeNG `[style]` inputs.

Generic; copies cleanly into new projects.

---

## Backend Standards — Internal Database Context

`[Internal DB]` **Everything in this section governs Mongo Explorer's own database and general server
structure.** For target clusters, see the next section.

### Stack

- **Node + Express** with **TypeScript**
- **MongoDB** via the official driver
- **Socket.IO** for real-time
- **Inversify** for DI (with `reflect-metadata`)
- **Zod** for request body validation
- **JWT (`jsonwebtoken`) + `bcrypt`** for app auth
- `ts-node` for `npm start` (dev), `tsc → node dist/index.js` for build

### tsconfig

- `target: ES2022`, `module: commonjs` (ts-node compatibility)
- `experimentalDecorators: true`, `emitDecoratorMetadata: true` — both required for Inversify
- `strict: true`, `forceConsistentCasingInFileNames: true`
- `rootDir: ./src`, `outDir: ./dist`

### Project structure

```
src/
├── index.ts                      # Entry point — `import 'reflect-metadata'` as line 1
├── container.ts                  # Inversify composition root
├── tokens.ts                     # Symbol() injection tokens
├── config.ts                     # getAppConfig() + env-var override
├── setup-express.ts              # Express + middleware + route wiring
├── system-setup.ts               # System-level init (migrations, etc.)
├── mongo-helper.ts               # [Internal DB] ONLY — never a target cluster
├── auth/                         # APP auth, not database auth
│   ├── jwt.ts                    # signToken / verifyToken
│   └── auth-middleware.ts
├── database/                     # [Internal DB] DB services
│   ├── db-service.ts             # @injectable abstract base
│   ├── log-db.service.ts
│   ├── auth-db.service.ts
│   └── saved-connection-db.service.ts
├── connections/                  # [Target DB] project-specific — see next section
├── explorer/                     # [Target DB] project-specific — see next section
├── server/
│   ├── middleware/               # Cross-cutting Express middleware
│   ├── socket-services/          # Socket.IO namespace handlers
│   ├── socket.server.ts          # SocketServer base abstraction
│   ├── auth.server.ts            # createAuthRouter(authDbService)
│   └── <domain>.server.ts        # one factory function per route group
├── services/                     # Application services (non-DB)
└── model/
    ├── app-config.model.ts
    ├── db-collection-names.constants.ts   # [Internal DB] collections only
    ├── errors/
    └── shared-models/            # source of truth; copied to client
```

### Composition root via Inversify

**The container is the single composition root.** It replaces ad-hoc globals, ordering scripts, and
post-construction property assignment. Every service is bound once, declares its dependencies, and
resolves lazily.

**`tokens.ts`** — one Symbol per injectable:

```typescript
export const TOKENS = {
    AppConfig:               Symbol('AppConfig'),
    MongoHelper:             Symbol('MongoHelper'),
    LogDbService:            Symbol('LogDbService'),
    ConnectionManager:       Symbol('ConnectionManager'),
    ConnectionStrategies:    Symbol('ConnectionStrategies'),   // multi-binding
    // ... etc.
};
```

**`container.ts`** — services bound with `toDynamicValue(async (ctx) => ...)` + `inSingletonScope()`.
The async factory is the right place for `await connect()` and `await initialize()`.

```typescript
export async function buildContainer(): Promise<Container> {
    const config = await getAppConfig();
    const container = new Container({ defaultScope: 'Singleton' });

    container.bind(TOKENS.AppConfig).toConstantValue(config);

    // Internal database — connect once, reuse forever.
    container.bind<MongoHelper>(TOKENS.MongoHelper).toDynamicValue(async () => {
        const helper = new MongoHelper(config.mongo.connectionString, config.mongo.databaseName);
        await helper.connect();
        return helper;
    }).inSingletonScope();

    // DB services — uniform pattern.
    container.bind(TOKENS.LogDbService).toDynamicValue(async (ctx) =>
        new LogDbService(await ctx.container.getAsync(TOKENS.MongoHelper))
    ).inSingletonScope();

    // ... rest of bindings

    return container;
}
```

**Multi-bindings** for plugin-style arrays. Connection strategies are exactly this shape:

```typescript
container.bind<IConnectionStrategy>(TOKENS.ConnectionStrategies).toConstantValue(new ConnectionStringStrategy());
container.bind<IConnectionStrategy>(TOKENS.ConnectionStrategies).toConstantValue(new ScramStrategy());
// ...

// Aggregator binds AFTER all bindings above:
container.bind(TOKENS.ConnectionManager).toDynamicValue(async (ctx) =>
    new ConnectionManager(
        await ctx.container.getAllAsync<IConnectionStrategy>(TOKENS.ConnectionStrategies),
    )
).inSingletonScope();
```

**Circular references** — when service A constructs B *and* B uses A at runtime (not construction
time), break the cycle with a getter:

```typescript
new SomeStrategy(
    () => ctx.container.get<ConnectionManager>(TOKENS.ConnectionManager),  // lazy getter
    /* ...other deps that *are* construction-time */
);
```

**Class decoration** — every injectable class is annotated `@injectable()`. With
`emitDecoratorMetadata`, constructor parameters do **not** need `@inject()` when their types are
concrete classes. Classes whose constructors take primitives or arrays keep the `toDynamicValue`
factory.

### Entry point: `index.ts`

```typescript
import 'reflect-metadata';                       // MUST be the first import
import { buildContainer } from './container';
import { TOKENS } from './tokens';
import { getAppConfig } from './config';
import { initializeExpressApp } from './setup-express';
import { systemInitialization } from './system-setup';
import http from 'http';

async function run() {
    const container = await buildContainer();
    const config = await getAppConfig();

    // Eagerly resolve services that register socket handlers in their constructor.
    await container.getAsync(TOKENS.ConnectionManager);

    const app = await initializeExpressApp(container);
    const server = http.createServer(app);

    const socketServer = await container.getAsync<SocketServer>(TOKENS.SocketServer);
    socketServer.registerWithServer(config, server);

    await systemInitialization(container);

    server.listen(config.serverConfig.port, () => {
        console.log(`Server running on port ${config.serverConfig.port}`);
    });
}

run();
```

### Config loading

`getAppConfig()` is an idempotent loader that:

1. Reads `app-config.json` from the project root (one level above `dist/` or `src/`).
2. Caches the parsed config in module scope.
3. Walks the config recursively and **overrides each leaf with the matching environment variable** if
   one is set, via a `ConfigToEnvMap` constant whose shape mirrors `IAppConfig`.
4. Converts string values starting with `./` or `../` into absolute paths anchored at the project root.

### MongoDB layer `[Internal DB]`

> **`MongoHelper` is for the internal database only.** It assumes one persistent connection to one
> known database with schemas we own. A target cluster is none of those things. Handing a `MongoHelper`
> a user's cluster is the defining mistake of this codebase — if you find yourself doing it, you want
> `LiveConnection`.

**`MongoHelper`** is a thin wrapper around the official `MongoClient`. Constructed once at startup,
shared across all internal DB services.

- Holds a single persistent connection (no per-call connect/disconnect).
- Exposes `connect()`, `disconnect()`, `isConnected`, plus generic helpers: `makeCall`,
  `makeCallWithCollection`, `findDataItem` (overloaded for `findOne` true/false),
  `findDataItemWithProjection`, `updateDataItems`, `deleteDataItems`, `upsertDataItem`,
  `getPaginatedPipelineResult`.
- A reconnect handler on `'close'` reconnects unless `disconnect()` was called intentionally.
- Mongo's `null` from a `findOne` miss becomes `undefined` via `nullToUndefined` at the boundary.

**Collection name constants** are centralized in `src/model/db-collection-names.constants.ts` so
collection strings are never typed inline. Internal collections only — target collection names are
runtime user data and have no constants.

**`DbService` abstract base** lives in `src/database/db-service.ts`. It's `@injectable()` and takes
`MongoHelper` via constructor. Subclasses are per-entity and receive the helper from their own
constructor.

**Per-entity DB service pattern:**

```typescript
@injectable()
export class SavedConnectionDbService extends DbService {
    constructor(dbHelper: MongoHelper) {
        super(dbHelper);
    }

    async upsertConnection(connection: UpsertDbItem<SavedConnection & { _id: ObjectId; }>): Promise<SavedConnection & { _id: ObjectId; }> {
        return await this.dbHelper.upsertDataItem(DbCollectionNames.SavedConnections, connection);
    }

    async getConnectionById(connectionId: ObjectId) {
        return await this.dbHelper.findDataItem<SavedConnection & { _id: ObjectId; }, { _id: ObjectId; }>(
            DbCollectionNames.SavedConnections,
            { _id: connectionId },
            { findOne: true }
        );
    }

    // ... CRUD methods, plus aggregation methods using makeCallWithCollection for complex pipelines.
}
```

### Express setup

**`setup-express.ts`** exports `initializeExpressApp(container: Container): Promise<Application>`. It:

1. Creates the `Application`.
2. Sets up CORS using `config.corsAllowed` — must include the frontend dev port `27100`.
3. Adds `bodyParser.json()`.
4. Adds **ID-conversion middleware** — hex strings that look like ObjectIds become `ObjectId`
   instances on the way in, and ObjectIds become strings on the way out
   (`bodyStringsToObjectIdsMiddleware`, `bodyObjectIdsToStringMiddleware`,
   `bodyStringsToDatesMiddleware`).
   > **`[Target DB]` This middleware must NOT touch target-document payloads.** It walks the body and
   > rewrites anything that *looks* like an ObjectId or a date — which on a user's document is data
   > corruption, not convenience. Mount it path-scoped to internal-entity routes, or exclude the
   > document routes explicitly, and carry target documents as Extended JSON instead. Decide the
   > mounting strategy when the first document route is written, not after.
5. Registers an unauthenticated-API-call logger.
6. Resolves all DB and app services from the container (the only place `container.getAsync` runs for
   routes).
7. Mounts `createAuthRouter(...)` **before** `authMiddleware` — login/register are public.
8. Adds `authMiddleware`, then an authenticated-API-call logger.
9. Mounts every other route via its factory: `app.use(createConnectionsRouter(...))`, etc.
10. Adds a 404 fallback.
11. Adds the **global error handler** last (four args, so Express recognizes it):
    ```typescript
    app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
        const message = err instanceof Error ? err.message : 'Internal server error';
        console.error(`Unhandled error on ${req.method} ${req.path}:`, err);
        loggingService.logMessage({ level: 'error', message: `Unhandled error: ${message}`, data: { path: req.path, method: req.method } }).catch(() => {});
        if (!res.headersSent) {
            res.status(500).json({ message: 'Internal server error' });
        }
    });
    ```

### Route factory pattern

**Routes never import services from globals.** Each route module exports a factory taking its
dependencies as plain parameters:

```typescript
// src/server/connections.server.ts
export function createConnectionsRouter(savedConnectionDbService: SavedConnectionDbService, connectionManager: ConnectionManager) {
    const connectionsRouter = express.Router();

    connectionsRouter.get('/connections', async (req, res) => {
        try {
            const userId = getUserIdFromRequest(req);
            if (!userId) {
                res.status(401).json({ error: 'Unauthorized' });
                return;
            }
            const connections = await savedConnectionDbService.getConnectionListings(userId);
            res.json(connections);
        } catch (error) {
            res.status(500).json({ error: 'Failed to fetch connections' });
        }
    });

    // ...

    return connectionsRouter;
}
```

- Every handler gets the user ID via `getUserIdFromRequest(req)` (returns `ObjectId | undefined`).
- Every handler `try`/`catch`es. The catch handles known cases (404, 401, 400) with the appropriate
  status. Unhandled throws fall through to the global error handler.
- Return early (`res.status(...).json(...); return;`) — never `return res.status(...)`. Express
  handlers return `void`.

### Auth middleware + JWT

`[Internal]` This is **app** auth — "who is using Mongo Explorer." It is not database auth.

```typescript
// src/auth/auth-middleware.ts
export async function authMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
    const token = req.headers['authorization'] as string;
    if (!token) {
        res.status(401).json({ message: 'Access denied. No token provided.' });
        return;
    }

    const decoded = await verifyToken(token);
    if (!decoded) {
        res.status(401).json({ message: 'Invalid token.' });
        return;
    }

    (req as any).user = decoded;
    next();
}
```

The token is the raw JWT — no `Bearer ` prefix in this codebase. `verifyToken` returns the
`TokenPayload` or `undefined`; the decoded payload attaches to `req.user`.

### Zod request validation

Use `validateBody(schema)` on routes accepting user-supplied data — login, register, connection
create/update. Other routes can be added incrementally. Failures return 400 with field-level errors:

```typescript
const createConnectionSchema = z.object({
    name: z.string().min(1, 'Connection name is required'),
    strategyKind: z.nativeEnum(ConnectionStrategyKind),
});

connectionsRouter.post('/connection', validateBody(createConnectionSchema), async (req, res) => {
    // req.body is now typed and trusted
});
```

The middleware sets `req.body = result.data` after parsing, so handlers see the parsed version.

> **`[Target DB]`** Zod validates the *envelope* — which connection, which database, which collection,
> filter, page size, sort. It does **not** validate target document contents; arbitrary user documents
> have no schema to validate against. Validating the envelope strictly is what makes it safe to pass
> the document body through untouched.

### Socket.IO abstraction

A custom `SocketServer` class in `src/server/socket.server.ts`:

- Wraps Socket.IO with consistent observable-based event delivery.
- Authenticates connections via JWT in `socket.handshake.auth.token` — connection dropped on bad
  credentials.
- Auto-converts ObjectIds to strings outgoing and strings to ObjectIds incoming.
  **`[Target DB]`** Same caveat as the HTTP middleware: target document payloads must bypass this
  conversion. Prefer not to ship target documents over sockets at all.
- Exposes `subscribeToEvent(eventName)` returning an `Observable<SocketServerEvent>` that completes
  when sockets disconnect.
- Attaches the authenticated `userId` to every event.
- Provides `joinRoom`, `leaveRoom`, `emitEventToRoom`, `emitEventToRoomExceptTo`.

**Per-namespace classes** extend a `SocketServiceBase`, register with the container, and call
`subscribeToEvent(...)` in `initialize()`. Their constructors take `SocketServer` plus needed
DB/app services.

**Socket event name constants** are SCREAMING_SNAKE_CASE and live in shared-models beside their
message-shape interfaces:

```typescript
// shared-models/connections/socket-messaging/connection-state.socket-model.ts
export const CONNECTION_STATE_CHANGED = 'connection-state-changed';
export interface ConnectionStateChangedMessage {
    connectionId: ObjectId;
    state: ConnectionState;
}
```

Client and server reference the **same constant** — no string-literal drift.

---

## Backend Standards — Target Database Context

`[Target DB]` **This section is specific to Mongo Explorer and has no counterpart in the shared
playbook.** It governs every interaction with a database the user is exploring.

### Access path

```
SavedConnection  →  IConnectionStrategy  →  LiveConnection  →  MongoClient
   (internal DB)      (auth mechanism)       (lifecycle)        (driver)
```

`explorer/` services take a `LiveConnection`. Nothing above `LiveConnection` sees a connection string
or a credential. See [connection-and-auth.md](connection-and-auth.md) for the full model.

### Rules

1. **Never `MongoHelper`, never `DbService`, never a collection-name constant.** Those three are
   internal-database machinery. Target access goes through `LiveConnection`.
2. **Target-side services are not process singletons.** They are scoped to a `LiveConnection` and
   obtained through `ConnectionManager`. Binding an `explorer/` service as
   `inSingletonScope()` with a connection captured in its constructor is a bug that will surface as
   one user's query hitting another user's cluster. The container binds *factories* here, not
   instances.
3. **Every driver call is bounded.** Explicit `limit`, explicit `maxTimeMS`, and a server-side page
   cap that the client cannot raise past a configured maximum. **No unbounded `.toArray()` anywhere,
   ever.** Prefer cursors with explicit batch handling.
4. **Extended JSON at the API boundary**, via `EJSON` from the `bson` package that ships with the
   driver. Plain `JSON.stringify` silently destroys BSON types and would corrupt documents on save.
5. **Preserve `null`.** `null` is a real BSON value and is not the same as an absent field. Do not
   apply `nullToUndefined` to target data.
6. **No typed interfaces for target documents.** Use the driver's `Document` type or `unknown`. The
   *envelope* (request/response wrapper: connection id, database name, collection name, filter, page
   info) is strongly typed in shared-models; its `documents` payload is not.
7. **A target `_id` is not an `ObjectId`.** It can be a string, number, date, subdocument, or binary.
   Type it accordingly and never assume it round-trips as a hex string.
8. **Destructive operations need a typed confirmation in the UI *and* a server-side guard.** Drop,
   delete-many, and update-many are checked against the connection's read-only flag on the server —
   hiding the button is not a control.
9. **Per-connection read-only flag is enforced server-side.** It lives on the `SavedConnection` and is
   checked in the `explorer/` service, not the route.
10. **Errors surface largely intact**, minus secrets. Opaque connection errors are the exact problem
    this project exists to escape; do not reproduce them. Pass the driver's message and error code
    through to the client after redaction.
11. **Never log a credential, token, or unredacted connection string.** All connection strings pass
    through a redaction helper before any log call. Write that helper in Phase 1 — retrofitting means
    auditing every log statement in the codebase.
12. **Feature-detect, don't assume.** Cosmos vCore, Atlas, and self-hosted MongoDB differ in available
    admin commands and index options. Detect at connect time and degrade the UI; don't hard-code a
    compatibility matrix.
13. **Every write takes an `OperationActor` and refuses non-user actors.** Signature:
    ```typescript
    /** Who initiated an operation. Threaded to every Target Database write. */
    export type OperationActor = 'user' | 'mcp' | 'system';
    ```
    Every write method in `src/explorer/**` calls `assertUserActor(actor, operationName)` as its first
    statement. The actor is a required parameter — not optional, not defaulted, not inferred — so a new
    write method that forgets it does not compile. This is what makes "an AI cannot write to a Target
    Database" structural rather than a policy that a UI bug could defeat. See
    [mcp-server-spec.md § Actor-Gated Write Path](mcp-server-spec.md#-actor-gated-write-path).
14. **CI enforces the actor gate.** Every exported method in `src/explorer/**` matching
    `/^(insert|update|delete|drop|create|rename|replace|bulk)/` must call `assertUserActor`. A missing
    call fails the build.

### Naming conventions

- Strategies: `<mechanism>.strategy.ts` → `AzureOidcStrategy`, `ScramStrategy`.
- Strategy contract: `IConnectionStrategy` (an `I`-prefixed contract, per the naming rule).
- Target-side domain services: `<thing>-explorer.service.ts` → `DatabaseExplorerService`,
  `CollectionExplorerService`.
- Anything holding a live target connection has `Connection` or `Live` in its name, so the distinction
  is visible at the call site.

### Azure / OIDC work on a non-work machine

Azure and OIDC code written on a machine without cluster access is **structural only**. Stub the
token-acquisition seam behind `IOidcTokenProvider` with a fake implementation for tests, and mark the
unfinished seam `// TODO-Immediate:`. Do not write code that *appears* to work and doesn't. See
[research/azure-vcore-oidc.md](research/azure-vcore-oidc.md).

---

## Shared Models Contract

Client and server share a `model/shared-models/` folder. **The folders are kept identical.**

### Rules

1. **Server is the source of truth.** All shared files originate on the server and are *copied* to the
   client.
2. The folder structure under `shared-models/` is identical on both sides.
3. Files are **interfaces and constants only** — no classes, no logic depending on Node-only or
   browser-only globals.
4. **Never modify** `shared-models/` files in the client project without explicit permission. Changes
   are made on the server first, then propagated.
5. The client declares the `mongodb` package as an ambient module (no actual dependency installed) and
   aliases `ObjectId` to `string`, so shared interfaces can reference `ObjectId` without breaking
   browser compatibility:
   ```typescript
   // client side: src/types/mongodb.d.ts
   declare module 'mongodb' {
       export type ObjectId = string;
   }
   ```
   Use `ObjectId` in all client code working with **our** entity IDs — it carries semantic meaning
   plain `string` doesn't. **`[Target DB]`** Do not use it for target document `_id`s.

### Conventions inside `shared-models/`

- **Interfaces** for all data shapes. JSDoc on every property.
- **Operation types:** `NewDbItem<T>` for create payloads (omits `_id`), `UpsertDbItem<T>` for upsert
  payloads (`_id` optional). Defined once in `shared-models/db-operation-types.model.ts`.
  **`[Internal DB]` only** — these describe our entities, not target documents.
- **Domain split:** group related models into sub-folders. Anticipated here:
  `shared-models/connections/`, `shared-models/explorer/`, `shared-models/auth/`.
- **Socket-message models** live under `<domain>/socket-messaging/`, pairing the event-name constant
  with its message interface.

---

## Testing posture

Not fully decided — see [open-questions.md](open-questions.md) for the framework choice. The floor:

- `IConnectionStrategy` implementations are unit-testable with a fake `IOidcTokenProvider`, no network.
- The `LiveConnection` state machine is unit-testable with no network at all. It should be, by design.
- Extended JSON round-tripping gets real tests with awkward BSON values (`null`, `Decimal128`,
  `Binary`, nested `ObjectId`, dates, non-ObjectId `_id`s). This is where silent corruption lives.
- Integration tests for `explorer/` services against a local MongoDB.

---

## General Philosophy

- **Reactive state on the client, container-managed services on the server.** Both keep ownership of
  "who knows what" explicit and pushed to one well-defined place.
- **Composition over inheritance**, *except* for carefully chosen base classes: `ComponentBase` on the
  client (lifecycle plumbing) and `DbService` on the server (DB helper plumbing). They exist to delete
  repetitive code, not to grow a hierarchy.
- **Manual wiring with help.** Inversify isn't auto-magic — every binding is written by hand in
  `container.ts`. Decorators only let the container resolve parameter types it can already see.
- **Trust at the boundary, not inside.** Validate request bodies with Zod at the server's entrance.
  Inside, trust your own types. Don't write defensive code for scenarios that can't happen.
  *Project caveat:* target **data** is never trusted, at any depth. The boundary rule applies to
  request envelopes, not to document contents.
- **Boring, repeatable patterns.** The DB services are boring. The route factories are boring. The
  components are boring. Boring means a new contributor — or Claude — can predict where things go
  without asking.
- **Surface area first, polish later.** Patterns are revisited when they hurt, not preemptively.

---

## Divergences from the setup-skill reference

`~/.claude/skills/mean-stack-project-setup/references/project-standards.md` is an older copy of this
playbook. **Where it disagrees with this document, this document wins.** Known divergences:

| Item | Skill reference (stale) | Correct |
|---|---|---|
| Angular change detection | Zone.js, default change detection | **Zoneless** — `provideZonelessChangeDetection()`, no zone.js polyfill |
| Component state | RxJS subscriptions into fields | **Signals** — `toSignal()` bridge, `signal()`/`computed()` for view state |
| PrimeNG async dialogs | `[(visible)]` | `[visible]` + `(visibleChange)` bound to a signal |
| Shared Mongo host | `mongo.fingercraft.run:27017` | **`mongo.fingercraft.com:27017`** |

**Consequence for setup:** when `/mean-stack-project-setup` runs, it must follow *this* document, not
its own reference — specifically, scaffold Angular zoneless with no zone.js polyfill, and use the
`.com` host. Its Phase 1 reads workspace Markdown first, which is what this file is for.

### Project-specific additions not in any shared playbook

- The [two MongoDB contexts](#-two-mongodb-contexts--read-this-before-anything-else) distinction and
  everything that follows from it
- The entire [Target Database Context](#backend-standards--target-database-context) section
- `MongoHelper` narrowed to the internal database
- `src/connections/` and `src/explorer/` as top-level server folders
- Extended JSON at the API boundary
- Credential redaction before logging
- Bounded-call requirement on all target driver calls
