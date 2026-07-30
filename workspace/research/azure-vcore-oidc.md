# Research — Azure Cosmos DB for MongoDB (vCore) + OIDC / Entra ID

**Status: hypotheses, not verified.** Nothing in this document has been tested. There is no access to
an Azure vCore cluster or the relevant tenant from this machine. Everything below is labelled with a
confidence level, and the whole file is written to be *falsified* on the work machine.

| Label | Meaning |
|---|---|
| `[Confident]` | Documented driver/spec behavior; low risk of being wrong |
| `[Likely]` | Strong inference, consistent with how the pieces work, but not confirmed |
| `[Unverified]` | Guess or unknown. Do not build on it without checking. |

---

## The mechanism the driver offers

`[Confident]` The MongoDB Node.js driver (v6.x) supports `authMechanism=MONGODB-OIDC`. It exposes
two configuration routes via `authMechanismProperties`:

**1. Built-in environments** — the driver acquires the token itself:

```
ENVIRONMENT=azure        # Azure IMDS / managed identity
TOKEN_RESOURCE=<audience>
```

**2. Programmatic callbacks** — *we* acquire the token and hand it over:

```typescript
new MongoClient(uri, {
    authMechanism: 'MONGODB-OIDC',
    authMechanismProperties: {
        // Machine / non-interactive flows:
        OIDC_CALLBACK: async (params) => ({ accessToken, expiresInSeconds }),
        // Human / interactive flows:
        OIDC_HUMAN_CALLBACK: async (params) => ({ accessToken, expiresInSeconds, refreshToken }),
        ALLOWED_HOSTS: ['*.mongocluster.cosmos.azure.com'],
    },
});
```

`[Confident]` The callback receives IdP info supplied by the server plus a timeout/abort signal, and
returns the token. This is the seam that makes the project viable: **we can bring our own token
acquisition** — `@azure/identity` or `@azure/msal-node` — instead of depending on the driver or
Compass supporting Azure vCore natively.

---

## ◈ Leading hypothesis: `ALLOWED_HOSTS` is the wall

`[Likely]` For human/interactive OIDC flows, the driver enforces an `ALLOWED_HOSTS` allow-list as a
security measure, so a malicious server can't induce a client to send tokens somewhere unexpected.
Its **default value covers MongoDB's own domains** (`*.mongodb.net` and siblings) plus localhost.

`[Likely]` An Azure vCore cluster hostname looks like `<cluster>.mongocluster.cosmos.azure.com` —
which is **not** in that default list.

`[Unverified but high-value]` If a client (Compass included) does not let you override
`ALLOWED_HOSTS`, human OIDC against Azure vCore fails before any token is even requested — and the
resulting error can easily look like "OIDC isn't supported here" rather than "this host isn't
allow-listed."

**Why this matters:** if true, it explains the exact symptom ("we can't connect via OIDC") *and* it
means Mongo Explorer wins simply by exposing a setting Compass doesn't. That would be a very cheap
victory. **Test this first** — before writing any MSAL code.

First thing to try on the work machine: a ~20-line Node script with `MONGODB-OIDC`, an explicit
`ALLOWED_HOSTS: ['*.mongocluster.cosmos.azure.com']`, and a hand-pasted access token from
`az account get-access-token`. That single script either collapses the problem or tells us where the
real wall is. Put it in [../../scripts/](../../scripts/) when written.

---

## Open technical unknowns

### Token audience / resource
`[Unverified]` What value does `TOKEN_RESOURCE` / the token scope need? Candidates to check:

- `https://ossrdbms-aad.database.windows.net/.default` — used by Azure Database for PostgreSQL and
  MySQL Flexible Server. Plausible reuse, but Cosmos is a different service family.
- A Cosmos-specific resource URI.
- The cluster's own hostname as the audience.

Do not guess this in code. Get it from `az` CLI output or Azure docs on the work machine, then record
the answer here.

### Does the cluster advertise OIDC?
`[Unverified]` Whether Entra ID auth is enabled on the target cluster is a **server-side
configuration**, possibly requiring an admin to turn it on and to map the Entra principal to a
database user. If it isn't enabled cluster-side, no client-side cleverness helps. Confirm this early —
it's the difference between "our tooling is wrong" and "the cluster isn't configured."

### Username field semantics
`[Unverified]` Whether the connection needs a username carrying the Entra principal (UPN or object
ID), or whether the token alone identifies the principal.

### Refresh behavior
`[Likely]` Entra access tokens are short-lived (typically ~60–90 min). The driver re-invokes the
callback when it needs a fresh token, so our callback must be cheap and cached — MSAL's token cache
handles this if we use it correctly rather than acquiring on every call.

### vCore compatibility quirks
`[Unverified]` vCore is substantially more wire-compatible than Cosmos RU mode, but confirm before
relying on: `retryWrites`, `$lookup` behavior, index creation options, and which admin commands are
available. Feature detection at connect time is safer than a hard-coded compatibility matrix — but
don't build that until we've seen the real gaps.

---

## Implementation implications for this repo

1. `AzureOidcStrategy` **must** set `ALLOWED_HOSTS` explicitly, and expose it as user-editable
   configuration. Do not rely on the default.
2. Token acquisition sits behind its own interface (`IOidcTokenProvider`) with implementations per
   sub-mode (device code, auth code + PKCE, managed identity, client credentials) plus a fake for
   tests. Buildable and unit-testable here without Azure.
3. The interactive-prompt channel described in
   [../connection-and-auth.md](../connection-and-auth.md) is a **hard requirement**, not a nicety —
   device code flow is unusable without it.
4. Prefer `@azure/identity` first (it wraps the common credential types and handles caching); drop to
   `@azure/msal-node` only if we need control it doesn't give us. Neither is installed yet —
   deliberately, since the choice should follow the first successful handshake, not precede it.
5. Log OIDC failures with the driver's raw error intact (minus the token). The failure mode here is
   opaque errors; we should not add to that.

---

## Verification checklist — run on the work machine

- [ ] Confirm Entra ID auth is enabled on the target vCore cluster (ask the cluster admin)
- [ ] Get a token via `az account get-access-token --resource <candidate>` and inspect its `aud` claim
- [ ] Minimal Node script: `MONGODB-OIDC` + explicit `ALLOWED_HOSTS` + pasted token → does it connect?
- [ ] If it connects: record the exact working resource, host pattern, and username handling **here**
- [ ] If it fails: capture the full driver error and the server's OIDC handshake response
- [ ] Then, and only then, wire real MSAL / `@azure/identity` token acquisition
