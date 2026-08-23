# Methodology

Two metrics. Computed separately, reported separately, never blended.

Implementation: `lib/metrics/`. Every property asserted here is covered by a test
in `tests/unit/exposure.test.ts` or `tests/unit/anomaly-and-selection.test.ts`.

---

## 0. Why there is no combined score

The first version of this product blended heat and ridership with a user-adjustable
weight. It was measured and abandoned:

The diagnostic that killed it produced numbers this repository **no longer
carries**. They were computed on a spatial abstraction that no longer exists, by
modules deleted in the pivot, against a synthetic heat surface — so they could
not be reproduced, checked or defended, and quoting them would have been an
appeal to evidence that is not here. They have been removed rather than
caveated.

What survives is the argument, which never depended on them:

1. **A weight slider had no principled setting.** Whatever the exact overlap
   between a heat-first and a ridership-first plan, the user was being asked to
   supply a number that no source publishes and no measurement constrains.
2. **The normalisation invented an exchange rate.** Mapping a temperature range
   and a ridership range onto the same 0–100 scale asserts that so many degrees
   are worth so many riders. Nothing justifies that at any correlation, so the
   objection does not rest on a correlation at all.

Two axes follow from the second point alone. If the two quantities cannot be
converted into each other, they must be reported separately.

---

## 1. Metric A — Estimated scenario exposure load

```
ESEL(stop) = Σ_h  riders(h) · wait(h) · max(0, T(h) − T_ref)
```

**Unit: scenario °C·rider-minutes**, over the analysed hours only. Not a daily
total, not a health outcome — a physically dimensioned quantity comparable
between stops within a run.

### 1.0 Every word of the name is load-bearing

| Word | What it commits to |
|---|---|
| **Estimated** | No term is measured at a stop. |
| **Scenario** | The value is conditional on five settings nobody has observed, and moves when they move. |
| **Exposure load** | A modelled product of three quantities — not a dose anyone received. |

Two things this quantity is explicitly **not**:

- **not observed riders.** `riders(h)` is a published *quarterly average* daily
  total, pushed through an *unobserved* hourly profile. Nobody counted a rider
  at this stop in this hour, and no number in this product should be read as if
  they had.
- **not measured exposure.** The wait is read off a timetable rather than
  observed, the temperature is a gridded model value — a FortyGuard modelled
  surface on the shipped Downtown pilot, an explicitly labelled synthetic fixture
  on any request without a committed snapshot — and no rider's heat exposure has
  been measured by anyone.

The run payload carries `isMeasurement: false` and a `quantityCaveat` string
structurally, so a new call site cannot quietly imply otherwise, and the export
preamble carries both.

### 1.1 How published daily ridership becomes `riders(h)`

```
riders(h) = R · w(h)        Σ_{h=0..23} w(h) = 1        w(h) = 0 where no service runs
```

`R` is the published average daily riders for the stop, day category and fiscal
quarter. `w` is a **probability distribution over the 24 clock hours**, which
gives the identity

```
Σ_{h=0..23} riders(h) = R
```

**exactly.** It is enforced by construction — the weights are normalised, then the
last service hour absorbs the exact residual so the sum holds to the last
representable bit — and asserted by a regression test over five different daily
totals and all three profiles.

`w(h) = 0` wherever no service is scheduled. A rider cannot board a bus that is
not running, so allocating demand into a dead hour would manufacture exposure out
of an empty timetable.

The shape of `w` is **unobserved**. Three materially different profiles are
carried in the envelope rather than one being presented as fact:

| Profile | Shape |
|---|---|
| `proportional_to_departures` | `w(h) ∝` scheduled departures in hour `h` |
| `flat_service_hours` | even across every hour with any service |
| `commute_peak` | bimodal AM/PM shape, renormalised onto service hours |

At a peak hour the commute profile carries about **1.8×** the flat profile's
share, and less than it at midday; the two disagree by more than 20% on most
hours of the day.

### 1.2 Waiting time — from actual gaps, not from counts

```
wait(h) = E[ min(W, cap) ]     W = time to the next scheduled departure
                               arrival uniform on [h:00, h+1:00)
```

