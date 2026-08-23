/**
 * Metric A — Estimated scenario exposure load (ESEL).
 *
 *   ESEL(stop) = Σ_h  riders(h) · wait(h) · max(0, T(h) − T_ref)
 *
 * Unit: **scenario °C·rider-minutes**, over the analysed hours only. Not a daily
 * total, not a health outcome — a dimensioned quantity comparable between stops
 * within a run.
 *
 * ## What the name commits to, and what it refuses
 *
 * *Estimated*: no term is measured at a stop. *Scenario*: the value is
 * conditional on five settings nobody has observed, and moves when they move.
 * *Exposure load*: a modelled product of three quantities.
 *
 * In particular `riders(h)` is a published quarterly average pushed through an
 * unobserved hourly profile — **nobody counted a rider at this stop in this
 * hour** — and `wait(h)` is read off a timetable rather than observed. Nothing
 * here is a measurement of exposure and no code path may present it as one; the
 * run payload carries `isMeasurement: false` structurally so a new call site
 * cannot quietly imply otherwise.
 *
 * ## The three terms, and where each is decided
 *
 * | Term | Module | Decided by |
 * |---|---|---|
 * | `riders(h)` | `demand.ts` | daily published total × an hourly profile that sums to 1 |
 * | `wait(h)` | `waiting.ts` | E[min(W, cap)] over GTFS gaps clipped to the hour, per route-choice model |
 * | `T(h)` | thermal layer | FortyGuard, or the labelled synthetic fixture |
 *
 * ## What `T_ref` is, and is not
 *
 * `T_ref` defaults to **30 °C because that is FortyGuard's documented default
 * for the `exceedance` and `persistence` analytics** — an API convention, taken
 * so the reference is at least sourced from the data provider rather than
 * invented here. **It is not a health or heat-stress threshold.** No source used
 * by this project publishes one, and none should be inferred from this number.
 * It is swept across 30/35/40 °C in the scenario envelope.
 *
 * ## Scenario envelope, not an uncertainty interval
 *
 * Five things are unobserved. Each is a scenario dimension, and the product
 * reports the **envelope** across their full cross product rather than a
 * confidence interval — nothing here is a sampling distribution, so calling the
 * spread an uncertainty interval would misrepresent what it is.
 */

import type { DayType, TransitStop } from '@/lib/types'
import { RIDERSHIP_CATEGORY_FOR_DAY_TYPE } from '@/lib/types'
import { round } from './stats'
import { DEMAND_PROFILES, allocateDailyRiders, type DemandProfile } from './demand'
import {
  ROUTE_CHOICE_MODELS,
  WAIT_CAP_SCENARIOS,
  capMinutes,
  expectedWait,
  type RouteChoiceModel,
  type WaitCapScenario,
} from './waiting'

/* -------------------------------------------------------------------------- */
/* Scenario space                                                             */
/* -------------------------------------------------------------------------- */

export const REFERENCE_TEMPERATURES_C = [30, 35, 40] as const

/**
 * Quarters used for the temporal-drift dimension.
 *
 * Sourced, not invented: the ridership period (FY2024 Q4 = Apr–Jun 2024) does
 * not match the GTFS schedule (July 2026) or the thermal date, so drift is
 * modelled by recomputing on the neighbouring published quarters. A uniform
 * multiplier would have been useless — it cannot change a ranking.
 *
 * `2024_4` is the **latest quarter passing this project's own completeness
 * checks**, not "the latest complete quarter": later quarters are published but
 * collapse under those checks, and no independent source reconciles any of them.
 * See `docs/data-provenance.md` §2b.
 */
export const DRIFT_QUARTERS = ['2024_4', '2024_3', '2024_2'] as const

