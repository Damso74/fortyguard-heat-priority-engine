# Product gates — G0 to G9

Status vocabulary: `PASS` · `PASS_WITH_LIMITATIONS` · `BLOCKED_LIVE` · `FAIL`.

| Gate | Status |
|---|---|
| G0 — Compliance | `PASS_WITH_LIMITATIONS` |
| G1 — Baseline | `PASS` |
| G2 — Data | `PASS` |
| G3 — API contract | `PASS` |
| G4 — Live signal | `PASS_WITH_LIMITATIONS` |
| G5 — Product selection | `PASS` |
| G6 — Core engine | `PASS` |
| G7 — UX | `PASS` |
| G8 — Verification | `PASS` |
| G9 — Submission | `PASS_WITH_LIMITATIONS` |

> **Revision, after the metric pivot.** G2 moved from `PASS_WITH_LIMITATIONS` to
> `PASS`: the ridership figure now has a documented unit, period and day category
> (Valley Metro quarterly ridership) and expected wait now comes from the official
> ODC-BY GTFS feed. The undocumented City `RIDERSHIP` index is retained only as a
> cross-check and is not computed on. G6 was rebuilt around two independent
> metrics with no weighting; G7 was rebuilt around the map as the primary surface.

---

## G0 — Compliance · `PASS_WITH_LIMITATIONS`

Official sources read and reconciled; six contradictions documented with the
interpretation adopted for each. Full detail in `docs/hackathon-compliance.md`.

**Limitation:** the published Build Sprint is 18–30 August 2026, part of this
project's preparatory work predates it, and no rules page exists beyond the FAQ.
The organisers answered the question directly in writing on 2026-08-03 — work
before the sprint is permitted — so the position rests on a first-party statement
rather than on silence (`hackathon-compliance.md` §3bis). Pre-existing artefacts
are declared in the README, in the compliance document and in the submission
draft rather than concealed.

---

## G1 — Baseline · `PASS`

The 19 spike reference metrics are pinned exactly against the retained generated
artefacts. Full regeneration remains available after an explicit local refetch,
but is no longer claimed as a network-independent clean-clone gate.

| Metric | Reference | Reproduced |
|---|---|---|
| Phoenix stops | 4,104 | 4,104 |
| Valley Metro Phoenix stops | 4,289 | 4,289 |
| Active Valley Metro Phoenix stops | 4,288 | 4,288 |
| Legacy Valley Metro Phoenix stops | 4,758 | 4,758 |
| Exact `stop_id` joins | 4,072 | 4,072 |
| `stop_code`-only joins | 0 | 0 |
| Unmatched active Valley Metro stops | 216 | 216 |
| City coverage | 99.22% | 99.22% |
| Unmatched City records | 32 | 32 |
| Median coordinate delta | 0.04 m | 0.04 m |
| P95 coordinate delta | 0.06 m | 0.06 m |
| Joined stops with ridership | 4,004 | 4,004 |
| Ridership completeness | 93.38% | 93.38% |
| Ridership median / P90 / max | 9 / 65 / 609 | 9 / 65 / 609 |
| City `NBR_SHELTERS` non-null | 20 | 20 |
| Valley Metro `Shelters` positive | 0 | 0 |
| Valley Metro `Shelter = "1"` | 1 | 1 |
| Official sheltered-stop total FY2024-25 | 3,164 | 3,164 |
| Panel minimum pairwise distance | 1.665 km | 1.665 km |

The legacy Valley Metro service, whose URL the spike report did not record, was
re-identified by matching its Phoenix record count (4,758) and field schema.

Pinned by `tests/unit/baseline-metrics.test.ts`. Re-runnable with
`npm run data:fetch && npm run data:baseline`.

---

## G2 — Data · `PASS`

Three official layers downloaded with a paginated, idempotent fetcher that asserts
the service-reported count, refuses short or empty pages, and records a SHA-256 per
artefact. A second run produces byte-identical files.

**Limitations, all structural and all disclosed:** shelter inventory unusable;
ridership unit, period and collection date undocumented; the Phoenix layer publishes
no `lastEditDate`, so its freshness cannot be proven.

One real defect was found and fixed here: Python's `write_text` was translating `\n`
to `\r\n` on Windows, so every recorded hash disagreed with the bytes on disk. Caught
by the hash test on its first run.

---

## G3 — API contract · `PASS`

The full client is implemented and exercised against typed fixtures: 2xx variants,
401, 403, 400/422, transient 404, 429 with retry, 5xx with retry, network failure,
poll timeout, failed activity, missing activity id, missing FeatureCollection, empty
FeatureCollection, three alternative envelopes, remote result URL, blocked host,
plaintext URL, subdomain vs lookalike host, cache hit and miss, activity resume,
cache bypass, and the concurrency cap. Every row of the error-handling matrix in
`docs/fortyguard-integration.md` has a test; the count that actually ran is in
`docs/verification-report.md`, which `npm run verify` regenerates.