This is **random incidence**: a passenger is more likely to land inside a long gap
than a short one, in proportion to how much of that gap falls inside the hour,
and waits on average half of whichever part they land in.

It **reduces to `headway / 2` only when every gap is equal.** Three departures at
:00, :05 and :10 and then nothing until the next hour give a mean headway of 20
minutes — suggesting a 10-minute wait — while the formula returns **21.25**,
because most arriving passengers land in the 50-minute hole.

A departures-per-hour count cannot tell those two timetables apart at all. That is
why the GTFS extraction keeps **actual departure minutes** per route, and why the
dataset carries `routeDepartures` rather than hourly counts.

#### 1.2.1 Gaps that cross the clock-hour boundary

A scheduled gap is **clipped to the analysed hour before it is weighted**. Only
the part of a gap a passenger can arrive in belongs to that hour.

Charging the whole gap — which the closed form `Σgap²/(2·Σgap)` does — is wrong,
and wrong in *both* directions. One timetable is enough to show it. Departures at
09:00 and 11:40, nothing between: a single 160-minute gap, so the whole-gap form
returns `160²/(2·160)` = **80 minutes for every hour it touches**.

| analysed hour | whole gap | clipped to the hour |
|---|---:|---:|
| 09:00–10:00 | 80 | **130** — these arrivals are early in the gap, and wait longest |
| 10:00–11:00 | 80 | **70** — these arrivals are an hour closer to the bus |

The whole-gap figure cannot be right for both hours and is right for neither. It
**understates the hour that opens a long gap and overstates the one that closes
it**, which in a heat metric moves load to the wrong time of day — precisely the
error a per-hour temperature profile exists to avoid.

The integral is therefore evaluated per clipped sub-interval. For a gap closed by
a departure at `d`, clipped to arrivals in `[a, b)`, the wait falls linearly from
`d − a` to `d − b`, so

```
∫_a^b W = ( (d − a)² − (d − b)² ) / 2
```

and `wait(h)` is the sum of those divided by the hour. The clipped sub-intervals
tile the hour exactly, which is asserted by test over several timetables and
hours. `Σgap²/(2·Σgap)` is recovered **exactly, and only, when the gaps already
tile the hour** — a departure on each edge.

#### 1.2.2 What a cap does, exactly

```
wait(h) = E[ min(W, c) ] = (1/60) · ∫ min( W(t), c ) dt        NOT min( E[W], c )
```

A cap truncates **each passenger's own wait, inside the integral, before
averaging**. It is *not* the expected wait computed first and then clipped.
The two are different quantities and `E[min(W,c)] ≤ min(E[W],c)` always, with
equality only when every arrival in the hour is on the same side of the cap.

The truncation is what the modelled behaviour actually asserts. The cap exists
because A3 — uniform arrival — is documented to fail at long headways: a rider
facing an 11-hour gap consults the timetable and turns up near the departure.
That is a claim about *each rider's own wait*, so it belongs inside the integral.
Capping the average instead would clip the summary while leaving the arrival
distribution untouched, describing no rider at all.

Worked example — one departure at 14:30, analysed hour 14:00–15:00, cap 15 min:

| quantity | value |
|---|---:|
| uncapped `E[W]` | 720.00 |
| **`E[min(W,15)]` — what this product reports** | **13.13** |
| `min(E[W],15)` — what it does not | 15.00 |

The reported figure sits *below* the cap because arrivals between 14:15 and 14:30
wait less than 15 minutes and are averaged in at their real wait; only the later
arrivals, who face the next day's service, are truncated. **A figure sitting
exactly on the cap is the signature of the wrong definition.**

Three consequences follow from the definition, each asserted by test:

1. the reported wait never exceeds the cap — a cap is a genuine bound;
2. it is non-decreasing in the cap, so `cap_5 ≤ cap_10 ≤ cap_15 ≤ uncapped`,
   which is what makes the four caps an ordered scenario dimension;
3. `capApplied` is true exactly when the cap changed the answer.