/**
 * The base scenario.
 *
 * `waitCap: 'cap_15'` deserves an explanation, because "uncapped" looks like the
 * assumption-free choice and is not.
 *
 * Assumption A3 — uniform passenger arrival — is *documented as failing* for long
 * headways: riders consult a timetable rather than turning up at random. Running
 * uncapped applies A3 exactly where A3 is known to be invalid, and the result is
 * not neutral. Measured on Central Phoenix at capacity 50, running uncapped puts
 * **three** stops with a mean expected wait over an hour into the plan — at
 * ranks 4 (663 minutes, eleven hours), 10 and 13 (374 minutes) — because a
 * once-daily stop genuinely does have an enormous expected wait for a uniformly
 * arriving passenger. Nobody waits eleven hours for a bus. Under `cap_15` no
 * selection exceeds a mean wait of 11.33 minutes.
 *
 * So the base applies the **longest** cap, which is the least constraining
 * choice that stays out of the known-invalid regime. `uncapped` remains in the
 * envelope alongside the shorter caps, so the effect of this choice is measured
 * and reported rather than hidden.
 *
 * What the cap *does* is defined precisely in `waiting.ts`: it truncates each
 * rider's own wait before averaging, `E[min(W, c)]`, not `min(E[W], c)`.
 */
export const BASE_SCENARIO: ExposureScenario = {
  demandProfile: 'proportional_to_departures',
  routeChoice: 'union_timetable',
  waitCap: 'cap_15',
  referenceTemperatureC: 30,
  ridershipQuarter: '2024_4',
}

export interface ExposureScenario {
  demandProfile: DemandProfile
  routeChoice: RouteChoiceModel
  waitCap: WaitCapScenario
  referenceTemperatureC: number
  ridershipQuarter: string
}

const MINUTES_PER_DAY = 1440

/**
 * The day type that ran on the calendar day **before** the one analysed.
 *
 * The small hours of a calendar day are served by the *previous* service day's
 * post-midnight trips, and that previous day is frequently a different day type:
 * 01:10 on a Saturday is served by Friday's weekday service, and 01:10 on a
 * Monday by Sunday's. Wrapping each day type's own `24:xx` trips onto its own
 * early hours — which is what a plain modulo does — attributes Saturday-morning
 * service to Saturday's timetable when Friday ran it.
 */
export function precedingDayType(dayType: DayType): DayType {
  switch (dayType) {
    // Saturday morning is served by Friday night, a weekday.
    case 'saturday':
      return 'weekday'
    // Sunday morning is served by Saturday night.
    case 'sunday':
      return 'saturday'
    // Monday morning is served by Sunday night. Tuesday-to-Friday mornings are
    // served by the preceding weekday, which is the same modal pattern, so a
    // single answer cannot be right for every weekday. `sunday` is chosen
    // because it is the conservative one: it is the thinnest service, so the
    // early-hours wait is never understated.
    case 'weekday':
    default:
      return 'sunday'
  }
}

/**
 * Project GTFS **service-day** minutes onto the 24 clock hours.
 *
 * The dataset preserves GTFS semantics: a departure at 25:10 is stored as 1510,
 * meaning "01:10 of the following calendar day, still on this service day". The
 * analysis works in clock hours — a temperature is requested for 14:00 local,
 * not for "minute 840 of Tuesday's service day".
 *
 * Two different projections are needed, and conflating them was the bug:
 *
 * - **`inDay`** keeps only the departures that fall on this calendar day, i.e.
 *   minutes below 1440. These belong to the analysed day type.
 * - **`afterMidnight`** keeps only the `24:xx` and later departures, mapped back
 *   into `[0, 1440)`. These serve the *following* calendar morning, so they are
 *   contributed by the **preceding** day type, not by this one.
 *
 * The named assumption is unchanged in spirit and sharper in fact:
 *
 *   **A9 — repeating service day.** The service day preceding the analysed one
 *   ran the modal timetable for *its own day type*, so its post-midnight
 *   departures stand in for this calendar day's small hours. Fails across a
 *   service change or the day either side of a holiday.
 */
