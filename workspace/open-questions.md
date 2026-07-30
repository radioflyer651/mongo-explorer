# Open Questions

Decisions needed. Grouped by when they must be answered — the top group blocks work, the rest can
wait.

---

## Blocking — needed before or during Phase 1

### 1. Secret encryption at rest
Saved connections may hold passwords. Proposed: AES-256-GCM with a key from `app-config.json` /
env var, secrets never returned by the API.

**Question:** good enough, or do you want secrets never persisted at all (prompt on every connect)?
A middle option is a per-connection "remember password" toggle, defaulting to off.

### 2. App user model — ~~open~~ **RESOLVED**
Answered by [engineer-design.md § Usage](engineer-design.md#usage): **single-user, localhost only, not
served outside the local machine.**

Consequences (details in that document): no user scoping on saved connections, no registration or
roles, server binds `127.0.0.1`, app login is a local lock rather than a security boundary and is off
by default. This reverses my earlier inclination to scope connections by user — with one user and no
network exposure, ownership columns are ceremony.

Credential encryption at rest (Q1) is **not** affected — that threat is anything that can read the
file, which doesn't care how many users there are.

### 3. Extended JSON library choice
`bson`'s `EJSON` ships with the MongoDB driver, so it's free. **Question:** any objection to standing
on that rather than adding a dependency?

### 4. Testing framework
**Question:** Jest, Vitest, or Node's built-in test runner on the server? Karma/Jasmine (Angular
default) or something else on the client? The playbook doesn't specify, and there's no existing
convention in it to inherit.

---

## Important — needed before Phase 2

### 5. Does the app login double as the Azure login?
Architecturally I've kept app auth and database auth strictly separate — a cleaner model, and it
means non-Azure connections don't drag Entra ID into the picture.

But there's a tempting shortcut: if you sign into Mongo Explorer *with* Entra ID, that identity could
be reused for vCore connections, and connecting becomes zero-friction.

**Question:** is single-sign-through a goal, or is separation preferable? This changes the auth
design meaningfully, so it's worth answering before Phase 2 rather than during it.

My recommendation: keep them separate initially, and add SSO-through later as an *optional* mode on
the OIDC strategy. Separation is the reversible choice.

### 6. Which OIDC sub-mode matters most at work? — **narrowed**
Because the app is local-only, the server can bind a `http://localhost:<port>/oauth/callback` redirect
and open the system browser. That makes **authorization code + PKCE** both the nicest UX and the
easiest to implement — easier here than in a hosted app. Treating it as the default, with device code
as the fallback for when a browser redirect isn't usable.

Still worth confirming which your tenant actually permits, and whether an existing `az login` token
cache can be reused to skip the interactive step entirely.

### 7. Cluster-side prerequisites
Is Entra ID auth actually **enabled** on the target vCore cluster, and do you have the access to check
or enable it? If not, that's a dependency on someone else and worth starting now — it has a lead time
that code doesn't.

---

## Deferrable

### 8. MCP endpoint authentication
`[Judgment, deferred]` No auth token on `http://127.0.0.1:27050/mcp` in the initial version — anything
that can reach loopback on this machine can already read `app-config.json`, which holds the real
credentials, so a token would be ceremony.

**This assumption must not be silently inherited.** If the app ever becomes non-local, or the server
binds anything other than `127.0.0.1`, the MCP endpoint needs auth before that change ships.

### 9. Git repository
This folder is not a git repo yet. `.gitignore` is in place. Say the word and I'll `git init` — I
didn't want to do it unasked. Remote hosting (GitHub, Azure DevOps) also undecided.

### 10. Deployment target
Where does this eventually run at work — local only, a container, an internal host, an Azure App
Service? Affects whether managed identity is even available as a strategy, but not Phase 1.

### 11. Whether the OIDC work should ship upstream
If the `ALLOWED_HOSTS` hypothesis in
[research/azure-vcore-oidc.md](research/azure-vcore-oidc.md) turns out to be the whole story, that's
arguably a Compass bug report or docs contribution, not just our workaround. Worth noting once we
know.

### 12. Angular Material vs. PrimeNG for the data grid
The playbook specifies PrimeNG, and its table is capable. But a document grid with inline BSON editing
is the most demanding UI in this app. **Question:** stay on PrimeNG's table, or evaluate a
purpose-built grid when Phase 3 arrives? Not worth deciding now — just flagging that Phase 3 may
reopen it.