Every wait is reported alongside its uncapped value, so the cap's effect is
visible rather than absorbed.

### 1.3 Route choice — union timetable, or bracketed

Which departures a rider will board is unobserved.

| Model | Meaning |
|---|---|
| `union_timetable` **(base)** | Routes interchangeable; gaps from the merged timetable. Lower bracket. |
| `worst_route` | Committed to the least convenient route. Upper bracket. |
| `frequency_share_unsourced` | Per-route waits weighted by each route's share of departures. **The weights are unsourced.** |

Two routes each hourly and offset by 30 minutes give **15 min** under the union
timetable and **30 min** under `worst_route` — the bracket is the honest answer.

The frequency-share weighting carries `unsourced` **in its identifier**, so it
cannot be rendered as an observed weighting by accident. In every model the route
weights form a **convex combination**, so a rider waits once, not once per route:
a test asserts three identical routes give the same wait as one.

### 1.3b Day types — the timetable of the day being analysed

Three day types are extracted **separately** from the GTFS feed, and each is
paired with the ridership column the source publishes for it:

| Day type | Timetable | Ridership column | Modal-pattern trips |
|---|---|---|---:|
| `weekday` | weekday | Weekday | 7,854 |
| `saturday` | Saturday | Weekend | 5,476 |
| `sunday` | Sunday | Weekend | 4,815 |

Weekend ridership was previously combined with the **weekday** timetable. That is
a 30–40% error in the wait term on exactly the days when service is thinnest, and
it is now structurally impossible: the dataset carries no shared timetable to
borrow.

The published ridership splits Weekday from Weekend but not Saturday from Sunday,
so the single Weekend average is applied to each weekend day (**A8**). The
*timetables* are not shared — that is the part the source does let us separate.

**Service pattern selection.** For each day type, the pattern used is the **most
frequent** set of active `service_id` values across the dates of that day type,
not the date with the most trips. The feed contains 17 distinct weekday patterns
whose trip counts differ by under 1.5%, so "the largest" selects a
school-plus-special outlier and calls it typical; the modal pattern occurs on 19
of 65 weekday dates. Ties break on trip count, then on the sorted service ids.

**Service-day times.** GTFS times of 24:00 and later belong to the analysed
service day and are stored **unwrapped** — a 25:10 departure is 1510, not 70.
Projection onto clock hours is a named assumption (**A9**, repeating service day)
applied in one tested function, not a silent modulo inside the parser.

### 1.3c Missing data is missing, never zero

A quarter that publishes no figure for a stop makes every scenario naming that
quarter **unavailable** for it. Unavailable is not zero:

- coercing to zero gave the stop an exposure of 0, ranked it last, and then
  reported it as *assumption-sensitive to the very quarter that was never there*
  — a fabricated sensitivity;
- the honest denominator is the number of scenarios the stop could actually be
  evaluated under, and it is reported alongside the 324 offered.

The same rule governs the thermal layer. ESEL is a sum over the analysed hours,
so it is produced **only** for stops covered in *every* analysed hour. A partial
sum is smaller for a reason indistinguishable from a genuinely cooler or quieter
stop, so a partially covered stop reports no load and says how many hours it has.

### 1.4 The reference temperature

`T_ref` defaults to **30 °C because that is FortyGuard's documented API default**
for its `exceedance` and `persistence` analytics — an API convention, adopted so
the reference is at least sourced from the data provider rather than invented
here.

**It is not a health or heat-stress threshold**, and none should be inferred from
it. No source used by this project publishes one. It is swept across 30/35/40 °C.

**And it is only degrees once the evidence says so.** The product expresses
metric A in °C only when *both* the value field and the unit are confirmed
against real API responses. Otherwise the unit reads "unconfirmed thermal unit":
a documented analytic unit says nothing about which property the response
returned, and knowing which property to read says nothing about what it measures.
Neither fact alone is enough.

