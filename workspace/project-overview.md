# Project Overview — Mongo Explorer

## One-liner

A browser-based MongoDB administration and exploration tool, functionally comparable to MongoDB
Compass, whose distinguishing capability is connecting to **Azure Cosmos DB for MongoDB (vCore)**
via **Microsoft Entra ID / OIDC**.

---

## Why this exists

Compass covers the general case well. It falls down on one specific case that matters to us: on
Azure's MongoDB vCore offering, we cannot authenticate through OIDC. That blocks normal database
work on our work environment.

Rather than fight the tool, own the connection layer. Mongo Explorer treats "how do we authenticate
to this cluster" as a **pluggable strategy** rather than a fixed feature, so a new auth mechanism is
a new class, not a new product.

The general-purpose Compass-parity feature set is not a side quest — it's what makes the tool usable
day to day. But the OIDC path is the reason the project is justified.

---

## Two audiences, one app

| Audience | Needs |
|---|---|
| **Primary (us, at work)** | Reach Azure vCore clusters using Entra ID credentials. Read, query, and edit real data. |
| **Secondary (general)** | Any MongoDB deployment: local, self-hosted, Atlas, Cosmos RU-mode. Standard connection strings. |

Design for the secondary audience by default; make sure nothing in the architecture makes the
primary audience impossible. In practice that means: **never assume a connection string is the whole
story.**

---

## Guiding principles

1. **Connections are strategies, not strings.** See
   [connection-and-auth.md](connection-and-auth.md). Every feature above the driver layer works
   against an abstract "live connection," never against a connection string.
2. **The server owns all driver access.** The browser never talks to MongoDB. This is a hard
   boundary — it's what makes OIDC token brokering, credential handling, and SSH tunneling possible
   at all.
3. **App auth and database auth are separate axes.** Logging into Mongo Explorer is not the same
   act as authenticating to a cluster. Conflating them is the most likely early design mistake.
4. **"Internal DB" and "Target DB" are fixed vocabulary.** This app both uses MongoDB (our own store)
   and operates on MongoDB (the user's cluster). They are governed by different rules, and several
   standard conveniences are data-corrupting when applied to the wrong one. See
   [project-standards.md § Two MongoDB contexts](project-standards.md#-two-mongodb-contexts--read-this-before-anything-else).
5. **Read-safe by default, destructive by intent.** Deletes, drops, and mass updates require
   explicit confirmation and are visibly distinguished in the UI.
6. **No silent schema assumptions.** MongoDB is schemaless; the UI infers and displays shape but
   never enforces one.

---

## Explicit non-goals (for now)

- Not a BI/reporting tool. No dashboards, charts, or aggregation visual builders in phase 1.
- Not a migration tool. No cluster-to-cluster copy, no ETL.
- Not multi-tenant SaaS. Single deployment, small trusted user set.
- No support for non-MongoDB databases. Ever.
- Not a Compass replacement in fidelity of polish — in capability.

---

## Development environment caveat

**This machine is not the work machine.** The Azure vCore + Entra ID work cannot be tested here —
there is no access to the target cluster or tenant.

Consequences for how we build:

- All Azure/OIDC work here is **structural**: interfaces, strategy classes, config shape, and
  documented hypotheses. Marked `// TODO-Immediate:` where a real credential is required to finish.
- Everything else — UI, document browsing, querying, indexes, the connection-strategy abstraction
  itself — is fully buildable and testable here against a normal MongoDB instance.
- Work is expected to **resume on the work machine**. Keep [../PROJECT_STATUS.md](../PROJECT_STATUS.md)
  and the handoff notes current so that transition costs nothing.

---

## Related documents

- [architecture.md](architecture.md) — system shape, ports, data flow
- [connection-and-auth.md](connection-and-auth.md) — the connection strategy model
- [feature-scope.md](feature-scope.md) — phased feature list
- [project-standards.md](project-standards.md) — coding standards and project-specific deltas
- [open-questions.md](open-questions.md) — unresolved decisions
- [research/azure-vcore-oidc.md](research/azure-vcore-oidc.md) — what we believe about the OIDC path