export function projectServiceDayToClock(
  serviceDayMinutes: readonly number[],
  part: 'inDay' | 'afterMidnight' = 'inDay',
): number[] {
  const clock = new Set<number>()
  for (const minute of serviceDayMinutes) {
    if (!Number.isFinite(minute) || minute < 0) continue
    const afterMidnight = minute >= MINUTES_PER_DAY
    if (part === 'inDay' && afterMidnight) continue
    if (part === 'afterMidnight' && !afterMidnight) continue
    clock.add(minute % MINUTES_PER_DAY)
  }
  return [...clock].sort((a, b) => a - b)
}

/**
 * Route timetables for one calendar day, on the clock.
 *
 * Composed from two service days: this day type's own in-day departures, plus
 * the preceding day type's post-midnight departures, which is what actually runs
 * in the small hours.
 */
export function clockTimetableFor(
  stop: TransitStop,
  dayType: DayType,
  /**
   * The day type that actually ran the night before.
   *
   * Supplied by the caller when a real analysis **date** is known, because the
   * date answers this exactly and the day type alone cannot: Monday's small
   * hours are served by Sunday and Wednesday's by Tuesday, and both are
   * `weekday`. Omitted, it falls back to the conservative modal answer below.
   */
  precedingOverride?: DayType,
): Record<string, number[]> | null {
  const own = stop.service?.byDayType?.[dayType]
  const previous = stop.service?.byDayType?.[precedingOverride ?? precedingDayType(dayType)]

  const out: Record<string, number[]> = {}

  // Deliberately no early return when this day type has no record of its own: a
  // stop served only by the previous day's late trips genuinely does have
  // service in the small hours, and reporting none would be the mirror image of
  // the bug this function exists to fix.
  for (const [route, minutes] of Object.entries(own?.routeDepartures ?? {})) {
    const projected = projectServiceDayToClock(minutes, 'inDay')
    if (projected.length > 0) out[route] = projected
  }

  // The preceding service day's 24:xx trips land in this calendar morning.
  for (const [route, minutes] of Object.entries(previous?.routeDepartures ?? {})) {
    const carried = projectServiceDayToClock(minutes, 'afterMidnight')
    if (carried.length === 0) continue
    const merged = new Set([...(out[route] ?? []), ...carried])
    out[route] = [...merged].sort((a, b) => a - b)
  }

  return Object.keys(out).length > 0 ? out : null
}

/** The full cross product: 3 × 3 × 4 × 3 × 3 = 324 scenarios. */
export function enumerateScenarios(): ExposureScenario[] {
  const out: ExposureScenario[] = []
  for (const demandProfile of DEMAND_PROFILES) {
    for (const routeChoice of ROUTE_CHOICE_MODELS) {
      for (const waitCap of WAIT_CAP_SCENARIOS) {
        for (const referenceTemperatureC of REFERENCE_TEMPERATURES_C) {
          for (const ridershipQuarter of DRIFT_QUARTERS) {
            out.push({
              demandProfile,
              routeChoice,
              waitCap,
              referenceTemperatureC,
              ridershipQuarter,
            })
          }
        }
      }
    }
  }
  return out
}

export const SCENARIO_DIMENSIONS = [
  'demandProfile',
  'routeChoice',
  'waitCap',
  'referenceTemperatureC',
  'ridershipQuarter',
] as const

/* -------------------------------------------------------------------------- */
/* Per-stop precomputation                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Everything about one stop that a scenario can select from, computed once.
 *
 * Waiting depends only on (routeChoice, waitCap, hour); demand only on
 * (demandProfile, quarter, dayType). Precomputing both collapses 324
 * scenarios per stop into 324 cheap multiplications instead of 324 full
 * recomputations.
 */