For the committed Downtown pilot both are confirmed — `average_temperature`
present and numeric on all 450 returned features, and literal `°C` from the
Create Heatmap documentation for `tcm` — and the answers are bound into the
capability fingerprint carried by the snapshot attestation
([`fortyguard-capability-report.md`](fortyguard-capability-report.md)). A
snapshot captured under different answers is refused rather than relabelled, and
a run resolving to the synthetic fixture claims no unit confirmation at all.

### 1.5 Assumptions

| id | Assumption | In the envelope as | Falsified by |
|---|---|---|---|
| **A1** | Daily ridership is allocated by a profile summing to 1, zero where no service runs. | `demandProfile` | Automatic passenger counter data by hour. |
| **A2** | The published figure counts riders who **wait**. | — **cannot be bracketed** | A data dictionary. If alightings are included, every ESEL is an **over-estimate**. |
| **A3** | Passengers arrive uniformly over the hour, so wait is `E[W]` over gaps **clipped to that hour**. | — | Observed arrival distributions, or real-time rather than scheduled gaps. |
| **A4** | Which route a rider boards is unknown; the range is bracketed. | `routeChoice` | Route-level boarding counts at the stop. |
| **A5** | A cap truncates each rider's **own** wait: `E[min(W,c)]`, not `min(E[W],c)`. | `waitCap` | Observed waits at low-frequency stops. |
| **A6** | Heat counts above an API-default reference, not a health threshold. | `referenceTemperatureC` | A published transit-specific heat-stress threshold. |
| **A7** | The ridership period does not match the schedule or the thermal date. | `ridershipQuarter` | A ridership quarter contemporaneous with both. |

### 1.6 Why the base is capped at 15 minutes, not uncapped

"Uncapped" looks like the assumption-free choice. It is not.

A3 is **documented as failing** for long headways — riders consult a timetable
rather than turning up at random. Running uncapped applies A3 exactly where it is
known to be invalid, and the result is not neutral. Measured on Central Phoenix,
capacity 50, on the current implementation:

| Base cap | Selections with a mean expected wait over an hour | Longest mean wait in the plan |
|---|---|---:|
| `uncapped` | **3** — at ranks 4 (663 min ≈ 11 h), 10 and 13 (374 min ≈ 6 h) | 663.42 min |
| `cap_15` **(base)** | none | 11.33 min |

A once-daily stop genuinely does have an eleven-hour expected wait for a
uniformly arriving passenger. Nobody waits eleven hours for a bus, so an
eleven-hour figure at rank 4 is A3 failing, not a finding.

So the base applies the **longest** cap, the least constraining choice that stays
out of the known-invalid regime. `uncapped` remains in the envelope alongside the
shorter caps, so the effect of that choice is measured, not hidden — and because
the cap dimension is one of the five swept, a stop that only reaches the plan
under one cap is reported as assumption-dependent rather than as a priority.

### 1.7 Source periods — and their mismatch

| Input | Period | Coverage |
|---|---|---|
| Ridership | **FY2024 Q4 — Apr–Jun 2024** | 93.07% of active stops |
| Schedule | **Effective July 2026** | 99.46% |
| Heat | the analysis date chosen | — |

Valley Metro's quarters are **fiscal** (July–June), not calendar. The reading is
*inferred*: the sibling layer `RidershipDataPortal_Bus` describes itself as "bus
stops as of October 27, 2014" and its earliest quarter is `Q2015_2`, which is
Oct–Dec 2014 only under a July–June year. Valley Metro publishes no data
dictionary for the field.

**These three periods do not match.** That is disclosed rather than corrected
away, and drift is modelled by recomputing on the neighbouring published quarters
— a sourced scenario, unlike a uniform multiplier, which cannot change a ranking
at all.

FY2024 Q4 is the **latest quarter passing our completeness checks** — deliberately
not "the last complete quarter", which is a claim we are not in a position to
make. Quarters after it are published and fall apart under those checks: Phoenix
weekday totals drop 43,092 → 19,324 → 5,413 → 2,522, with individual stops going
from ~41 riders/day to 0.26. A fall that steep is far more consistent with
partial reporting than with ridership collapsing by 94%, so those quarters are
not used.

