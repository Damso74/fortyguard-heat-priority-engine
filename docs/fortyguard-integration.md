# FortyGuard integration

Implementation: `lib/fortyguard/` (client, schemas, value-field whitelist, cache,
redaction, demo fixture) and `scripts/fortyguard/run_fortyguard_probe.py`.

---

## What is treated as documented fact

Read from <https://docs-api.fortyguard.com/> on 2026-08-04:

- Authentication is a single **`api-key`** request header. No OAuth, no token
  exchange.
- Submissions return an **`activity_id`**; results are retrieved from
  **`GET /v1/status/{activity_id}`**.
- Heatmap results carry **`data.result.map_data`** (a GeoJSON FeatureCollection)
  and **`data.result.stats_data`**.
- **`tcm`** values are **temperature in °C per tile**. `time_of_measure`,
  `exceedance` and `persistence` return **hours**.
- `granularity` accepts **60, 80 or 100** metres.
- Coverage is **United States only**.
- Credits are deducted **only on successful completion**; failed tasks cost
  nothing. *(Documented, and contradicted in practice: two valid requests
  returned `Completed` with zero cells and were charged — see
  `fortyguard-capability-report.md`, "Observed contract deviations".)*
- Documented status codes: `400/422` invalid, `401` missing/invalid key, `403`
  insufficient plan, **`404` activity not found or temporarily unavailable
  immediately after submission**, `429` rate limit, `500` server error. Activity
  states: `Processing`, `Completed`, `Failed`.

## What is treated as unverified

The historical OpenAPI download, removed from the tracked tree because its
redistribution terms were not established, declared every successful response as an empty schema (`{}`),
and the documentation shows response shapes only as illustrative JSON. Neither is a
guarantee. These are the positions the client takes when nothing has confirmed
the answer. Several are now settled *for the committed Downtown pilot only* — the
value field, the °C unit and an empirically supported AOI-local clock — and those
answers are bound into the capability fingerprint rather than promoted to
contract; see `fortyguard-capability-report.md`. The positions below still govern
every request the pilot does not cover:

| Question | Conflicting sources | Position taken |
|---|---|---|
| Property name carrying the temperature inside `map_data` | Not published anywhere | Closed whitelist; **fail loudly** on ambiguity or absence |
| Timezone of `start_time` | Undocumented; `time_of_measure` is documented as UTC | Work in America/Phoenix, send unchanged, record the assumption everywhere, probe it |
| Date floor | Docs say 2019-01-01; hackathon FAQ says 2021-01-01 | Enforce the **stricter** 2021-01-01 |
| `filter_type` range | Limitations page 1–3; endpoint page and OpenAPI 1–4 | Main path uses **1** only; probe tests 4 |
| Area ceiling | 10 mi² (Basic, Startup) / 50 mi² (Premium); marketing says "10 mi² resolution" | Default **9 mi² per tile**, configurable |
| Resolution | Marketing "10 mi²"; FAQ "~20 m"; API 60/80/100 m | Only the API enum is contractual |

---

## Client design

`lib/fortyguard/client.ts`.

### No key means no request

```ts
if (!this.apiKey) throw new FortyGuardError('NO_API_KEY', '… No request was made.')
```

This runs **before** any URL is constructed. A keyless deployment cannot produce a
401 that later reads like "we tried and the API was down". Asserted by a test that
counts fetch calls.

### Accepts any 2xx, records deviations

The docs show 200, but FastAPI applications routinely answer 201/202 for async
submissions. Any 2xx with a recoverable `activity_id` is accepted, and anything
that differs from the documented shape is recorded in `contract.notes` and
surfaced in the capability report:

- non-200 success status
- `activity_id` arriving somewhere other than `data.activity_id`
- FeatureCollection found somewhere other than `data.result.map_data`
- result delivered as a URL rather than inline

### Envelope tolerance

`extractActivityId()` accepts `data.activity_id`, `activity_id`,
`result.activity_id`, `data.activityId` and `activityId`, and reports which one it
found. `findFeatureCollection()` checks the documented path first, then performs a
depth-limited breadth-first walk, and reports the path used.

### Polling

- 404 inside a 45 s grace window is treated as "not yet visible" — the documented
  behaviour immediately after submission. After the window it is a hard failure.
- An **unrecognised** status word keeps polling rather than being assumed
  successful. The timeout bounds the loop.
- Terminal failure words stop immediately.
- 5 s intervals for the first six attempts, then 10 s.

### Retries, backoff, concurrency

**On a polling GET only.** Retryable: `429`, `5xx`, network failures. Not
retryable: `401`, `403`, `400/422`.