export interface StopScenarioTable {
  stopId: number
  dayType: DayType
  hours: number[]
  /** `${routeChoice}|${waitCap}` -> wait minutes per analysed hour. */
  waitByModel: Map<string, Array<number | null>>
  /**
   * `${quarter}|${profile}` -> riders per analysed hour.
   *
   * A quarter that publishes **no** figure for this stop and day category has no
   * entry at all. It is not a row of zeros: a missing ridership figure is not a
   * stop with no riders, and treating it as one silently pushed unmeasured stops
   * to the bottom of the ranking while counting them as fully evaluated.
   */
  ridersByQuarter: Map<string, number[]>
  /** Riders allocated across all 24 hours, per quarter, for the sum identity. */
  dailyTotalByQuarter: Map<string, number>
  temperatureByHour: Map<number, number>
  hasService: boolean
  hasRidership: boolean
  hasTemperature: boolean
  /** Analysed hours that received a temperature at this stop. */
  hoursWithTemperature: number
  /**
   * True only when **every** analysed hour has a temperature.
   *
   * ESEL is a sum over the analysed hours. Summing over whichever hours happened
   * to return a value compares a three-hour stop with a one-hour stop as though
   * they were the same quantity, and the shortfall shows up as a *lower* load —
   * indistinguishable from a genuinely cooler or quieter stop. So a partially
   * covered stop yields null and says why, rather than a number that means
   * something different from its neighbours'.
   */
  thermalCoverageComplete: boolean
  /** Quarters with no published figure for this stop and day category. */
  quartersUnavailable: string[]
  missing: string[]
}

export function buildStopScenarioTable(input: {
  stop: TransitStop
  temperatureByHour: ReadonlyMap<number, number>
  hours: readonly number[]
  dayType: DayType
  /**
   * The day type that ran the night before, when the analysis date makes it
   * knowable. Omitted, the conservative modal answer is used.
   */
  precedingDayType?: DayType
  demandProfiles?: readonly DemandProfile[]
}): StopScenarioTable {
  const { stop, temperatureByHour, hours, dayType } = input
  const profiles = input.demandProfiles ?? DEMAND_PROFILES
  const ridershipCategory = RIDERSHIP_CATEGORY_FOR_DAY_TYPE[dayType]

  // The timetable for THIS day type — never a weekday timetable standing in for
  // a weekend one.
  const dayService = stop.service?.byDayType?.[dayType] ?? null
  const timetable = clockTimetableFor(stop, dayType, input.precedingDayType)

  const missing: string[] = []
  const hasService = dayService !== null && dayService.dailyDepartures > 0 && timetable !== null
  const hasRidership = stop.ridership !== null
  const hoursWithTemperature = hours.filter((hour) => temperatureByHour.has(hour)).length
  const hasTemperature = hoursWithTemperature > 0
  const thermalCoverageComplete = hours.length > 0 && hoursWithTemperature === hours.length

  if (!hasRidership) missing.push('published ridership')
  if (!hasService) missing.push(`scheduled ${dayType} service`)
  if (!hasTemperature) missing.push('heat signal')
  else if (!thermalCoverageComplete) {
    missing.push(
      `heat signal for ${hours.length - hoursWithTemperature} of ${hours.length} analysed hours`,
    )
  }

  const waitByModel = new Map<string, Array<number | null>>()
  if (hasService && timetable) {
    for (const routeChoice of ROUTE_CHOICE_MODELS) {
      for (const waitCap of WAIT_CAP_SCENARIOS) {
        waitByModel.set(
          `${routeChoice}|${waitCap}`,
          hours.map(
            (hour) =>
              expectedWait(timetable, hour, routeChoice, capMinutes(waitCap)).waitMinutes,
          ),
        )
      }
    }
  }

  const ridersByQuarter = new Map<string, number[]>()
  const dailyTotalByQuarter = new Map<string, number>()
  const quartersUnavailable: string[] = []

  if (hasRidership && hasService && dayService && stop.ridership) {
    for (const quarter of DRIFT_QUARTERS) {
      const published = stop.ridership.byQuarter[quarter]?.[ridershipCategory] ?? null
      if (published === null) {
        // No entry, so every scenario naming this quarter is UNAVAILABLE rather
        // than evaluated-at-zero.
        quartersUnavailable.push(quarter)
        continue
      }
      for (const profile of profiles) {
        const allocation = allocateDailyRiders(published, dayService.hourlyDepartures, profile)
        ridersByQuarter.set(
          `${quarter}|${profile}`,
          hours.map((hour) => allocation.ridersByHour[hour] ?? 0),
        )
        dailyTotalByQuarter.set(
          `${quarter}|${profile}`,
          allocation.ridersByHour.reduce((sum, value) => sum + value, 0),
        )
      }
    }
  }

  return {
    stopId: stop.id,
    dayType,
    hours: [...hours],
    waitByModel,
    ridersByQuarter,
    dailyTotalByQuarter,
    temperatureByHour: new Map(temperatureByHour),
    hasService,
    hasRidership,
    hasTemperature,
    hoursWithTemperature,
    thermalCoverageComplete,
    quartersUnavailable,
    missing,
  }
}