The contract is now also exercised by three completed Phoenix activities. They
confirm the submit/status envelopes, UUID activity ids, `Completed` state,
`data.result.map_data`, 150 polygon features and numeric temperature fields.

---

## G4 — Live signal · `PASS_WITH_LIMITATIONS`

The committed pilot contains 450 real cells from three completed FortyGuard
activities and covers all 27 stops in its returned footprint. The field,
temperature semantics, Celsius unit and AOI-local Phoenix interpretation have
reviewed evidence bound into the capability fingerprint.

The surface is spatially uniform and its anomaly is not persistent on held-out
hours. The gate therefore returns `GO_CONDITIONAL_FACTOR_ONLY`: the product may
rank estimated transit exposure, but may not claim local hotspots.

---

## G5 — Product selection · `PASS`

The mode is an output of the gates, not an input. The vocabulary below is the
`ProductMode` union in `lib/types.ts`. The pre-pivot names (`SHADE_FIRST`,
`COOL_CORRIDORS`, `HEAT_PRIORITY_ZONES`, `SHADE_SURVEY`) were removed with the
weighted engine and no longer exist in code; the `PRODUCT_MODE` environment enum
still listed them, so a forced mode would have produced an impossible manifest.
It now matches the type.

| Mode | Verdict | Reason |
|---|---|---|
| `HEAT_EXPOSURE_AND_ANOMALY` | Available | Requires both metrics and a persistent anomaly |
| `EXPOSURE_ONLY` | **Selected for the real pilot** | Absolute heat is confirmed; local anomaly cannot be established |
| `ANOMALY_ONLY` | Available | Reachable when ridership or schedule coverage is too thin |
| `NO_GO_THERMAL_PRODUCT` | Available | Forced when a live signal is obtained and fails the discrimination gate |

`shadeFirstBrandingPermitted()` returns false in every current configuration; a test
asserts the branding stays unreachable even with a live, strong signal, because the
inventory gate still fails.

---

## G6 — Core engine · `PASS` *(rebuilt)*

Two metrics, computed and reported separately:

- **Metric A — Estimated scenario exposure load**, `°C·rider-minutes`, from
  documented ridership × GTFS-derived expected wait × thermal excess. Modelled
  throughout: no rider was counted at a stop in an hour and no exposure was
  measured, and the payload carries `isMeasurement: false` structurally. **Nine**
  named assumptions each with a falsification condition; route weights form a
  convex combination so a rider is never counted per route; a 324-scenario
  envelope gives every stop a range, a selection frequency and a rank range
  against the number of scenarios it could actually be evaluated under.
  Expected wait is integrated over the analysed hour with gaps clipped to it, and
  a cap truncates each rider's own wait before averaging (`E[min(W,c)]`). The
  timetable is the one for the day type being analysed — weekend ridership is
  never paired with a weekday schedule. The unit is expressed in °C only once the
  capability probe confirms both the value field and the unit.
- **Metric B — Local thermal anomaly**, robust median/MAD z with the cell excluded
  from its own background, validated out of sample by holding out snapshots and
  reporting rank correlation plus top-decile retention against a 10% chance level.
- **Selection** — Pareto layering with a max-min percentile tiebreak and a stated
  minimum separation. **No weights anywhere**; an end-to-end test asserts the
  product exposes no weight control at all.

Determinism verified two ways: identical input ordering produces identical output,
and the same request posted twice to the running API returns the same run id and
plan.

### Superseded

The previous weighted scoring engine was removed, not deprecated. Moving the
weight moved most of the plan, and its normalisation forced a temperature range
and a ridership range onto the same 0–100 scale, asserting an exchange rate
nothing justifies. The grid-cell decision unit was also removed in favour of the
stop, which is what a planner actually inspects.

The overlap figures that diagnosis produced are **deleted rather than caveated**
— see [`findings-provenance.md`](findings-provenance.md). They were computed over
a spatial abstraction that no longer exists, by modules removed in the pivot,
against a synthetic surface, so nothing in this tree can reproduce them. The
argument does not depend on them: an exchange rate between riders and degrees is
unjustifiable at any overlap.

## G6-legacy — previous engine (removed)

Deterministic scoring; missing values stay missing; winsorised, `log1p`-transformed,
monotone normalisation; three scenarios plus a custom weighting; confidence computed
separately from priority; five-point weight sensitivity; greedy dispersion selection
with a documented discount function; per-candidate selection reasons; a state machine
that rejects skipped or reversed transitions; and an append-only audit log with
redaction on the way in.

Determinism verified two ways: identical input ordering produces identical output,
and the same request posted twice to the running API returns the same run id and the
same plan.

