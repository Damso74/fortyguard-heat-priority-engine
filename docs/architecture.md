# Architecture

## Shape of the system

A single Next.js application (App Router, TypeScript strict) with a Python data
pipeline in front of it. No database, no authentication, no message queue. The
analysis is deterministic, which removes an entire class of staleness bugs and
makes every result reproducible from its inputs; the only server-side state is a
bounded in-memory store of **completed runs** (`lib/agent/run-store.ts`), kept so
that an export can freeze a run rather than execute it a second time.

What that costs, and what would replace it, is set out in
[`post-submission-architecture.md`](post-submission-architecture.md). Nothing in
that document is implemented.

```
┌─ Python, run ahead of time ────────────────────────────────────────────┐
│  scripts/fetch/fetch_arcgis.py       paginated, hash-verified download │
│  scripts/spike/analyze_shadefirst.py join + audit → 19 baseline metrics│
│  scripts/generate/build_analysis_dataset.py → data/generated/*.json    │
│  scripts/fortyguard/run_fortyguard_probe.py  capability probe (live)   │
└────────────────────────────────────────────────────────────────────────┘
                                    │  committed artefacts + SHA-256
                                    ▼
┌─ Next.js server ───────────────────────────────────────────────────────┐
│  app/api/plans          POST → executeRun()  → RunResult, remembered   │
│  app/api/plans/export   POST → recallRun(runId) + finalizeRun() → CSV  │
│  app/api/plans/detail   POST → recallRun(runId) → per-stop detail      │
│  app/api/fortyguard/status GET → booleans only, never the key          │
│  app/page.tsx + /heat /planner /missions /evidence /scenarios          │
│    /reports /methodology  server components: env booleans + provenance │
│  Nothing here can reach the FortyGuard API. There is no capture route. │
└────────────────────────────────────────────────────────────────────────┘

┌─ Local operator machine only ──────────────────────────────────────────┐
│  scripts/fortyguard/capture.mjs  THE ONLY PATH THAT SPENDS A CREDIT.   │
│    Refuses to run when VERCEL / AWS_LAMBDA / NETLIFY / CF_PAGES /      │
│    GITHUB_ACTIONS / CI is set. Durable checkpoint per submission,      │
│    activity-id resume, exclusive lock against a concurrent run.        │
│    Writes an immutable snapshot; a human reviews and commits it.       │
└────────────────────────────────────────────────────────────────────────┘
                                    │  JSON
                                    ▼
┌─ Browser ──────────────────────────────────────────────────────────────┐
│  CivicShell + OperationsProvider  → OverviewPage, HeatMonitor,         │
│    MissionsBoard / FieldMission, EvidenceReview, ScenarioLab,          │
│    ReportsAudit, and the planner surface: RunControls, ResultList,     │
│    StopDetail, QuadrantMatrix, RunSummary, ModeBanner,                 │
│    PriorityMap (dynamic, ssr:false)                                    │
│  The demo field workspace lives in sessionStorage, per tab.            │
└────────────────────────────────────────────────────────────────────────┘
```

## The run pipeline

`lib/agent/run.ts` is the whole orchestration. Each step writes an audit event, and
the state machine in `lib/agent/state-machine.ts` rejects any transition that skips
or reverses a step.

```
created → validating → tiling → normalizing → quality_gate → scoring
        → awaiting_approval → approved → exported
                          ↘ blocked / failed / cancelled
```

`submitted` and `polling` are no longer reachable from a run. The thermal layer is
resolved **before** the run id is derived, from one of two sources that never
touch the network:

1. a committed immutable snapshot for the area and date, when one exists and
   `DATA_MODE` permits it;
2. the labelled synthetic fixture.

Resolving thermal first is what lets the run id cover the surface the plan was
built on. Without that, two runs against different surfaces shared an id and an
export could not be checked against its own numbers.

`DATA_MODE=cached_real` makes the snapshot mandatory rather than best-effort: if
none answers the request the run fails. A deployment that asked for real data and
silently served synthetic data is the failure the whole arrangement prevents.

## Decisions and their reasons

### An export freezes a stored run; it never re-executes one