/**
 * Whether this scenario can be evaluated for this stop at all.
 *
 * Distinct from "evaluates to zero". A scenario naming a quarter for which the
 * source publishes no figure at this stop is **unavailable**, and unavailable
 * scenarios are excluded from the robustness denominator rather than counted as
 * scenarios in which the stop failed to be selected.
 */
export function scenarioAvailable(
  table: StopScenarioTable,
  scenario: ExposureScenario,
): boolean {
  if (table.missing.length > 0) return false
  if (!table.thermalCoverageComplete) return false
  if (!table.waitByModel.has(`${scenario.routeChoice}|${scenario.waitCap}`)) return false
  return table.ridersByQuarter.has(`${scenario.ridershipQuarter}|${scenario.demandProfile}`)
}

/** How many of the given scenarios this stop can be evaluated under. */
export function scenariosAvailableFor(
  table: StopScenarioTable,
  scenarios: readonly ExposureScenario[],
): number {
  let count = 0
  for (const scenario of scenarios) if (scenarioAvailable(table, scenario)) count += 1
  return count
}

/**
 * Evaluate one scenario against a precomputed table.
 *
 * `null` means **not evaluable** — never "zero exposure". Callers that need to
 * tell the two apart ask `scenarioAvailable` first.
 */
export function exposureForScenario(
  table: StopScenarioTable,
  scenario: ExposureScenario,
): number | null {
  if (!scenarioAvailable(table, scenario)) return null

  const waits = table.waitByModel.get(`${scenario.routeChoice}|${scenario.waitCap}`)!
  const riders = table.ridersByQuarter.get(
    `${scenario.ridershipQuarter}|${scenario.demandProfile}`,
  )!

  // Every analysed hour is present — `scenarioAvailable` already rejected a
  // table with partial thermal coverage, so this sum covers the same hours at
  // every stop and the values stay comparable.
  let total = 0
  for (let index = 0; index < table.hours.length; index += 1) {
    const hour = table.hours[index]!
    const temperature = table.temperatureByHour.get(hour)
    if (temperature === undefined) return null
    const wait = waits[index] ?? null
    const people = riders[index] ?? 0
    if (wait === null || people <= 0) continue
    const excess = Math.max(0, temperature - scenario.referenceTemperatureC)
    total += people * wait * excess
  }
  return total
}

/* -------------------------------------------------------------------------- */
/* Base result and decomposition                                              */
/* -------------------------------------------------------------------------- */

export interface HourlyExposure {
  hour: number
  riders: number
  waitMinutes: number | null
  temperatureC: number | null
  excessC: number | null
  exposure: number | null
}

export interface StopExposure {
  stopId: number
  exposure: number | null
  hourly: HourlyExposure[]
  ridersInWindow: number
  /** Published daily total the allocation was drawn from, for the sum identity. */
  publishedDailyRiders: number | null
  ridersAllocatedAcrossDay: number | null
  meanWaitMinutes: number | null
  meanExcessC: number | null
  missing: string[]
}