---

## G7 — UX · `PASS`

Light-mode municipal software. Permanent, non-dismissible data-mode banner.
Provenance badge, unit and confidence on every displayed metric. Ranked table with
sort, filter, search, keyboard access, inclusion and exclusion. Map synchronised
with the table, distinguishing selected, unselected and incomplete, with a legend
and attribution — and degrading to an explicit message without breaking the product.
Detail panel with score breakdown, per-snapshot readings, confidence components,
sensitivity and a "What this does not say" block. Human approval before export. CSV,
JSON and print exports. Methodology page rendering the enforced claim registry.

Accessibility: skip link, visible focus rings, labelled controls, `aria-pressed` on
toggles, table usable without the map, and no state conveyed by colour alone —
every badge pairs colour with a word.

One real defect found and fixed here: on a 412 px viewport the page scrolled
sideways by 254 px because grid children default to `min-width: auto`. Caught by the
mobile E2E test, fixed with `min-w-0` and an inner scroll container.

---

## G8 — Verification · `PASS`

`npm run verify` softens no step. **The results and the test counts live in
`docs/verification-report.md`, which the command regenerates**; every count typed
into prose in this repository had gone stale by the time it was read, so this
gate lists the steps and not their numbers.

| Step | Proves |
|---|---|
| ESLint · TypeScript strict | No `any`, no unused code, strict types on every path |
| Vitest (unit + integration) | Metrics, selection, gates, audit, client contract |
| Thermal snapshot store audit | Every committed snapshot is a valid real capture, and no two answer the same request |
| Next production build | The deployed artefact compiles |
| Generated runtime assets | The MapLibre worker is present and matches `node_modules` |
| Distributed data hashes and exclusions | Retained raw files and the generated dataset match their manifests; unresolved raw extracts are absent from Git |
| GTFS hash and canonical rebuild | The licensed GTFS archive and its derived timetable remain reproducible offline |
| Metric regression tests | The reference counts and model outputs stay pinned to the reviewed generated artefact |
| Secret scan · dependency audit | No credential patterns; no high-severity advisory |
| Playwright against a production build | The whole journey, including map-failure and no-key paths |

---

## G-effective — the mode is the narrower of evidence and configuration

`PRODUCT_MODE` used to be returned verbatim, before a single gate was read, so an
environment variable could name `HEAT_EXPOSURE_AND_ANOMALY` on a run whose
capability was unconfirmed and whose anomaly had never been validated.

`resolveProductMode` now computes the **evidence mode** from the gates alone, then
applies configuration as a request for something *narrower*. A request whose axes
are not a subset of the evidence's is refused, recorded as `promotionRefused`, and
the evidence mode stands. There is no path through the function that widens
anything, and a mutation test walks all sixteen (evidence, requested) pairs.

| Mode | Axes | What the selection does |
|---|---|---|
| `HEAT_EXPOSURE_AND_ANOMALY` | exposure + anomaly | Pareto layering over both, max-min tiebreak, quadrants |
| `EXPOSURE_ONLY` | exposure | One objective: one front, no quadrants, anomaly absent from the ordering |
| `ANOMALY_ONLY` | anomaly | Same, mirrored. The scenario sweep is withheld — it varies only the exposure model |
| `NO_GO_THERMAL_PRODUCT` | none | Nothing is ranked. Analyst pins remain as instructions, carrying no front, percentile or robustness |

The axis set is not advisory. `rankCandidates` masks a forbidden metric to `null`
at its boundary, so no percentile, front, tiebreak or quadrant downstream can read
it however the code is later edited. An unconfirmed unit therefore removes
exposure from selection rather than hiding a label, and an unvalidated anomaly is
excluded rather than caveated — an unvalidated axis that still moves the ranking
is an unvalidated ranking.

Blocking reasons, the evidence mode, the requested mode and the axes travel on the
manifest, and are shown in the panel, the audit and the CSV preamble.

## G9 — Submission · `PASS_WITH_LIMITATIONS`

Submission text, demo script, deployment procedure and requirement checklist are
all written. `vercel.json` is committed.

This gate deliberately records **no** repository, deployment or submission-step
status. Those move independently of the engine, and a status frozen into a gate
report is the first thing to go stale. There is one place for them:

- `hackathon-compliance.md` §6 — the requirement-by-requirement checklist;
- `submission-checklist.md` — the actionable pre-30-August list, local actions
  separated from the ones that depend on an external party.

The gate stays `PASS_WITH_LIMITATIONS` because the product deliberately withholds
unsupported hotspot, shelter, causal and outcome claims. The raw-source
redistribution `NO-GO` was resolved by publishing a clean root repository without
the unresolved extracts or the original repository's PR refs
(`data-provenance.md` §8).