**The checks are ours, and nothing independent reconciles them.** Valley Metro
publishes no completeness flag, no data dictionary and no revision notice for
this layer. What we can say is that FY2024 Q4 does not fail the tests we could
run — a monotonicity check against neighbouring quarters and a per-stop
implausibility check. What we cannot say is that FY2024 Q4 is itself complete:
it may under-report by an amount no test here would detect, and every exposure
value would be proportionally low. If a reconciliation against a published
control total becomes available, this section should be replaced with what that
establishes, and the wording upgraded accordingly.

### 1.8 Double counting, explicitly avoided

1. **Routes.** Convex-combination weights, asserted by test.
2. **Stops.** The stop is the decision unit, so no stop feeds two selectable
   locations.
3. **Duplicate departures.** Two trips of the same route scheduled to the same
   minute at the same stop are collapsed to one boarding opportunity.
4. **Dead hours.** An hour with no scheduled departure contributes zero.

## 1b. Scenario envelope

Five things are unobserved. Each is a scenario dimension, and the product reports
the envelope across their **full cross product — 3 × 3 × 4 × 3 × 3 = 324
scenarios**.

It is an **envelope over stated assumptions, not a confidence interval**. Nothing
here is a sampling distribution, so calling the spread an uncertainty interval
would misrepresent what it is.

| Dimension | Base | Swept |
|---|---|---|
| `demandProfile` | `proportional_to_departures` | 3 profiles |
| `routeChoice` | `union_timetable` | 3 models |
| `waitCap` | `cap_15` | uncapped, 15, 10, 5 min |
| `referenceTemperatureC` | 30 | 30, 35, 40 |
| `ridershipQuarter` | `2024_4` | FY2024 Q4, Q3, Q2 |

Measured spread of the envelope on Central Phoenix: **×8.5 at the 10th
percentile, ×15.8 median, ×78 at the 90th**. These assumptions matter a great
deal, which is the point of reporting them.

## 1c. The result of a run

The output of this product is **not "a plan of 50 stops"**. It is a split:

> **13 robust priorities + 37 assumption-dependent candidates**
>
> — weekday, Central Phoenix, capacity 50. **A synthetic fixture output**: see
> [`findings-provenance.md`](findings-provenance.md). Saturday and Sunday give
> **17 + 33** and **20 + 30** respectively on the same area and capacity.

Three categories, not two:

| Category | Definition |
|---|---|
| **Robust priority** | Evaluable under **all 324** scenarios *and* selected in every one. |
| **Assumption-dependent candidate** | In the base plan, but not that. |
| **Analyst-pinned location** | Placed by a person. Counted in neither, and carrying no robustness claim. |

Robustness requires *evaluability everywhere*, not just selection everywhere. A
stop the source cannot support under some scenario — because no ridership figure
is published for it in that quarter — cannot earn the strongest claim the
product makes. It is reported against the number of scenarios it could actually
be evaluated under, and that denominator is shown.

Every selection carries **two** figures, because neither implies the other:

| Figure | What it answers |
|---|---|
| **selection frequency** | In how many *evaluable* scenarios is it chosen? |
| **rank range** | Across those, what is its best and worst position? |

A candidate selected in 323 of 324 scenarios but swinging between **rank 8 and
rank 48** is a different object from one that is always rank 3. Both appear on
every selected row, on the stop detail, in the CSV (`robustness`,
`scenario_selection_count`, `scenario_count_evaluable`, `scenario_count_offered`,
`scenarios_unavailable`, `scenario_rank_best`, `scenario_rank_worst`) and in the
JSON export.

### Attribution is one-at-a-time

A setting is blamed for dropping a candidate only when **changing that single
dimension away from the base** removes it. An earlier version unioned every
dimension that differed in any losing scenario, so a stop dropping under one
four-way combination was reported as sensitive to all four independently — which
is not what was measured. Candidates that survive every single change and fall
only to combinations say exactly that.

---

## 2. Metric B — Local thermal anomaly

```
z(cell) = ( v − median(N) ) / ( 1.4826 · MAD(N) )      N = other cells within R
```

Default `R` = 1000 m, minimum 12 neighbours.