export function computeStopExposure(
  table: StopScenarioTable,
  scenario: ExposureScenario,
): StopExposure {
  const waits = table.waitByModel.get(`${scenario.routeChoice}|${scenario.waitCap}`)
  // Absent, not zero: an unavailable quarter leaves `riders` undefined and every
  // hourly row reports null riders rather than a fabricated zero.
  const riders = table.ridersByQuarter.get(
    `${scenario.ridershipQuarter}|${scenario.demandProfile}`,
  )

  const hourly: HourlyExposure[] = []
  let ridersTotal = 0
  let waitWeighted = 0
  let excessWeighted = 0

  for (let index = 0; index < table.hours.length; index += 1) {
    const hour = table.hours[index]!
    const temperature = table.temperatureByHour.get(hour) ?? null
    const wait = waits?.[index] ?? null
    const people = riders?.[index] ?? 0
    const excess =
      temperature === null ? null : Math.max(0, temperature - scenario.referenceTemperatureC)
    const exposure =
      temperature === null || wait === null ? null : people * wait * (excess ?? 0)

    if (exposure !== null && wait !== null) {
      ridersTotal += people
      waitWeighted += people * wait
      excessWeighted += people * (excess ?? 0)
    }

    hourly.push({
      hour,
      riders: round(people, 3),
      waitMinutes: wait === null ? null : round(wait, 2),
      temperatureC: temperature === null ? null : round(temperature, 2),
      excessC: excess === null ? null : round(excess, 2),
      exposure: exposure === null ? null : round(exposure, 3),
    })
  }

  const total = exposureForScenario(table, scenario)

  return {
    stopId: table.stopId,
    exposure: total === null ? null : round(total, 3),
    hourly,
    ridersInWindow: round(ridersTotal, 3),
    publishedDailyRiders: null,
    ridersAllocatedAcrossDay:
      table.dailyTotalByQuarter.get(`${scenario.ridershipQuarter}|${scenario.demandProfile}`) ??
      null,
    meanWaitMinutes: ridersTotal > 0 ? round(waitWeighted / ridersTotal, 2) : null,
    meanExcessC: ridersTotal > 0 ? round(excessWeighted / ridersTotal, 2) : null,
    missing: table.missing,
  }
}

/* -------------------------------------------------------------------------- */
/* Scenario envelope                                                          */
/* -------------------------------------------------------------------------- */

export interface ScenarioEnvelope {
  stopId: number
  /** Lowest and highest ESEL across the whole scenario cross product. */
  low: number | null
  high: number | null
  /** high / low. 1 means no scenario choice changes this stop's value. */
  spreadRatio: number | null
  /** Scenarios this stop could actually be evaluated under. */
  scenariosEvaluated: number
  /** Scenarios offered. `scenariosEvaluated` is the honest denominator. */
  scenariosOffered: number
  /** Offered minus evaluated — scenarios naming data this stop does not have. */
  scenariosUnavailable: number
}

export function scenarioEnvelope(
  table: StopScenarioTable,
  scenarios: readonly ExposureScenario[],
): ScenarioEnvelope {
  let low = Infinity
  let high = -Infinity
  let count = 0

  for (const scenario of scenarios) {
    const value = exposureForScenario(table, scenario)
    if (value === null) continue
    count += 1
    if (value < low) low = value
    if (value > high) high = value
  }

  if (count === 0) {
    return {
      stopId: table.stopId,
      low: null,
      high: null,
      spreadRatio: null,
      scenariosEvaluated: 0,
      scenariosOffered: scenarios.length,
      scenariosUnavailable: scenarios.length,
    }
  }
  return {
    stopId: table.stopId,
    low: round(low, 3),
    high: round(high, 3),
    spreadRatio: low > 0 ? round(high / low, 2) : null,
    scenariosEvaluated: count,
    scenariosOffered: scenarios.length,
    scenariosUnavailable: scenarios.length - count,
  }
}