**No POST is ever retried**, whatever the status. See *Credit safety* below:
`/v1/heatmap` is treated as non-idempotent, so a retry can pay for the same
tile twice.
Backoff is exponential to a 30 s ceiling with 50–100% jitter; the jitter source is
injectable so tests are deterministic. A counting semaphore caps concurrent
submissions (`FORTYGUARD_MAX_CONCURRENCY`, default 2), asserted by a test that
tracks peak in-flight requests.

### Caching and resume

Keyed by a canonical hash of the request payload: keys sorted recursively,
coordinates rounded to 1e-7 degrees so tile arithmetic noise cannot fragment the
cache. `resumeActivityId` polls an existing activity without resubmitting, which
matters when a run is interrupted after credits have been spent.

### SSRF guard

If a completed activity points at a result hosted elsewhere, the URL is **returned,
not fetched**. The client then requires HTTPS and a host on an explicit allowlist
(`FORTYGUARD_RESULT_HOST_ALLOWLIST`, default `api.fortyguard.com`). Subdomains of an
allowlisted host are permitted; lookalikes such as `notfortyguard.com` are not.

### Secret handling

`lib/fortyguard/redact.ts` redacts **where data leaves the client**, not where it is
written, so a new call site cannot forget it. It strips the live key from any text,
replaces sensitive header values by name, and neutralises credentials in query
strings and bearer tokens. Errors carry redacted detail. Audit records are redacted
on the way in.

---

## Tiling

`lib/geo/tiles.ts`. The area of interest is partitioned into tiles that each stay
under the ceiling, and the partition is verified structurally — see
`docs/architecture.md`.

Central Phoenix is 39.8 mi² and becomes **6 tiles of ≤ 6.6 mi²**; with three
snapshots that is 18 submissions per run.

**This is the spike's main defect, fixed.** The spike submitted the whole ~34.9 mi²
panel as one polygon on the strength of a marketing figure. That request is rejected
on the 10 mi² plans a hackathon key is most likely to carry.

---

## Value-field resolution

`lib/fortyguard/value-field.ts`, mirrored in the Python probe.

The spike matched any property containing `temp` or `tcm` and then labelled the
result `°C`. That would happily pick `temp_flag`, or the first of two competing
fields. Detection is now a closed whitelist:

- only whitelisted names are eligible;
- a name must be numeric on ≥ 90% of features;
- **two qualifying names is a failure, not a coin flip**;
- **zero qualifying names is a failure**, reporting every property actually seen;
- an explicit `override` — recorded by the probe after a human has read the output
  — bypasses the whitelist and marks the unit as confirmed.

A failure here stops the pipeline on purpose. A wrongly identified field would
silently corrupt every score downstream, and the °C gate thresholds are only
unlocked once the unit is confirmed.

---

## Error handling matrix

| Condition | Kind | Behaviour |
|---|---|---|
| No key | `NO_API_KEY` | No request constructed at all |
| `401` | `UNAUTHORIZED` | Fail immediately, no retry |
| `403` | `FORBIDDEN` | Fail immediately, no retry |
| `400` / `422` | `BAD_REQUEST` | Fail immediately, redacted detail |
| `404` ≤ 45 s after submit | — | Treated as pending, keep polling |
| `404` after the grace window | `SCHEMA_MISMATCH` | Fail |
| `429` | `RATE_LIMITED` | **POST: fail immediately, never retried.** GET: retry with backoff, then fail |
| `5xx` | `SERVER_ERROR` | **POST: fail immediately, never retried.** GET: retry with backoff, then fail |
| Network failure on a GET | `NETWORK` | Retry with backoff, then fail |
| Network failure on a POST | `AMBIGUOUS_SUBMISSION` | Stop for manual reconciliation. Never retried, never resumed |
| Redirect on a POST | `AMBIGUOUS_SUBMISSION` | Not followed: 307/308 re-send the body as a second billable submission |
| `2xx` with no activity id | `NO_ACTIVITY_ID` | Stop for manual reconciliation: work may exist that cannot be named |
| Poll timeout | `TIMEOUT` | Fail with the elapsed budget |
| Activity `Failed` | `ACTIVITY_FAILED` | Stop, record the id |
| No `activity_id` in any envelope | `NO_ACTIVITY_ID` | Fail |
| No FeatureCollection anywhere | `NO_FEATURE_COLLECTION` | Fail |
| Empty FeatureCollection | `PARTIAL_COVERAGE` | Fail — never a silent zero |
| Result URL off-allowlist or plaintext | `BLOCKED_RESULT_HOST` | Refuse to fetch |
| Value field ambiguous or unknown | `ValueFieldError` | Stop the pipeline |

