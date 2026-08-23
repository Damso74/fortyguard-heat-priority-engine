# Limitations and claim register

This is the prose form of `lib/claims/registry.ts`. The registry is enforced in
code — UI copy is looked up from it, and each run records which claims it is
permitted to make — so this document and the product cannot drift apart silently.

---

## Allowed claims

Statements this product may make, as written, in the current data situation.

| Claim | Basis |
|---|---|
| The number of active Phoenix transit stops read from the Valley Metro authoritative layer. | 4,288 records, `Juris='Phoenix' AND Status='Active'`, SHA-256 recorded. |
| The share of Phoenix stop records matched by exact `stop_id` between the two official layers. | 4,072 of 4,104 = 99.22%; median coordinate delta 0.04 m, P95 0.06 m. |
| Two metrics computed deterministically and reported separately, never blended. | `lib/metrics/`, unit-tested for the sum identity, the wait integral, cap monotonicity, Pareto layering and determinism. There is no combined score and no `lib/scoring/` module. |
| Whether the thermal layer is live, cached-real, or explicitly synthetic. | Run manifest `dataMode`, shown on a permanent banner. |
| The values FortyGuard actually returned, with the field name they came from. | Only while `dataMode` is `LIVE_FORTYGUARD` or `CACHED_REAL_DATA`. Automatically blocked in demo mode. |
| The number of locations selected, described as a **selection or inspection capacity**. | 20 / 50 / 80 is a count of interventions or inspections. |
| The source, download date and SHA-256 of every dataset used. | `data/manifests/`, printed on the methodology page. |
| Where published ridership and the thermal layer overlap within the analysed area. | The product's core operation. The layer is whatever the run resolved to, and nothing here is a measurement while `dataMode` is `DEMO_SYNTHETIC`. |

---

### Newly allowed since the pivot

Two claims moved out of *conditional* because the data now supports them:

| Claim | What changed |
|---|---|
| The **unit and period** of the ridership figure. | Replaced the City's undocumented `RIDERSHIP` integer with Valley Metro's `BusStopQuarterlyRidership`: average daily riders per stop, by quarter, split Weekday/Weekend. |
| **Expected waiting time** at a stop. | The official GTFS feed (ODC-BY) supplies scheduled departures per hour per route for 99.46% of active stops. |

One claim remains conditional and is the largest open question in metric A:
whether the published figure counts riders who *wait* (boardings) or also those
who alight. If alightings are included, **every exposure value is an
over-estimate**. Recorded as assumption A2 and stated on the methodology page.

## Conditional claims

Statements that become permissible only when a specific piece of evidence exists.
These remain conditional even though the pilot now confirms the field, semantics,
unit and an empirical Phoenix timezone interpretation.

| Claim | Becomes allowed when |
|---|---|
| The **unit** of the published ridership figure. | The City of Phoenix documents the unit, period and collection date of `RIDERSHIP`. |
| That the ridership figure represents **daily** boardings. | The same documentation, explicitly stating a daily period. |
| That the thermal value is accurate to a stated tolerance **in °C**. | A completed FortyGuard capability probe confirming the value field, its unit and its stated accuracy. Until then, gate thresholds run in scale-free mode. |
| That a specific **intervention changes conditions** at a location. | A before/after measurement design with a control, at a spatial scale the sensor can resolve. The finest documented granularity is 60 m; a bus shelter is ~3 m. |
| The **number of people** who pass through a selected location. | A ridership dataset with a documented unit, period and coverage. |

---

## Blocked claims

Statements this product must never make, and why. Each is blocked structurally: the
data needed to support it is absent, and the code has no path that produces it.

| Claim | Why it is blocked |
|---|---|
| **"N people are protected."** | No counterfactual exists, and the ridership unit is undocumented. This is two unfounded claims stacked on each other. |
| **"Temperature reduced by N degrees."** | The finest documented API granularity is 60 m, far larger than a bus shelter. A neighbourhood grid cannot attribute cooling to a shelter-scale object. |
| **"N dollars saved / cost."** | No costing dataset is loaded. No dollar figure is generated anywhere in this product. |
| **"This stop has no shelter."** (inferred from an empty or zero amenity field) | Phoenix publishes 3,164 sheltered stops for FY2024-25 while the amenity fields carry 20 non-null values. The fields are incomplete, not negative. |
| **"Endorsed by / compliant with the City of Phoenix or Valley Metro."** | This is an independent hackathon project built on their public open data. |
| **"Acting on this ranking causes a measured outcome."** | No causal design, no control group, no outcome measurement exists here. |
| **"This location scores high/low on social vulnerability."** | No sourced social dataset is loaded. The scoring engine has no such factor. |
| **"This location is easy/hard to build at."** | No right-of-way, utility or construction dataset is loaded. |

---

## Structural limitations of the product

### 1. Real pilot coverage is narrow; other requests may be synthetic

The shipped default serves a committed real snapshot covering 27 Downtown Phoenix
stops at three hours on 2024-07-15. It is not Central or Full Phoenix coverage.
Requests without an exact snapshot fall back to `lib/fortyguard/demo-fixture.ts`
only in `auto`/`demo` mode and are permanently labelled `DEMO — SYNTHETIC`.

**Rankings in synthetic mode demonstrate the method. They are not findings about
Phoenix. The real pilot supports an exposure-only planning result, not a hotspot
or city-wide claim.**

### 2. Shelter presence is unknown for every stop

