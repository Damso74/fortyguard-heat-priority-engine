/**
 * Expected waiting time, from the actual scheduled gaps.
 *
 * ## The quantity
 *
 * A passenger arrives at a moment `t` drawn uniformly from the analysed hour
 * `[windowStart, windowEnd)` and waits `W(t) = next departure after t − t`. The
 * reported figure is the mean of that wait over the window:
 *
 *   E[W] = ( 1 / |window| ) · ∫_window W(t) dt
 *
 * This is the inspection-paradox result: a passenger is more likely to land
 * inside a long gap than a short one, in proportion to how much of that gap
 * lies inside the window.
 *
 * ## Why it is not headway / 2
 *
 * `headway / 2` is the special case where every gap is identical. Real
 * timetables are not. Three departures at 0, 5 and 10 minutes past the hour and
 * then nothing until the next hour give a *mean headway* of 20 minutes, which
 * would suggest a 10-minute wait — while the integral above returns 21.25,
 * because most arriving passengers land in the 50-minute hole.
 *
 * Using a departure *count* per hour cannot distinguish those two timetables at
 * all. That is why the GTFS extraction keeps actual departure minutes.
 *
 * ## Gaps that cross the clock-hour boundary
 *
 * When the scheduled gaps happen to tile the window exactly — a departure at
 * both edges of the hour — the integral collapses to the familiar closed form
 * `Σ gapᵢ² / (2 · Σ gapᵢ)`. That is the *only* case in which it does.
 *
 * A gap that straddles an edge must be **clipped to the window before it is
 * weighted**, because only the part inside the window can be arrived in.
 * Charging the whole gap is wrong, and wrong in *both* directions — one
 * timetable is enough to show it. Departures at 09:00 and 11:40, nothing
 * between: one 160-minute gap, so the whole-gap form reports `160²/(2·160)` =
 * **80 minutes for every hour it touches**.
 *
 * | analysed hour | whole gap | clipped to the hour |
 * |---|---|---|
 * | 09:00–10:00 | 80 | **130** — these arrivals are early in the gap and wait longest |
 * | 10:00–11:00 | 80 | **70** — these arrivals are an hour closer to the bus |
 *
 * The whole-gap figure cannot be right for both, and is right for neither. It
 * understates the hour that opens the gap and overstates the one that closes
 * it, which in a heat metric moves exposure to the wrong time of day.
 *
 * So the integral is evaluated per clipped sub-interval. For a gap closed by a
 * departure at `d`, clipped to arrivals in `[a, b)`, the wait runs linearly from
 * `d − a` down to `d − b`, and
 *
 *   ∫_a^b W = ( (d − a)² − (d − b)² ) / 2
 *
 * Summing those and dividing by the window length is exact. The closed form
 * falls out when `a = from` and `b = to` for every gap.
 *
 * ## Route choice
 *
 * Which gaps apply depends on which departures a passenger will actually board,
 * and no source says. Rather than pick one, the models below bracket it, and
 * the frequency-share model is labelled unsourced wherever it appears.
 */

export type RouteChoiceModel =
  /**
   * Every route at the stop is interchangeable: the passenger boards the first
   * bus of any route. Gaps come from the **union timetable**. This is the
   * shortest defensible wait and the lower bracket.
   */
  | 'union_timetable'
  /**
   * The passenger is committed to one route and it is the least convenient one
   * at the stop. Upper bracket.
   */
  | 'worst_route'
  /**
   * Waits per route, averaged with weights equal to each route's share of
   * departures. **The weights are unsourced** — no route-level boarding split
   * is published — so this is a scenario, never a default and never described
   * as observed.
   */
  | 'frequency_share_unsourced'

export const ROUTE_CHOICE_MODELS: readonly RouteChoiceModel[] = [
  'union_timetable',
  'worst_route',
  'frequency_share_unsourced',
] as const

