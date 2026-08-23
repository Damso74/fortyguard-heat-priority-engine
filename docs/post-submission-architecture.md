# Post-submission architecture — authentication and shared storage

> **Design only. None of this is implemented, and none of it should be
> implemented before the submission is filed.** No code under `app/`,
> `components/`, `lib/`, `tests/`, `scripts/` or `data/` changes because this
> document exists. It is written now so the decision is on record while the
> reasons are fresh, and so the two known limitations below have a named
> successor instead of an open question.

## The two gaps this closes

### 1. There is no authentication, and the product says so

An export records a **named self-attestation**: a free-text name, bound to the
run id and to the digest of the audit trail as it stood when the plan was
reviewed. The binding is real — a name cannot be moved to a different run or a
different trail. The *name* is not: nothing establishes that the person who typed
it is that person. Every surface states this, which is the honest handling of an
unauthenticated product, but it is a ceiling. A municipal reviewer signing off an
inspection programme needs an identity that somebody else can check.

### 2. Two stores are per-process or per-tab, and both lose work

| Store | Where | Holds | Lost when |
|---|---|---|---|
| `lib/agent/run-store.ts` | Server, in-memory `Map`, FIFO, 32 runs | Completed runs, so an export can freeze one | The instance recycles, or the export is routed elsewhere |
| `hpe-demo-workspace-v1` | Browser `sessionStorage` | `{ runId, missions, planVersion }` — the demo field workspace | The tab closes; never shared between people or devices |

The run store fails in the safe direction: a miss is a `409` asking for a re-run,
never a regenerated CSV. That is correct and it should stay correct. But on a
serverless platform two requests seconds apart can land on two instances, so an
export can fail for a reason the user cannot see or fix.

The workspace is worse in a different way: an inspection programme where the
mission list dies with the tab, and where two people cannot see the same queue,
is a demonstration of a workflow rather than the workflow.

---

## Recommended choice

**Managed Postgres as the single system of record, plus OIDC single sign-on
against the operator's existing identity provider, via a server-side session
cookie.** One database, one identity source, no new moving parts beyond those
two.

| Concern | Choice | Why this one |
|---|---|---|
| Durable storage | **Managed Postgres** (Neon, Vercel Postgres, RDS — the vendor is not the decision) | Runs, audit events, attestations and evidence are relational, queried by id, and must outlive a process. Transactions are what make "append the attestation to the trail that exists" a single atomic fact rather than a hopeful sequence. |
| Large run bodies | **Compressed JSONB column**, moving to object storage only if a measured p99 row exceeds a few hundred KB | A run is already normalised to centroid-plus-template. Adding S3 before there is a size problem buys a second consistency boundary for nothing. |
| Caching | **None initially.** Postgres by primary key is fast enough for an export click | The current `byCacheKey` map exists to avoid re-running the engine for an identical request; that becomes a unique index, not a Redis. |
| Identity | **OIDC via the operator's IdP** (Entra ID, Google Workspace, Okta), through Auth.js or an equivalent | The reviewers already have accounts somewhere. Issuing our own credentials means owning password reset, lockout and breach response for a pilot. |
| Session | **Server-side session, `httpOnly` `Secure` `SameSite=Lax` cookie, opaque id** | A JWT in a cookie cannot be revoked before it expires. A reviewer who leaves must stop being able to attest immediately. |
| Authorisation | **Two roles: `analyst` and `reviewer`.** Read stays anonymous | Roles multiply badly. Two cover the actual decisions: build a plan, and accept evidence or attest an export. |

### Explicitly rejected

- **Redis as the run store.** A cache with eviction semantics is what we have
  already, with a network hop added. The problem is durability, not speed.
- **Self-hosted credentials.** Storing password hashes for a pilot is taking on
  the most-attacked surface in the product to save an IdP integration.
- **JWT-only sessions with no server state.** Attestation must be revocable.
- **Requiring sign-in to view.** The public read-only demo is a submission
  artefact and part of how the work is judged. Locking it would remove that for a
  benefit nobody asked for.
- **Making the client the source of truth for evidence.** The current design
  refuses to trust a posted plan. Adding auth must not be the moment that
  changes.

---

## Trust boundaries