Every row of this matrix is covered in
`tests/integration/fortyguard-client.test.ts`. The number of tests that ran is in
`docs/verification-report.md`, not here.

---

## The capability probe

```bash
export FORTYGUARD_API_KEY='...'

python scripts/fortyguard/run_fortyguard_probe.py --dry-run          # no key needed
python scripts/fortyguard/run_fortyguard_probe.py
python scripts/fortyguard/run_fortyguard_probe.py --probe-capabilities --probe-timezone
python scripts/fortyguard/run_fortyguard_probe.py --probe-area-limit  # extra credits
python scripts/fortyguard/run_fortyguard_probe.py --temperature-field tcm
```

It records, factually: endpoint, payload key names, HTTP status, response structure,
value-field name and coverage, accepted granularities, accepted filter types, the
real date floor, processing time, polling behaviour, validation errors and observed
limits. Output: `outputs/fortyguard_probe_report.json`, to be transcribed into
`docs/fortyguard-capability-report.md`.

The timezone question is answered from a captured pair, not by the probe: the
probe has no network code. A capture at **04:00** and **15:00** on the same date
is parsed with `--parse`, which compares the
returned means. A large gap is consistent with local wall-clock; a small or inverted
gap indicates the times are being read as UTC or another zone. The measurement is
recorded; no conclusion is hard-coded.

---

## Credit safety

Everything in this section is about money.

### Exactly one submission path

`scripts/fortyguard/capture.mjs` calling `lib/fortyguard/capture.ts` is the only
code in this repository that can POST. No route imports it, and a test walks
`app/` and `components/` to keep it that way. The Python probe had a second,
independent `urllib` implementation of the same operation — its own POST, its own
polling loop, its own capture routine — so every safety property below existed in
one of the two and not the other. It has no network code at all now: it plans
requests and parses responses that were captured elsewhere.

### POST is never retried

No published FortyGuard contract establishes that `/v1/heatmap` is idempotent:
there is no idempotency key in the OpenAPI file and no documented deduplication.
So every failure a retry loop would read as "nothing happened" is one where the
server may already have accepted the request.

| Outcome | Response |
|---|---|
| `429` | Raised. Not retried — a rate limit can be returned after the job is queued. |
| `5xx` | Raised. Not retried — a failure in the response path can follow a successful submission. |
| timeout / dropped connection | `AMBIGUOUS_SUBMISSION`. The run stops for manual reconciliation. |
| `2xx` with no activity id | `NO_ACTIVITY_ID`. Work may exist that cannot be named; the run stops. |

Polling GETs do retry with bounded backoff. A GET buys nothing.

### Three independent opt-ins, and a budget

A capture needs `RUN_LIVE_FORTYGUARD=1`, `--confirm-spend` **and** a positive
`--max-new-submissions`. A key on its own authorises nothing, and neither does any
two of the three. Without all of them the CLI prints the tile plan, the
transmitted timestamps and the exact bill, and exits.

The budget is enforced twice: once against the whole plan before the first socket
opens, and once per unit, so a **resumed** run cannot spend it again.

### The journal, the lock, and reconciliation

The ordering is: record the intent, submit, record the activity id, poll. The
intent record closes the one window in which credits could be spent with nothing
on disk saying so. A unit with an intent and no id is a known unknown, and a
resumed run refuses to continue past one — it is never resubmitted automatically.

The lock is `O_CREAT | O_EXCL` (the `wx` flag), taken inside `runCapture` before
any network call, and it is **never broken automatically**: the first capture that
legitimately runs long would otherwise have its tiles bought a second time by the
process that helpfully cleared it.

### Redirects

`redirect: 'manual'`, every hop re-validated against the HTTPS-only host
allowlist, a fixed hop budget. Letting `fetch` follow redirects checks the
allowlist once and then accepts whatever the chain ends at.

## Environment

```dotenv
FORTYGUARD_API_KEY=                                 # server-only, never bundled
FORTYGUARD_API_BASE_URL=https://api.fortyguard.com
FORTYGUARD_AUTH_HEADER=api-key
FORTYGUARD_MAX_TILE_SQ_MI=9
FORTYGUARD_MAX_CONCURRENCY=2
FORTYGUARD_POLL_TIMEOUT_SECONDS=600
FORTYGUARD_RESULT_HOST_ALLOWLIST=api.fortyguard.com
RUN_LIVE_FORTYGUARD=0                               # master switch for outbound calls
```

`liveCallsPermitted()` requires **both** a key and `RUN_LIVE_FORTYGUARD=1`. Either
one missing means no request leaves the process.