export const ROUTE_CHOICE_LABEL: Record<RouteChoiceModel, string> = {
  union_timetable: 'Routes interchangeable (union timetable)',
  worst_route: 'Committed to the least frequent route',
  frequency_share_unsourced: 'Frequency-share weighted (unsourced weights)',
}

/* -------------------------------------------------------------------------- */
/* Wait caps — one definition, stated exactly                                 */
/* -------------------------------------------------------------------------- */

/**
 * **The cap is a per-passenger truncation of the wait, applied inside the
 * integral, before averaging.** For a cap `c`:
 *
 *   E[ min(W, c) ] = ( 1 / |window| ) · ∫_window min( W(t), c ) dt
 *
 * It is **not** `min( E[W], c )` — the expected wait computed first and then
 * clipped. The two are different quantities and `E[min(W,c)] ≤ min(E[W],c)`
 * always, with equality only when every passenger in the window is on the same
 * side of the cap.
 *
 * The truncation is the one that matches the behaviour being modelled. The cap
 * exists because assumption A3 (uniform arrival) is documented to fail at long
 * headways: a rider facing an 11-hour gap consults the timetable and turns up
 * near the departure. That is a statement about **each rider's own wait**, so it
 * belongs to `W(t)` — inside the integral. Capping the average instead would
 * leave the shape of the arrival distribution untouched and merely clip the
 * summary, which describes no rider.
 *
 * Worked example. One departure at 14:30, analysed hour 14:00–15:00, cap 15 min:
 *
 * | | uncapped | `E[min(W,15)]` | `min(E[W],15)` |
 * |---|---|---|---|
 * | wait | 720.00 | **13.13** | 15.00 |
 *
 * The truncated figure is below the cap because arrivals between 14:15 and
 * 14:30 wait less than 15 minutes and are averaged in at their real wait; only
 * the 14:30–15:00 arrivals, who face the next day's service, are truncated.
 *
 * Consequences that follow from the definition and are asserted by tests:
 *
 * - `E[min(W,c)] ≤ c`, so a cap is a genuine bound on the reported figure;
 * - `E[min(W,c)]` is non-decreasing in `c`, so `cap_5 ≤ cap_10 ≤ cap_15 ≤ uncapped`;
 * - the cap never changes a wait already everywhere below it, so `capApplied`
 *   is false exactly when the cap is inert.
 *
 * Each cap, including no cap, is an explicit scenario dimension rather than a
 * hidden default.
 */
export type WaitCapScenario = 'uncapped' | 'cap_15' | 'cap_10' | 'cap_5'

export const WAIT_CAP_SCENARIOS: readonly WaitCapScenario[] = [
  'uncapped',
  'cap_15',
  'cap_10',
  'cap_5',
] as const

export function capMinutes(scenario: WaitCapScenario): number {
  switch (scenario) {
    case 'cap_5':
      return 5
    case 'cap_10':
      return 10
    case 'cap_15':
      return 15
    default:
      return Infinity
  }
}

export const WAIT_CAP_LABEL: Record<WaitCapScenario, string> = {
  uncapped: 'No cap — pure random incidence',
  cap_15: 'Per-passenger wait truncated at 15 min',
  cap_10: 'Per-passenger wait truncated at 10 min',
  cap_5: 'Per-passenger wait truncated at 5 min',
}

/** The single sentence the product shows wherever a cap is named. */
export const WAIT_CAP_RULE =
  'A cap truncates each passenger’s own wait before averaging: E[min(W, c)] over arrivals ' +
  'uniform on the analysed hour. It is NOT min(E[W], c) — the reported figure can and does ' +
  'sit below the cap, because arrivals shortly before a departure are averaged in at their ' +
  'real wait rather than at the cap.'

const MINUTES_PER_DAY = 1440

/* -------------------------------------------------------------------------- */
/* Gaps, clipped to the arrival window                                        */
/* -------------------------------------------------------------------------- */