Covered above. This is the single reason the product is called *Heat Priority
Engine* and not *ShadeFirst 80*.

### 3. The scenario exposure load is modelled, not measured

The public name is **estimated scenario exposure load** and each word is
deliberate. It is not a measurement of any individual, and two readings must not
be taken from it:

- **not observed riders.** `riders(h)` is a published *quarterly average* daily
  total pushed through an *unobserved* hourly profile. Nobody counted a rider at
  a stop in an hour.
- **not measured exposure.** The wait comes from a timetable rather than
  observation, the temperature is a gridded model value — a FortyGuard modelled
  surface on the shipped Downtown pilot, an explicitly labelled synthetic fixture
  on any request that does not match a committed snapshot — and no rider's heat
  exposure has been measured by anyone.

It rests on nine stated assumptions (A1–A9), each with what would falsify it,
and every stop carries a range across the 324-scenario envelope rather than a
single figure — an envelope over stated assumptions, **not** a confidence
interval.

Specifically: ridership is spread across the day in proportion to scheduled
departures (A1) because no hourly boarding counts are published; expected wait is
integrated over the analysed hour with each scheduled gap clipped to that hour
(A3), and capped (A5) because uniform arrival fails for long headways — the cap
truncating each rider's own wait before averaging, `E[min(W,c)]` and not
`min(E[W],c)`; and the reference temperature (A6) is FortyGuard's own documented
default, not a physiological threshold.

### 4. Weekend days use weekend timetables

Weekend ridership was previously paired with the **weekday** timetable — a 30–40%
error in the wait term on precisely the days service is thinnest. The three day
types (weekday, Saturday, Sunday) are now extracted separately from the feed and
each is paired with the ridership column published for it. The source publishes
one Weekend average and does not split Saturday from Sunday, so that average is
applied to each weekend day against its own timetable (A8).

### 5. Missing data is absent, not zero

A stop with no published ridership figure in some quarter makes every scenario
naming that quarter **unavailable** for it, and the reported denominator is the
number of scenarios it could actually be evaluated under. A stop covered by the
thermal layer for some analysed hours but not all reports **no** exposure load at
all: a partial sum is smaller for a reason indistinguishable from a genuinely
cooler stop.

### 6. Celsius is bound to the reviewed capability fingerprint

The pilot confirms `average_temperature`, its temperature semantics and literal
`°C` using completed responses plus FortyGuard documentation. A snapshot captured
under different answers is refused rather than retroactively relabelled.

### 7. The ridership quarter passes our checks, not an independent one

FY2024 Q4 is the **latest quarter passing our completeness checks**, and those
checks are now **executable**: `run_completeness_checks` runs on every dataset
build, scores all 13 published quarters, and writes the result into the dataset.
2025 Q1/Q2/Q3 fail at 38%, 11% and 5% of the best weekday total.

The checks are ours. Valley Metro publishes no completeness flag, no data
dictionary and no revision notice for this layer, so nothing independent confirms
FY2024 Q4 is itself complete — only that it does not fail what could be tested
here. A quarter under-reporting uniformly across every stop would pass both
checks and is undetectable without a control total. The product therefore never
says "last complete quarter", and the dataset carries
`independentlyReconciled: false` structurally.

### 8. Schedules are scheduled, not observed

Headways come from the published GTFS timetable. Cancellations, detours,
bunching and real-time deviation are not represented, so a stop whose service
routinely fails to appear will show a shorter expected wait than riders
experience.

### 9. The scenario exposure load covers only the analysed hours

It is **not a daily total**. Extending it to a full day would need a temperature
for every service hour, which costs a heatmap request per hour per tile.

### 10. Selection is Pareto layering, not an optimum

It produces a defensible, weight-free ordering, not a proven-optimal set. The
rule is stated in full, unit-tested, and reproducible. Within a front the
tiebreak is max-min percentile, which is a choice — a different tiebreak would
reorder stops inside the same front.

### 11. The timezone is empirically confirmed, not contractually stated

FortyGuard still does not state which timezone `start_time` uses. The three-hour
Phoenix comparison supports AOI-local interpretation over UTC by a 3.28× RMSE
ratio. The product applies and records that strategy for this pilot, while naming
the evidence as empirical rather than vendor-contract confirmation.

### 12. Freshness of the Phoenix layer cannot be proven

The City layer publishes no `lastEditDate`. Its freshness therefore cannot be
established, and the confidence model treats it accordingly. The Valley Metro layer
does publish one (2026-07-27) and it feeds the freshness component.

### 13. Coverage is bounded by the chosen area of interest

The shipped default is the **Downtown pilot**: the 27 stops inside the returned
450-cell footprint, and nothing beyond it. The wider `Central Phoenix` area
covers 817 of the 4,288 active stops and has no committed real snapshot, so it
runs on the labelled fixture unless one is captured. The
`Full Phoenix stop extent` option covers all of them but would cost roughly an
order of magnitude more FortyGuard requests; the tile plan reports the exact number
before anything is submitted.

---

## Where these limitations are visible to a user

- **Permanent banner** — data mode, on every screen, non-dismissible.
- **Plan summary** — a "What this plan does not claim" list with all of them.
- **Detail panel** — per-location: provenance badge, unit, confidence breakdown,
  and a "What this does not say" block.
- **Methodology page** — the full claim register, rendered from the code registry.
- **Every export** — CSV preamble and JSON body both carry the limitation list.