*(This section previously described the opposite arrangement — "stateless,
deterministic re-execution instead of a run store". That design was replaced; see
[An export freezes a run](#an-export-freezes-a-run) below for why.)*

An export never trusts a plan posted back by the browser, and it never runs the
engine again. `/api/plans` remembers each run it computes in a bounded in-memory
store; `/api/plans/export` looks the run up by the `runId` the client is
attesting to, appends the attestation and export records to the audit trail that
run already had, and writes it out. `/api/plans/detail` reads the same stored
run, so the detail panel and the exported CSV cannot disagree.

Four consequences: an export can never disagree with the audit trail; the client
cannot smuggle in a doctored ranking; the exported timestamps say when the
analysis happened rather than when somebody clicked download; and a run this
process no longer holds is a `409` asking for a re-run rather than a quietly
regenerated CSV.

Determinism is still what makes the arrangement safe — a re-run of the same
request reproduces the same run id, so a `409` costs the user a click and not a
different answer. The run id is
`sha256(request + dataset canonical hash + engine version + thermal attestation
digest)`, deliberately excluding timestamps — otherwise the same analysis would
be unverifiable an hour later. It is the *attestation* digest, not the surface
digest, for the reason given in
[The run id covers the claim, not the numbers](#the-run-id-covers-the-claim-not-the-numbers).

### The decision unit is a grid cell, not a corridor

*(Superseded: the analysis grid was removed in the pivot. The decision unit is
the stop. This section is retained only to record why the grid was anchored the
way it was, and describes no code that still runs.)*

A zone was one cell of a 500 m analysis grid anchored to the (0°, 0°) origin, not to
the area of interest. Two properties follow: a zone id is stable across runs and
areas, so plans stay comparable; and zone boundaries do not move when the area
changes, so a stop cannot silently jump between zones.

Calling a group of stops a "corridor" would be a geographic claim no loaded dataset
supports. The `COOL_CORRIDORS` mode stays locked until official GTFS shapes exist.

### Provenance travels with the value

Every displayed number is a `Measured<T>` carrying `unit`, `provenance`, `source`,
`confidence` and an optional `caveat`. A bare figure with no lineage cannot reach a
screen, because the type does not permit one.

`ShelterStatus` is a tri-state with **no `unsheltered` member at all**. Reading a
null amenity field as a negative claim is a type error, not a review comment.

### The claim registry governs copy

`lib/claims/registry.ts` holds every statement the product may, may conditionally,
or may never make. `resolveAllowedClaims()` runs per-run and records the result in
the manifest. The methodology page renders the registry directly, so the published
limits are the enforced limits.

### Confidence is computed separately from priority

Mixing them would let a well-evidenced mediocre location outrank a poorly-evidenced
urgent one, or vice versa, with no way to tell which happened. They are two numbers:
priority answers *where*, confidence answers *how much to trust it*. A high-priority,
low-confidence location is a normal and important result — "look here first, expect
to verify."

### Gates decide the product, not the other way round

`lib/gates/product-mode.ts` selects among `SHADE_FIRST`, `COOL_CORRIDORS`,
`HEAT_PRIORITY_ZONES`, `SHADE_SURVEY` and `NO_GO_THERMAL_PRODUCT` from gate
outcomes. `SHADE_FIRST` requires a shelter inventory gate that no current data can
pass, so the ShadeFirst branding is unreachable — enforced by
`shadeFirstBrandingPermitted()` and asserted in tests.

### Tiling is a partition, verified structurally

`verifyCoverage()` proves the tiles exactly partition the area: `cols+1` longitude
edges and `rows+1` latitude edges spanning the bounds, every `(row, col)` slot
present exactly once, and each tile's bounds equal to the edge pair its indices
select.

It deliberately does **not** compare summed tile area against area-of-interest area.
Each rectangle's width in miles is evaluated at its own mid-latitude, so the parts
legitimately do not sum to the whole under that approximation — an area comparison
would produce false failures. This was a real bug caught by the first end-to-end run.

### The map is secondary and allowed to fail

The table carries the complete plan. `PriorityMap` is dynamically imported with
`ssr: false`, every failure path renders an explicit fallback, and an end-to-end
test blocks all basemap tiles and asserts the product still works.

## The corrective pass — what changed and why

Seven defects, all of the same family: something that read like a guarantee was a
label rather than a mechanism.

### The snapshot store holds real captures only

A file claiming `LIVE_FORTYGUARD` / `REAL`, carrying `act-1` and `act-2` as
activity ids and a confirmed degree-Celsius unit, with **zero cells**, was
committed to the production store. Nothing went red.

`realCaptureFailures` now decides what may be served as real data: no placeholder
activity ids, no near-empty surface, no confirmed unit without a confirmed field
and a confirmed meaning, no capture record inconsistent with its own request, and
a capability fingerprint matching the current manifest. Lookup compares the
**complete** request rather than area and date, and two files answering the same
request fail closed instead of being resolved by filename order.
`npm run check:snapshots` runs it in CI, including the store-level ambiguity check
that no per-file audit can see.

### The run id covers the claim, not the numbers

`deriveRunId` takes the snapshot's **attestation** digest. Two files whose numbers
agree while one says `LIVE_FORTYGUARD / REAL` and the other says `DEMO_SYNTHETIC`
are two different runs, and an export naming one must not verify against the
other. The fixture is expressed as an explicitly synthetic snapshot so that it has
an attestation too.

### One POST is one POST

`/v1/heatmap` is treated as non-idempotent: no published contract says otherwise,
and a 429, a 5xx, a timeout or a dropped connection can all follow a request the
server accepted. The retry loop that would have sent the same tile up to five
times is gone. A dropped POST is `AMBIGUOUS_SUBMISSION`, which stops the run for
manual reconciliation rather than resuming. The intent to submit is journalled
before the socket opens, the exclusive lock is taken inside `runCapture` before any
network call, and nothing runs without a positive `--max-new-submissions` plus two
independent live opt-ins.

### The gates constrain the algorithm

`resolveProductMode` returns the narrower of the evidence mode and the configured
one. Evidence computes the maximum permitted mode from the gates alone;
configuration may narrow and is refused if it asks to widen. The mode carries an
**axis set**, and `rankCandidates` masks a forbidden metric to `null` at its
boundary — so no percentile, front, tiebreak or quadrant can read it. Previously
the mode was a label printed beside a ranking that had always used both axes.

### Every holdout is validated on its own

The out-of-sample check averaged each position's z across the holdouts and then
correlated the fit against that average, so one aligned holdout and one inverted
one cancelled instead of failing. Each holdout is now scored separately with its
own denominator, and the aggregate is the weakest of them.

### An export freezes a run

`finalizeRun` built a new `AuditLog` and replayed every event through it,
regenerating each timestamp from the export's clock. It now **appends** to the
trail that exists. `/api/plans` records each run it computes; `/api/plans/export`
looks one up and refuses if this server no longer holds it. Nothing calls the
engine, reads a snapshot or recomputes an existing timestamp.

### The response carries what the screen draws

The full run was 5.58 MB decoded. Half was one rectangle repeated 10,212 times;
most of the rest was per-stop detail for the 816 stops nobody opened. The engine
normalises congruent cell footprints to centroid-plus-template once, so the
summary can factor it out losslessly, and per-stop detail and the audit move to
`/api/plans/detail` — read from the same stored run the export freezes, so the
panel and the exported CSV cannot disagree.

### Known limitation: the run store is per-process

`/api/plans` and `/api/plans/export` must reach the same instance for an export to
succeed. On a platform that may route them differently, an export can miss seconds
after the run. It fails in the direction of **refusing to export** rather than of
exporting something regenerated, which is the correct direction, but making it
durable needs shared storage — a deployment decision rather than a code one. The
option that would replace it is written up, and deliberately not built, in
[`post-submission-architecture.md`](post-submission-architecture.md).

## Determinism, concretely

| Source of nondeterminism | How it is removed |
|---|---|
| Object/Map iteration order | Every collection is explicitly sorted before use |
| Floating-point accumulation | Percentiles from a sorted copy with linear interpolation |
| Ties in ranking | Broken on candidate id |
| `Math.random` in the demo fixture | Replaced by an integer hash lattice |
| Backoff jitter | Injectable `random()`; tests pass a constant |
| Wall clock | Injectable `now()`; excluded from the run id |
| Host timezone | Dates computed in America/Phoenix explicitly |
| Python dict ordering in artefacts | Features sorted by `OBJECTID` before serialisation |
| Platform newline translation | `newline=""` on every Python write, so hashes match bytes |

## Testing strategy

- **Unit** (`tests/unit`) — pure logic in a Node environment: baseline metric
  regression, normalisation, scoring, selection, geometry, gates, state machine,
  audit redaction, CSV injection, cache keying.
- **Integration** (`tests/integration`) — the FortyGuard client against typed
  fixtures covering every documented failure mode plus several undocumented ones.
- **End-to-end** (`tests/e2e`) — Playwright against a **production build**,
  covering the full demo journey, the map-failure path, the no-key path, the API
  guards, keyboard reachability and mobile overflow.

There is no simulated DOM layer. Component behaviour is asserted in a real browser
against real markup, which keeps the assertions honest.

## Dependencies, and why each is present

| Package | Why |
|---|---|
| `next`, `react`, `react-dom` | App Router, server components, API routes |
| `zod` | Runtime validation of both inbound requests and untrusted API responses |
| `maplibre-gl` | Key-free map rendering |
| `@turf/*` | Geospatial primitives |
| `tailwindcss` | Styling, CSS-first theme |
| `vitest` | Unit and integration tests |
| `@playwright/test` | End-to-end against a production build |
| `eslint`, `typescript-eslint` | Static analysis |

No database, no ORM, no auth provider, no state library, no component library, no
LLM SDK. Each of those would have added surface without answering the product
question. The first two are the ones a real deployment would eventually need —
proposed, and deliberately not built, in
[`post-submission-architecture.md`](post-submission-architecture.md).