/** One scheduled gap, together with the part of it that lies inside the window. */
export interface WindowGap {
  /** Full scheduled gap, minutes — the headway a rider would quote. */
  gapMinutes: number
  /** Departure closing the gap, minutes past midnight (may sit outside 0–1440). */
  nextDeparture: number
  /** Arrivals inside the window that land in this gap: `[arrivalFrom, arrivalTo)`. */
  arrivalFrom: number
  arrivalTo: number
}

/**
 * The scheduled gaps a passenger arriving in `[windowStart, windowEnd)` can land
 * in, each carrying its clipped arrival sub-interval.
 *
 * Departures are minutes past midnight and wrap, so the list is extended by a
 * preceding and a following day: that closes the gap running into the window
 * from the previous service day and the one that closes the service day itself.
 * Together the clipped sub-intervals tile the window exactly whenever any
 * departure exists at all.
 */
export function windowGaps(
  departures: readonly number[],
  windowStart: number,
  windowEnd: number,
): WindowGap[] {
  if (departures.length === 0 || windowEnd <= windowStart) return []

  const sorted = [...new Set(departures)].sort((a, b) => a - b)
  const extended = [
    ...sorted.map((minute) => minute - MINUTES_PER_DAY),
    ...sorted,
    ...sorted.map((minute) => minute + MINUTES_PER_DAY),
  ]

  const gaps: WindowGap[] = []
  for (let index = 0; index < extended.length - 1; index += 1) {
    const from = extended[index]!
    const to = extended[index + 1]!
    if (to <= from) continue
    // Reachable only if the gap overlaps the arrival window; the overlap, not
    // the gap, is what a passenger arriving in this hour can experience.
    if (to <= windowStart || from >= windowEnd) continue
    gaps.push({
      gapMinutes: to - from,
      nextDeparture: to,
      arrivalFrom: Math.max(from, windowStart),
      arrivalTo: Math.min(to, windowEnd),
    })
  }
  return gaps
}

/**
 * Full lengths of the gaps overlapping the window.
 *
 * Kept as the headway view of the same timetable — it answers "how far apart are
 * the buses here", which is a property of the schedule, not of the analysed
 * hour. Waiting time is computed from `windowGaps`, which clips.
 */
export function gapsCoveringWindow(
  departures: readonly number[],
  windowStart: number,
  windowEnd: number,
): number[] {
  return windowGaps(departures, windowStart, windowEnd).map((gap) => gap.gapMinutes)
}

/**
 * `∫ min(u, cap) du` for `u` running from `lo` to `hi`, with `0 ≤ lo ≤ hi`.
 *
 * Three regimes: entirely below the cap (the plain quadratic), entirely above it
 * (a rectangle), or split, in which case the crossing point is exactly `cap`.
 */
function truncatedIntegral(lo: number, hi: number, cap: number): number {
  if (!Number.isFinite(cap) || hi <= cap) return (hi * hi - lo * lo) / 2
  if (lo >= cap) return cap * (hi - lo)
  return (cap * cap - lo * lo) / 2 + cap * (hi - cap)
}

export interface WaitResult {
  /** Minutes, after the cap. Null when no departure serves the window. */
  waitMinutes: number | null
  /** The same quantity with no cap applied, for reporting what the cap did. */
  uncappedWaitMinutes: number | null
  /** Full scheduled gaps the integral ran over. */
  gaps: number[]
  /** Mean scheduled headway over the same gaps, for comparison. */
  meanHeadwayMinutes: number | null
  /** True when the cap changed the answer. */
  capApplied: boolean
}

const EMPTY: WaitResult = {
  waitMinutes: null,
  uncappedWaitMinutes: null,
  gaps: [],
  meanHeadwayMinutes: null,
  capApplied: false,
}

/**
 * `E[min(W, cap)]` over arrivals uniform on `[windowStart, windowEnd)`.
 *
 * The window length is recovered as the total clipped width rather than assumed,
 * so a window no departure can serve returns null instead of dividing by a span
 * that was never covered.
 */
