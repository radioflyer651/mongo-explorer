# Connections & Authentication — the Core Domain

This is the document that matters most. Everything else in Mongo Explorer is a competent CRUD UI;
this is the part that justifies the project.

---

## ◈ Strategy-Brokered Connection Pattern

**A connection is not a string. A connection is a strategy plus a state machine.**

Compass's model is essentially "here is a URI, plus some checkboxes." That model is exactly what
breaks on Azure vCore + Entra ID, because the credential is not a static secret — it's a token that
must be acquired interactively, cached, and refreshed on a clock.

So the central abstraction is:

```
SavedConnection  →  IConnectionStrategy  →  LiveConnection  →  MongoClient
   (persisted)        (knows how to auth)     (owns lifecycle)   (driver)
```

| Piece | Responsibility |
|---|---|
| `SavedConnection` | Persisted, user-visible config. Names a strategy kind and carries that strategy's parameters. Secrets encrypted at rest. |
| `IConnectionStrategy` | Turns a `SavedConnection` into driver options + credential material. Knows nothing about UI or HTTP. |
| `LiveConnection` | A connected, pooled, named session. Owns state, refresh, teardown, and error surface. Everything above it depends only on this. |
| `MongoClient` | The official Node driver. Created once per `LiveConnection`. |

**The single rule that keeps this clean:** no code above `LiveConnection` ever sees a connection
string or a credential. `explorer/` services take a `LiveConnection`. Route factories take services.
Nothing else touches auth.

---

## `IConnectionStrategy` — the contract

Sketch, to be firmed up during implementation:

```typescript
/** Turns saved connection configuration into a usable driver connection. */
export interface IConnectionStrategy {
    /** Discriminator matching SavedConnection.strategyKind. */
    readonly kind: ConnectionStrategyKind;

    /** Human-readable label for the connection UI. */
    readonly displayName: string;

    /** Validates configuration before any network attempt is made. */
    validate(config: SavedConnection): ConnectionValidationResult;

    /** Produces the URI and MongoClientOptions needed to connect. May acquire tokens. */
    buildClientOptions(config: SavedConnection, context: ConnectionContext): Promise<BuiltClientOptions>;

    /** Whether this strategy's credentials expire and need refreshing. */
    readonly requiresRefresh: boolean;
}
```

`ConnectionContext` carries the acting app user and a channel for **interactive prompts** — device
codes, MFA notices, consent URLs. Interactive auth is not an edge case here; it's the main path. The
contract must support "strategy needs to tell the human something mid-connect" from day one, rather
than being retrofitted. That channel is the reason connection state flows over Socket.IO.

---

## Strategies to support

Ordered by build priority.

### 1. Connection string (phase 1)
Paste a full `mongodb://` or `mongodb+srv://` URI. Covers local dev, self-hosted, and Atlas with
SCRAM. This is the strategy we can fully build and test on this machine.

### 2. SCRAM (username / password fields) (phase 1)
Same underlying mechanism, friendlier UI: host, port, database, username, password, auth source,
TLS toggles. Users shouldn't have to hand-assemble a URI.

### 3. Azure Entra ID / OIDC (phase 2 — **the reason for the project**)
See [research/azure-vcore-oidc.md](research/azure-vcore-oidc.md) for the technical detail and the
open verification items. Sub-modes to accommodate:

| Sub-mode | When it applies |
|---|---|
| Device code flow | Interactive human login on a machine without a usable browser redirect |
| Authorization code + PKCE | Interactive human login with a browser available |
| Managed identity | App running in Azure, no human present |
| Client credentials (service principal) | Automation, CI |

All four differ only in *how the access token is obtained*. Once a token exists, the handoff to the
driver is identical. Structure the code so the token-acquisition step is itself pluggable inside the
OIDC strategy — a sub-strategy — rather than four near-duplicate classes.

### 4. X.509 client certificate (phase 3)
Certificate + key files, TLS CA. Common in hardened self-hosted deployments.

### 5. SSH tunnel wrapper (phase 3)
Not an auth mechanism — a **transport decorator** that wraps any other strategy. Model it as a
wrapper, not a fifth strategy kind, or the matrix explodes.

### 6. AWS IAM (phase 4, if ever)
Listed for completeness. Low priority for our needs.

---

## Connection state machine

`LiveConnection` state must be explicit and visible in the UI. Guessing at connection health is how
these tools become frustrating.

```
disconnected
    │ connect()
    ▼
authenticating ──► awaiting-user-interaction ──┐   (device code, consent, MFA)
    │                                          │
    ▼◄─────────────────────────────────────────┘
connecting
    │
    ▼
connected ──► credential-expiring ──► refreshing ──► connected
    │                                     │
    │                                     └──► auth-failed
    ├──► reconnecting ──► connected
    ├──► auth-failed
    └──► disconnected  (user closed, or fatal error)
```

Notes:

- `awaiting-user-interaction` is the state Compass's model has no room for. It's why we need it.
- `credential-expiring` exists so the UI can warn *before* an operation fails, not after.
- Every transition is emitted over Socket.IO so open tabs agree on reality.

---

## Credential handling rules

1. **Secrets never leave the server** in a readable form. The client sends them once when saving a
   connection; the API never returns them.
2. **Encrypt secrets at rest** in the metadata DB. Encryption key comes from `app-config.json` /
   env var, never from source.
3. **Tokens are memory-only.** Never persisted, never logged, never included in error responses.
4. **Redact aggressively in logs.** Connection strings get scrubbed of credentials before any log
   write. Write the redaction helper early — retrofitting it means auditing every log call.
5. **Offer "don't save the password."** Prompt at connect time instead. Some users will require this.
6. **Per-connection read-only flag.** A user-set guard rail against fat-fingering a drop on prod.

---

## What to build on *this* machine vs. the work machine

| Buildable here (no Azure access needed) | Requires the work machine |
|---|---|
| `IConnectionStrategy` contract | Verifying the vCore token audience/scope |
| `LiveConnection` + state machine | Confirming vCore accepts `MONGODB-OIDC` at all |
| `ConnectionManager` + pooling | Whether the username field must carry the Entra principal |
| Connection-string and SCRAM strategies | Real device-code / auth-code round trip against the tenant |
| Interactive-prompt plumbing (Socket.IO) | Token refresh behavior against a live cluster |
| `AzureOidcStrategy` **structure**, with `// TODO-Immediate:` at the token-acquisition seam | Any end-to-end success claim |

Build the whole scaffold of the OIDC strategy here, with the token acquisition stubbed behind an
interface and a fake implementation for tests. Then on the work machine, the remaining work is
filling in one method and iterating on real errors — not designing under pressure with a broken
connection in front of you.