```
┌─ Untrusted ────────────────────────────────────────────────────────────┐
│ Browser. Holds a session cookie it cannot read. May send any runId,    │
│ any name, any observation. Everything it sends is a request, not a     │
│ fact. Nothing it stores is authoritative.                              │
└────────────────────────────┬───────────────────────────────────────────┘
                             │ HTTPS, session cookie, CSRF token
┌─ Trusted: Next.js server ──▼───────────────────────────────────────────┐
│ Resolves identity from the session — NEVER from the request body.      │
│ Enforces role. Derives run ids. Appends audit events. Freezes exports. │
│ Still cannot reach the FortyGuard API by any path. Unchanged.          │
└──────┬───────────────────────────────┬─────────────────────────────────┘
       │ SQL, least-privilege role     │ OIDC redirect + code exchange
┌──────▼─────────────────────┐  ┌──────▼─────────────────────────────────┐
│ Postgres. System of record.│  │ Identity provider. EXTERNAL trust       │
│ Audit tables are           │  │ anchor. We trust it for "who", and for  │
│ append-only by grant, not  │  │ nothing else. No profile data is used   │
│ by convention.             │  │ for authorisation beyond group → role.  │
└────────────────────────────┘  └─────────────────────────────────────────┘

┌─ Outside every boundary above, and staying there ──────────────────────┐
│ scripts/fortyguard/capture.mjs on an operator machine. The only path   │
│ that spends a credit. Auth and shared storage give it no new reach and │
│ must not: no authenticated user may become a way to submit a request.  │
└────────────────────────────────────────────────────────────────────────┘
```

Four rules that survive the change, and are the point of drawing the diagram:

1. **The name on an attestation comes from the session, never from the body.**
   The moment `attestedBy` is read from JSON while a session exists, authenticated
   attestation is theatre.
2. **The audit trail stays append-only**, enforced by database grants — the
   application role gets `INSERT` and `SELECT` on audit tables and neither
   `UPDATE` nor `DELETE`. A trail that the application can rewrite is a log.
3. **An export still freezes a stored run.** Durable storage removes most `409`s;
   it must not remove the refusal. A run that has aged out is still a re-run, not
   a recomputation.
4. **No authenticated path reaches FortyGuard.** Authentication is about who may
   attest, not about who may spend.

### What authentication changes about the claims

This is a claim-registry change, not only a code change. `lib/claims/registry.ts`
and `docs/limitations-and-claims.md` currently state that the attestation name is
unverified by construction. Once identity is real:

- new attestations may say **"attested by an authenticated reviewer"**, recording
  the IdP subject id alongside the display name;
- **existing exports do not get upgraded.** They were self-attestations and stay
  labelled as such. Retroactively relabelling a past claim because the mechanism
  improved is exactly the kind of drift this project is built to prevent;
- the record must carry *which* mechanism applied, so a reader can tell the two
  apart without knowing the deployment date.

### Personal data, which the product does not currently hold

Reviewer names, IdP subject ids and field observations tied to a person are
personal data. A durable store means retention becomes a decision rather than an
accident of process lifetime: state a retention period for sessions and for
observations, keep the audit trail (which is the point) but make it queryable by
subject, and write down who may read it. This does not need to be solved before
phase 1, but it must not be discovered after phase 3.

---

## Migration

### From the in-memory run store

The current module is already the right shape: `rememberRun`, `recallRun`,
`recallByCacheKey`, `cacheKeyFor`. Extract that surface as a port, add a Postgres
adapter, keep the in-memory one for tests and local development.

| Today | After |
|---|---|
| `Map<runId, StoredRun>`, FIFO at 32 | `runs` table, primary key `run_id`, retention by age |
| First write wins, by explicit check | `INSERT ... ON CONFLICT (run_id) DO NOTHING` — the same rule, enforced by the database |
| `byCacheKey` map | `cache_key` unique index on `runs` |
| `requestSha256` for defence in depth | Same column, same check |
| Miss → `409`, re-run | Unchanged. Miss now means aged out, not routed elsewhere |
| `clearRunStore()` test seam | Transaction rollback per test, or the in-memory adapter |

The run id derivation does **not** change: `sha256(request + dataset canonical
hash + engine version + thermal attestation digest)`, timestamps excluded. That
is what makes a re-run after a `409` produce the same id, and it is what lets two
instances agree without coordinating.

Cutover is boring on purpose: dual-write to both stores, read from Postgres with
the memory store as fallback, then drop the fallback once the miss rate at the
Postgres read is zero over a week of real use.

### From `sessionStorage`

`hpe-demo-workspace-v1` holds `{ runId, missions, planVersion }` for one tab. It
becomes a `workspaces` row keyed by `(user_id, run_id)`, with `missions`,
`observations` and `plan_version` as related rows.

The migration is a **replacement, not a data migration**. Nothing in
`sessionStorage` is worth carrying across: it is demo-labelled session data by
design, and importing it would mean trusting client-held state at exactly the
moment the product starts making identity claims. On first authenticated load the
server seeds a fresh workspace from the run's selected stops, the same way
`missionSeed` does today. The reset action becomes a server-side delete.

Two properties must survive, or the workflow loses what makes it defensible:

- **Field observations stay outside the thermal model until a reviewer acts.**
  Shared storage makes observations visible to more people; it must not make them
  an input to the ranking.
- **The demo label survives.** An observation captured in a demonstration stays
  marked as one after it is stored in a real database. Durability is not
  provenance.

---

## Sequencing

Four phases. Each ships on its own, each is reversible on its own, and no phase
depends on a later one.

**Phase 0 — decide, before writing anything.** Which Postgres, which IdP, which
groups map to `reviewer`. Whether anonymous read stays (recommendation: yes).
Retention periods for runs, sessions and observations. Written down, then built.

**Phase 1 — durable run store.** Port plus Postgres adapter, dual-write, then
read-through. No user-visible change except that exports stop failing for a
reason the user cannot act on. *No authentication in this phase* — this is the
smaller, higher-value half, and coupling it to identity delays it for nothing.

**Phase 2 — authentication, read-only.** Sign-in, session, role resolution, the
identity shown in the header. Nothing yet *requires* it: attestation still
accepts a typed name, and the export still labels it a self-attestation. This
phase exists to get sessions, revocation and role mapping wrong in a place where
being wrong is cheap.

**Phase 3 — authenticated attestation and review.** Attestation and evidence
review require `reviewer`. The name comes from the session. New records carry the
authenticated mechanism; old ones keep theirs. Claim registry and documentation
updated in the same change, because a product whose docs lag its claims is the
failure mode this repository is organised against.

**Phase 4 — shared workspace.** Missions, observations and plan versions move
server-side. `sessionStorage` is removed, not deprecated in place.

---

## Acceptance criteria

Written as things that can fail, because a criterion that cannot fail is a
sentence.

### Phase 1 — durable run store

- A run computed by one process is exported successfully by a **different**
  process, asserted by a test that runs the two against the same database.
- A run id that was never stored, or has aged out, returns `409` with the re-run
  message. The engine is not called: asserted by a spy.
- Re-running the identical request after a `409` reproduces the **same run id**.
- Two concurrent `INSERT`s of the same run id leave exactly one row, and the
  first one written is the one that is read back.
- Exported audit timestamps equal the ones recorded at run time. No timestamp is
  regenerated by an export. This is the existing guarantee; it must still hold.
- The application database role has no `UPDATE` or `DELETE` on audit tables, and
  a test asserts that an attempted update fails.

### Phase 2 — authentication

- No API route reads an identity from a request body while a session exists.
  Enforced by a test that walks the route handlers, in the spirit of the existing
  test that keeps the capture path out of `app/` and `components/`.
- Signing out invalidates the session server-side: a replayed cookie is rejected,
  not merely absent from the UI.
- Anonymous users can still load the overview, the planner and the methodology
  page, and an end-to-end test asserts it.
- Session cookies are `httpOnly`, `Secure`, `SameSite=Lax`, and carry no identity
  data — only an opaque id.
- No IdP token, refresh token or client secret appears in a log, an audit record
  or an export. The existing redaction test is extended, not duplicated.
- **No deployed route can spend a FortyGuard credit as an authenticated user.**
  The existing guard test passes unchanged, with a signed-in fixture added.

### Phase 3 — authenticated attestation

- An export produced by a signed-in reviewer records the IdP subject id, the
  display name **from the session**, and the mechanism `authenticated`.
- Posting a different name in the body while signed in does not change the
  recorded name.
- A user without the `reviewer` role gets `403` on attestation and on evidence
  review, and the plan version does not advance.
- Exports produced before this phase still read `self-attested, unverified` when
  re-read. A test loads a stored pre-migration record and asserts the label.
- The claim registry, the methodology page and
  `docs/limitations-and-claims.md` all describe the same two mechanisms, and the
  existing registry-versus-docs drift test covers the new entries.

### Phase 4 — shared workspace

- Two authenticated sessions on different devices see the same mission list for
  the same run.
- Closing a tab loses nothing. Reopening restores the workspace from the server.
- An accepted observation still creates plan version 2 and still does **not**
  alter the thermal ranking, asserted by comparing rankings before and after.
- Demo-labelled observations remain labelled after a round trip through the
  database, asserted on the stored row and on the export.
- `sessionStorage` no longer appears anywhere in `components/`, asserted by a
  test — the same technique the repository already uses to keep guarantees from
  decaying into conventions.

---

## What this does not solve

Authentication does not make a modelled exposure figure a measurement, does not
make the anomaly persistent, and does not widen the 27-stop pilot to a city. It
raises the attestation from *a name somebody typed* to *a person an organisation
recognises*, and it stops an export failing for reasons the user cannot see.
Those are the two problems it is for.