export function randomIncidenceWait(
  departures: readonly number[],
  windowStart: number,
  windowEnd: number,
  cap: number = Infinity,
): WaitResult {
  const gaps = windowGaps(departures, windowStart, windowEnd)
  if (gaps.length === 0) return EMPTY

  let arrivalSpan = 0
  let cappedIntegral = 0
  let uncappedIntegral = 0
  let headwaySum = 0

  for (const gap of gaps) {
    const width = gap.arrivalTo - gap.arrivalFrom
    if (width <= 0) continue
    // Wait falls linearly from `hi` at the start of the sub-interval to `lo` at
    // its end, both measured against the departure that closes the gap.
    const hi = gap.nextDeparture - gap.arrivalFrom
    const lo = gap.nextDeparture - gap.arrivalTo
    arrivalSpan += width
    uncappedIntegral += truncatedIntegral(lo, hi, Infinity)
    cappedIntegral += truncatedIntegral(lo, hi, cap)
    headwaySum += gap.gapMinutes
  }

  if (arrivalSpan <= 0) return { ...EMPTY, gaps: gaps.map((gap) => gap.gapMinutes) }

  const capped = cappedIntegral / arrivalSpan
  const uncapped = uncappedIntegral / arrivalSpan
  return {
    waitMinutes: capped,
    uncappedWaitMinutes: uncapped,
    gaps: gaps.map((gap) => gap.gapMinutes),
    meanHeadwayMinutes: headwaySum / gaps.length,
    capApplied: capped < uncapped,
  }
}

/**
 * Expected wait at a stop for one hour, under a stated route-choice model.
 *
 * Returns `null` when nothing is scheduled — a passenger cannot be waiting for
 * a service that does not run, and returning a number here would push
 * fabricated exposure into the metric.
 */
export function expectedWait(
  routeDepartures: Readonly<Record<string, readonly number[]>>,
  hour: number,
  model: RouteChoiceModel,
  cap: number = Infinity,
): WaitResult {
  const windowStart = hour * 60
  const windowEnd = windowStart + 60
  const routes = Object.values(routeDepartures).filter((list) => list.length > 0)
  if (routes.length === 0) return EMPTY

  if (model === 'union_timetable') {
    return randomIncidenceWait(routes.flat(), windowStart, windowEnd, cap)
  }

  const perRoute = routes.map((departures) => ({
    departures,
    result: randomIncidenceWait(departures, windowStart, windowEnd, cap),
  }))
  const usable = perRoute.filter((entry) => entry.result.waitMinutes !== null)
  if (usable.length === 0) return EMPTY

  if (model === 'worst_route') {
    // "Least convenient route" is a property of the timetable, so the worst
    // route is chosen on the uncapped wait. Choosing on the capped figure would
    // let several routes tie at the cap and pick between them arbitrarily.
    return usable.reduce((worst, entry) =>
      (entry.result.uncappedWaitMinutes ?? 0) > (worst.result.uncappedWaitMinutes ?? 0)
        ? entry
        : worst,
    ).result
  }

  // frequency_share_unsourced — weights sum to 1, so a passenger still waits
  // once. The weights themselves are a stand-in for a split nobody publishes.
  let denominator = 0
  for (const entry of usable) {
    denominator += entry.departures.filter(
      (minute) => minute >= windowStart && minute < windowEnd,
    ).length
  }

  const combine = (weightOf: (entry: (typeof usable)[number]) => number): WaitResult => {
    let capped = 0
    let uncapped = 0
    for (const entry of usable) {
      const weight = weightOf(entry)
      capped += weight * (entry.result.waitMinutes ?? 0)
      uncapped += weight * (entry.result.uncappedWaitMinutes ?? 0)
    }
    return {
      waitMinutes: capped,
      uncappedWaitMinutes: uncapped,
      gaps: usable.flatMap((entry) => entry.result.gaps),
      meanHeadwayMinutes: null,
      capApplied: capped < uncapped,
    }
  }

  if (denominator <= 0) return combine(() => 1 / usable.length)

  return combine(
    (entry) =>
      entry.departures.filter((minute) => minute >= windowStart && minute < windowEnd).length /
      denominator,
  )
}