This is the question ridership cannot answer and a coarse gridded product cannot
answer: **is this place hot for where it is?** A downtown stop being hot is not
news; a stop 2σ hotter than everything within a kilometre is.

### Why median and MAD

The thing being detected — a hot spot — is exactly what would contaminate a
mean-and-σ background. Median and MAD have a 50% breakdown point, so a genuine
anomaly does not inflate the baseline it is measured against. The 1.4826 factor
makes MAD a consistent estimator of σ for normal data, so `z` reads on the
familiar scale.

### Leave-one-out by construction

A cell is **excluded from its own background**. Without that, a strong anomaly
partly defines what it is compared to and is systematically under-detected. This
is structural, not an option.

A degenerate (flat) neighbourhood returns `null`, not a huge z from dividing by
something tiny. Too few neighbours also returns `null`.

### Out-of-sample validation

A hot cell at one moment could be noise. So the background is fitted independently
per snapshot and the anomalies are compared **across held-out snapshots**: the
earliest is the fit, the rest are the holdout.

Two figures on every run:

- **rank correlation** of z between fit and holdout;
- **top-decile retention** — how much of the fit's top decile stays in the
  holdout's top decile, against a 10% chance level.

| Verdict | Condition |
|---|---|
| `PERSISTENT` | correlation ≥ 0.6 **and** retention ≥ 50% |
| `WEAK` | correlation ≥ 0.3 |
| `NOT_PERSISTENT` | otherwise |
| `INSUFFICIENT_DATA` | fewer than 2 snapshots or fewer than 20 shared cells |

Anything below `PERSISTENT` is stated on the run, added to the limitations, and
downgrades the confidence of every stop.

---

## 3. Selection — weight-free

**Pareto layering.** No step multiplies the two metrics, adds them, or scales one
against the other. There is no exchange rate to justify because none is used.

1. A stop is on **front 1** if no other stop beats it on *both* metrics.
2. Front 2 is the same rule applied to what remains, and so on.
3. Within a front, order by `min(exposure percentile, anomaly percentile)` — a
   **max-min** rule that favours stops strong on their weaker axis.
4. Fill the capacity front by front, keeping selections at least **400 m** apart.
   The separation is relaxed only if the capacity cannot otherwise be filled, and
   the relaxation is reported in the run notes.

Ties break on stop id, so the same inputs always produce the same plan.

Implementation note: fronts are computed with a 2-D skyline sweep, `O(n log n)`
per front rather than the `O(n²)` pairwise comparison.

### The matrix

Stops are classified by the **median of each axis** — so the boundary needs no
tuning parameter:

| Quadrant | Meaning |
|---|---|
| `BOTH_HIGH` | High exposure **and** unusually hot for its area |
| `EXPOSURE_DRIVEN` | Many riders in heat, but typical for the area |
| `ANOMALY_DRIVEN` | Unusually hot for its area, fewer riders |
| `NEITHER` | Below the median on both |

This is a communication device layered on the same two numbers, not a third
metric.

---

## 4. Confidence — separate from priority

Priority answers *where*. Confidence answers *how much to trust it*.

| Component | Weight |
|---|---|
| Completeness of the two metrics | 30% |
| Freshness of the stop layer | 10% |
| Data mode (live 1.0 · cached 0.85 · **synthetic 0.20**) | 25% |
| Anomaly validation verdict | 20% |
| Parameter stability across the sensitivity grid | 15% |

The synthetic data mode caps confidence well below what a live run would reach,
which is why a demo run shows *medium* confidence on its strongest stops. That gap
is the honest signal.

---

## 5. Determinism

The run id is `sha256(request + dataset SHA-256 + engine version + thermal ATTESTATION digest)`, deliberately
excluding timestamps. The same request and dataset reproduce the same ranking and
the same id — asserted by a unit test and by an end-to-end test that posts the same
request twice.

Sources of nondeterminism removed: explicit sorting everywhere, quickselect
medians that do not depend on input order, ties broken on id, an integer hash
lattice instead of `Math.random` in the fixture, injectable clock and jitter.
