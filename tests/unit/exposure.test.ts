import { describe, expect, it } from 'vitest'
import type { TransitStop } from '@/lib/types'
import {
  BASE_SCENARIO,
  DRIFT_QUARTERS,
  REFERENCE_TEMPERATURES_C,
  SCENARIO_DIMENSIONS,
  buildStopScenarioTable,
  computeStopExposure,
  enumerateScenarios,
  exposureForScenario,
  scenarioEnvelope,
} from '@/lib/metrics/exposure'
import { DEMAND_PROFILES, allocateDailyRiders } from '@/lib/metrics/demand'
import {
  ROUTE_CHOICE_MODELS,
  WAIT_CAP_RULE,
  WAIT_CAP_SCENARIOS,
  capMinutes,
  expectedWait,
  gapsCoveringWindow,
  randomIncidenceWait,
  windowGaps,
} from '@/lib/metrics/waiting'

/**
 * Regression tests for the twelve methodology rules. Each `RULE n` block maps to
 * one numbered requirement.
 */

/** Departures every `every` minutes from `from` to `to`, in minutes past midnight. */
const every = (from: number, to: number, step: number): number[] => {
  const out: number[] = []
  for (let minute = from; minute <= to; minute += step) out.push(minute)
  return out
}

function stop(overrides: Partial<TransitStop> = {}): TransitStop {
  const departures = every(6 * 60, 20 * 60, 10) // every 10 min, 06:00–20:00
  const hourly = new Array(24).fill(0)
  for (const minute of departures) hourly[Math.floor(minute / 60)] += 1
  return {
    id: 1,
    code: 1,
    name: 'Test Stop',
    description: '',
    lat: 33.45,
    lon: -112.07,
    routes: ['1'],
    ridership: {
      baseQuarter: '2024_4',
      byQuarter: {
        '2024_4': { weekday: 100, weekend: 40 },
        '2024_3': { weekday: 120, weekend: 45 },
        '2024_2': { weekday: 90, weekend: 38 },
      },
    },
    service: {
      byDayType: {
        weekday: {
          dailyDepartures: departures.length,
          routeCount: 1,
          hourlyDepartures: hourly,
          routeDepartures: { '1': departures },
          departuresAfterMidnight: 0,
        },
      },
    },
    legacyRidershipIndex: null,
    matchMethod: 'stop_id',
    shelterStatus: 'unknown',
    ...overrides,
  }
}

const HOURS = [11, 14, 17]
const TEMPS = new Map([
  [11, 38],
  [14, 44],
  [17, 41],
])

const tableFor = (s: TransitStop = stop(), temps = TEMPS) =>
  buildStopScenarioTable({
    stop: s,
    temperatureByHour: temps,
    hours: HOURS,
    dayType: 'weekday',
  })

/* ========================================================================== */
/* RULE 1 & 2 — daily ridership to riders(h), and the sum identity            */
/* ========================================================================== */

describe('RULE 1/2 — demand allocation and the sum identity', () => {
  const hourly = new Array(24).fill(0)
  for (let hour = 6; hour < 20; hour += 1) hourly[hour] = 6

  it('allocates riders(h) = R × w(h) with Σ w(h) = 1', () => {
    for (const profile of DEMAND_PROFILES) {
      const allocation = allocateDailyRiders(100, hourly, profile)
      const weightSum = allocation.weights.reduce((sum, value) => sum + value, 0)
      expect(weightSum, profile).toBeCloseTo(1, 12)
    }
  })

  it('ENFORCES Σ riders(h) = published average daily ridership, for every profile', () => {
    for (const published of [0.01, 1, 42.37, 100, 1128.9]) {
      for (const profile of DEMAND_PROFILES) {
        const allocation = allocateDailyRiders(published, hourly, profile)
        const total = allocation.ridersByHour.reduce((sum, value) => sum + value, 0)
        expect(total, `${profile} @ ${published}`).toBeCloseTo(published, 9)
      }
    }
  })

  it('never allocates demand into an hour with no scheduled service', () => {
    const sparse = new Array(24).fill(0)
    sparse[7] = 4
    sparse[8] = 4
    sparse[17] = 4
    for (const profile of DEMAND_PROFILES) {
      const allocation = allocateDailyRiders(100, sparse, profile)
      for (let hour = 0; hour < 24; hour += 1) {
        if (sparse[hour] === 0) expect(allocation.ridersByHour[hour], `${profile} h${hour}`).toBe(0)
      }
      expect(allocation.ridersByHour.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 9)
    }
  })

  it('allocates nothing when the stop has no service at all', () => {
    const allocation = allocateDailyRiders(100, new Array(24).fill(0), 'commute_peak')
    expect(allocation.ridersByHour.every((value) => value === 0)).toBe(true)
    expect(allocation.serviceHours).toHaveLength(0)
  })

  it('preserves the identity through the engine, across all 24 hours', () => {
    const table = buildStopScenarioTable({
      stop: stop(),
      temperatureByHour: TEMPS,
      hours: Array.from({ length: 24 }, (_, hour) => hour),
      dayType: 'weekday',
    })
    const result = computeStopExposure(table, BASE_SCENARIO)
    expect(result.ridersAllocatedAcrossDay).toBeCloseTo(100, 6)
  })
})

/* ========================================================================== */
/* RULE 3 — materially different demand profiles, inside the envelope         */
/* ========================================================================== */

describe('RULE 3 — hourly demand profiles differ materially and are in the envelope', () => {
  const hourly = new Array(24).fill(0)
  for (let hour = 5; hour < 22; hour += 1) hourly[hour] = 4

  it('produces materially different hourly shapes', () => {
    const shapes = DEMAND_PROFILES.map(
      (profile) => allocateDailyRiders(100, hourly, profile).ridersByHour,
    )
    // Flat vs commute must differ substantially at the peak hour.
    const flat = shapes[DEMAND_PROFILES.indexOf('flat_service_hours')]!
    const peak = shapes[DEMAND_PROFILES.indexOf('commute_peak')]!
    // Peak hour carries ~1.8× the flat share; midday carries less than it.
    expect(peak[7]! / flat[7]!).toBeGreaterThan(1.7)
    expect(peak[11]! / flat[11]!).toBeLessThan(0.9)
    // The two shapes disagree over most of the day, not just at one hour.
    const disagreeing = flat.filter(
      (value, hour) => value > 0 && Math.abs(peak[hour]! - value) / value > 0.2,
    ).length
    expect(disagreeing).toBeGreaterThan(8)
  })

  it('changes the exposure when only the profile changes', () => {
    const table = tableFor()
    const values = DEMAND_PROFILES.map((demandProfile) =>
      exposureForScenario(table, { ...BASE_SCENARIO, demandProfile }),
    )
    expect(new Set(values.map((value) => Math.round((value ?? 0) * 100))).size).toBeGreaterThan(1)
  })

  it('includes every profile in the enumerated scenario space', () => {
    const scenarios = enumerateScenarios()
    for (const profile of DEMAND_PROFILES) {
      expect(scenarios.some((s) => s.demandProfile === profile), profile).toBe(true)
    }
  })
})

/* ========================================================================== */
/* RULE 6 — random-incidence wait from actual consecutive GTFS gaps           */
/* ========================================================================== */

describe('RULE 6 — Σgap²/(2Σgap) over actual gaps', () => {
  it('reduces to headway/2 when every gap is equal', () => {
    // Every 10 minutes across the 14:00 hour.
    const result = randomIncidenceWait(every(0, 1439, 10), 840, 900)
    expect(result.waitMinutes).toBeCloseTo(5, 9)
    expect(result.meanHeadwayMinutes).toBeCloseTo(10, 9)
  })

  it('penalises bunching — the inspection paradox, not the mean headway', () => {
    // Departures at 14:00, 14:05, 14:10, then nothing until 15:00.
    // Gaps covering the hour: 5, 5, 50 (and the gap arriving into 14:00).
    const departures = [840, 845, 850, 900]
    const gaps = gapsCoveringWindow(departures, 840, 900)
    expect(gaps).toContain(5)
    expect(gaps).toContain(50)

    const result = randomIncidenceWait(departures, 840, 900)
    const sum = gaps.reduce((a, b) => a + b, 0)
    const sumSq = gaps.reduce((a, b) => a + b * b, 0)
    expect(result.waitMinutes).toBeCloseTo(sumSq / (2 * sum), 9)
    // Mean headway would suggest a much shorter wait than riders experience.
    expect(result.waitMinutes!).toBeGreaterThan(result.meanHeadwayMinutes! / 2)
  })

  it('distinguishes two timetables with identical departures-per-hour', () => {
    // Both run all day at 20-minute intervals and both put exactly three
    // departures in the 14:00 hour. Only the spacing inside that hour differs,
    // which is precisely what a departures-per-hour count cannot see.
    const evenAllDay = every(0, 1439, 20)
    const bunchedAllDay = [
      ...evenAllDay.filter((minute) => minute < 840 || minute >= 900),
      840,
      845,
      850,
    ].sort((a, b) => a - b)

    const inHour = (list: number[]) => list.filter((m) => m >= 840 && m < 900).length
    expect(inHour(evenAllDay)).toBe(inHour(bunchedAllDay))

    const even = randomIncidenceWait(evenAllDay, 840, 900).waitMinutes!
    const bunched = randomIncidenceWait(bunchedAllDay, 840, 900).waitMinutes!
    expect(bunched).toBeGreaterThan(even * 1.4)
  })

  it('reports a long wait honestly when a stop really has almost no service', () => {
    // Three departures in the whole day is a genuinely terrible service, and
    // the estimator must say so rather than reporting the in-hour spacing.
    const sparse = randomIncidenceWait([840, 860, 880], 840, 900).waitMinutes!
    expect(sparse).toBeGreaterThan(100)
  })

  it('returns null when nothing is scheduled', () => {
    expect(randomIncidenceWait([], 840, 900).waitMinutes).toBeNull()
  })

  it('closes the gap across midnight rather than reporting a fake short wait', () => {
    const gaps = gapsCoveringWindow([60, 1380], 0, 60)
    expect(gaps.some((gap) => gap === 120)).toBe(true)
  })
})

/* ========================================================================== */
/* RULE 7 — caps are explicit scenarios, not a silent default                  */
/* ========================================================================== */

describe('RULE 7 — waiting-time caps are explicit scenarios', () => {
  it('keeps every cap, including no cap, as an explicit scenario', () => {
    expect(capMinutes('uncapped')).toBe(Infinity)
    expect(capMinutes('cap_15')).toBe(15)
    // The base uses the longest cap: uncapped would apply the random-arrival
    // assumption exactly where it is documented to fail, which is not neutral —
    // it put 11-hour expected waits near the top of the plan.
    expect(BASE_SCENARIO.waitCap).toBe('cap_15')
  })

  it('bounds the base expected wait, and lets the envelope see the unbounded case', () => {
    const onceDaily = { A: [14 * 60 + 30] }
    const capped = expectedWait(onceDaily, 14, 'union_timetable', capMinutes('cap_15'))
    const uncapped = expectedWait(onceDaily, 14, 'union_timetable', capMinutes('uncapped'))
    expect(uncapped.waitMinutes!).toBeGreaterThan(600)
    // The cap truncates each passenger's own wait, so the mean lands BELOW the
    // cap: arrivals between 14:15 and 14:30 wait less than 15 minutes and are
    // averaged in at their real wait. min(E[W], 15) would report exactly 15.
    expect(capped.waitMinutes!).toBeCloseTo(13.125, 9)
    expect(capped.waitMinutes!).toBeLessThan(15)
  })

  it('offers every cap as its own scenario', () => {
    expect([...WAIT_CAP_SCENARIOS].sort()).toEqual(['cap_10', 'cap_15', 'cap_5', 'uncapped'])
    const scenarios = enumerateScenarios()
    for (const cap of WAIT_CAP_SCENARIOS) {
      expect(scenarios.some((s) => s.waitCap === cap), cap).toBe(true)
    }
  })

  it('applies the cap and reports that it did', () => {
    const hourly = randomIncidenceWait([840, 1440 + 840], 840, 900, 10)
    expect(hourly.waitMinutes).toBe(10)
    expect(hourly.capApplied).toBe(true)
    expect(randomIncidenceWait(every(0, 1439, 10), 840, 900, 10).capApplied).toBe(false)
  })
})

/* ========================================================================== */
/* RULE 6b — gaps that cross the clock-hour boundary                          */
/* ========================================================================== */

describe('RULE 6b — a gap is clipped to the analysed hour before it is weighted', () => {
  // One 160-minute gap, 09:00 → 11:40, touching two analysed hours. The
  // whole-gap form Σgap²/(2Σgap) returns 160²/(2·160) = 80 for BOTH hours; it
  // cannot be right for both, and is right for neither.
  const straddling = [9 * 60, 11 * 60 + 40]

  it('does not charge the whole gap to an hour that only overlaps it', () => {
    const wholeGapForm = (160 * 160) / (2 * 160)
    expect(wholeGapForm).toBe(80)

    const opening = randomIncidenceWait(straddling, 9 * 60, 10 * 60).waitMinutes!
    const closing = randomIncidenceWait(straddling, 10 * 60, 11 * 60).waitMinutes!

    // Arrivals in the hour that OPENS the gap sit furthest from the bus.
    expect(opening).toBeCloseTo(130, 9)
    // Arrivals in the next hour are a full hour closer to it.
    expect(closing).toBeCloseTo(70, 9)
    // The whole-gap form understates one and overstates the other.
    expect(opening).toBeGreaterThan(wholeGapForm)
    expect(closing).toBeLessThan(wholeGapForm)
  })

  it('matches the closed form exactly when the gaps tile the hour', () => {
    // A departure on each edge of the hour: no gap is clipped, so the integral
    // must collapse to Σgap²/(2Σgap). This is the ONLY case in which it does.
    const tiling = [840, 845, 850, 900]
    const gaps = gapsCoveringWindow(tiling, 840, 900)
    expect(gaps.reduce((a, b) => a + b, 0)).toBe(60) // tiles the window exactly

    const sum = gaps.reduce((a, b) => a + b, 0)
    const sumSquares = gaps.reduce((a, b) => a + b * b, 0)
    expect(randomIncidenceWait(tiling, 840, 900).waitMinutes!).toBeCloseTo(
      sumSquares / (2 * sum),
      9,
    )
  })

  it('tiles the arrival window exactly, so no arrival is double counted or lost', () => {
    const timetables = [
      every(0, 1439, 10),
      [9 * 60, 11 * 60 + 40],
      [840, 845, 850, 900],
      [30],
      [0, 1439],
    ]
    for (const departures of timetables) {
      for (const hour of [0, 9, 14, 23]) {
        const clipped = windowGaps(departures, hour * 60, hour * 60 + 60)
        const covered = clipped.reduce((sum, gap) => sum + (gap.arrivalTo - gap.arrivalFrom), 0)
        expect(covered, `h${hour} of ${departures.length} departures`).toBeCloseTo(60, 9)
        // Sub-intervals are contiguous and non-overlapping.
        const ordered = [...clipped].sort((a, b) => a.arrivalFrom - b.arrivalFrom)
        for (let i = 1; i < ordered.length; i += 1) {
          expect(ordered[i]!.arrivalFrom).toBeCloseTo(ordered[i - 1]!.arrivalTo, 9)
        }
      }
    }
  })

  it('keeps the wait bounded by the longest reachable wait in the hour', () => {
    // No mean can exceed the worst individual wait inside the window.
    for (const hour of [7, 12, 19]) {
      const start = hour * 60
      const gaps = windowGaps([9 * 60, 11 * 60 + 40], start, start + 60)
      const worst = Math.max(...gaps.map((gap) => gap.nextDeparture - gap.arrivalFrom))
      expect(randomIncidenceWait([9 * 60, 11 * 60 + 40], start, start + 60).waitMinutes!)
        .toBeLessThanOrEqual(worst + 1e-9)
    }
  })

  it('is unaffected by describing the same timetable over more days', () => {
    // Adding the wrapped copies explicitly must not change the answer, because
    // the extension is already what closes the service day.
    const oneDay = every(6 * 60, 20 * 60, 37)
    const spelledOut = [...oneDay, ...oneDay.map((m) => m + 1440), ...oneDay.map((m) => m - 1440)]
    for (const hour of [5, 6, 13, 20, 21]) {
      expect(
        randomIncidenceWait(spelledOut, hour * 60, hour * 60 + 60).waitMinutes,
        `hour ${hour}`,
      ).toBeCloseTo(randomIncidenceWait(oneDay, hour * 60, hour * 60 + 60).waitMinutes!, 9)
    }
  })

  it('propagates the boundary handling through every route-choice model', () => {
    // Route A opens the long gap, route B closes it. Whichever model is used,
    // no hour may inherit an unclipped gap.
    const routes = { A: [9 * 60], B: [11 * 60 + 40] }
    for (const model of ROUTE_CHOICE_MODELS) {
      const opening = expectedWait(routes, 9, model).waitMinutes!
      const closing = expectedWait(routes, 10, model).waitMinutes!
      expect(opening, model).toBeGreaterThan(closing)
    }
  })
})

/* ========================================================================== */
/* RULE 7b — what a cap means, exactly                                        */
/* ========================================================================== */

describe('RULE 7b — a cap truncates each wait before averaging, not the average', () => {
  // One departure at 14:30, analysed hour 14:00–15:00.
  const onceDaily = [14 * 60 + 30]

  it('is E[min(W, c)], never min(E[W], c)', () => {
    const uncapped = randomIncidenceWait(onceDaily, 840, 900).waitMinutes!
    expect(uncapped).toBeCloseTo(720, 9)

    const capped = randomIncidenceWait(onceDaily, 840, 900, 15).waitMinutes!
    expect(capped).toBeCloseTo(13.125, 9)

    // The distinguishing property: the truncated mean sits strictly BELOW the
    // cap, because arrivals in 14:15–14:30 are averaged in at their real wait.
    expect(capped).toBeLessThan(15)
    expect(capped).not.toBeCloseTo(Math.min(uncapped, 15), 6)
  })

  it('never reports more than the cap', () => {
    for (const cap of WAIT_CAP_SCENARIOS.map(capMinutes).filter(Number.isFinite)) {
      for (const departures of [onceDaily, every(0, 1439, 10), [9 * 60, 11 * 60 + 40], [30]]) {
        for (const hour of [0, 9, 14, 23]) {
          const result = randomIncidenceWait(departures, hour * 60, hour * 60 + 60, cap)
          if (result.waitMinutes === null) continue
          expect(result.waitMinutes, `cap ${cap} h${hour}`).toBeLessThanOrEqual(cap + 1e-9)
        }
      }
    }
  })

  it('is non-decreasing in the cap, so the scenarios order cap_5 ≤ cap_10 ≤ cap_15 ≤ uncapped', () => {
    const ordered = ['cap_5', 'cap_10', 'cap_15', 'uncapped'] as const
    for (const departures of [onceDaily, every(6 * 60, 20 * 60, 23), [9 * 60, 11 * 60 + 40]]) {
      for (const hour of [8, 14, 22]) {
        const waits = ordered.map(
          (scenario) =>
            randomIncidenceWait(departures, hour * 60, hour * 60 + 60, capMinutes(scenario))
              .waitMinutes,
        )
        for (let i = 1; i < waits.length; i += 1) {
          if (waits[i] === null || waits[i - 1] === null) continue
          expect(waits[i]!, `${ordered[i]} vs ${ordered[i - 1]} h${hour}`).toBeGreaterThanOrEqual(
            waits[i - 1]! - 1e-9,
          )
        }
      }
    }
  })

  it('reports capApplied exactly when the cap changed the answer', () => {
    // Inert: every wait in the hour is already below the cap.
    const inert = randomIncidenceWait(every(0, 1439, 10), 840, 900, 15)
    expect(inert.capApplied).toBe(false)
    expect(inert.waitMinutes).toBeCloseTo(inert.uncappedWaitMinutes!, 12)

    // Binding: some arrivals face a wait longer than the cap.
    const binding = randomIncidenceWait(onceDaily, 840, 900, 15)
    expect(binding.capApplied).toBe(true)
    expect(binding.waitMinutes!).toBeLessThan(binding.uncappedWaitMinutes!)
  })

  it('carries the uncapped figure alongside, so the cap’s effect stays visible', () => {
    const result = expectedWait({ A: onceDaily }, 14, 'union_timetable', capMinutes('cap_15'))
    expect(result.uncappedWaitMinutes).toBeCloseTo(720, 9)
    expect(result.waitMinutes).toBeCloseTo(13.125, 9)
  })

  it('states the rule in one sentence that names the quantity it is not', () => {
    expect(WAIT_CAP_RULE).toContain('E[min(W, c)]')
    expect(WAIT_CAP_RULE).toContain('NOT min(E[W], c)')
  })
})

/* ========================================================================== */
/* RULE 8 — route choice: union timetable, or a bracketed range               */
/* ========================================================================== */

describe('RULE 8 — interchangeable routes use the union timetable; otherwise bracket', () => {
  // Two routes, each hourly, offset by 30 minutes. Interchangeable, the rider
  // has an effective 30-minute headway; committed, a 60-minute one.
  const routeDepartures = {
    A: every(0, 1439, 60),
    B: every(30, 1439, 60),
  }

  it('merges interchangeable routes into one timetable', () => {
    const union = expectedWait(routeDepartures, 14, 'union_timetable').waitMinutes!
    expect(union).toBeCloseTo(15, 6)
  })

  it('brackets: union is never worse than being committed to one route', () => {
    const union = expectedWait(routeDepartures, 14, 'union_timetable').waitMinutes!
    const worst = expectedWait(routeDepartures, 14, 'worst_route').waitMinutes!
    expect(union).toBeLessThan(worst)
    expect(worst).toBeCloseTo(30, 6)
  })

  it('labels the frequency-share model as unsourced and keeps it out of the base', () => {
    expect(BASE_SCENARIO.routeChoice).toBe('union_timetable')
    expect(ROUTE_CHOICE_MODELS).toContain('frequency_share_unsourced')
    // The identifier itself carries the warning, so it cannot be displayed as
    // an observed weighting by accident.
    expect(ROUTE_CHOICE_MODELS.find((m) => m.includes('share'))).toMatch(/unsourced/)
  })

  it('never lets route weights inflate the wait beyond a single boarding', () => {
    // Three identical routes: a rider still waits once, not three times.
    const one = expectedWait({ A: every(0, 1439, 10) }, 14, 'frequency_share_unsourced')
      .waitMinutes!
    const three = expectedWait(
      { A: every(0, 1439, 10), B: every(0, 1439, 10), C: every(0, 1439, 10) },
      14,
      'frequency_share_unsourced',
    ).waitMinutes!
    expect(three).toBeCloseTo(one, 6)
  })

  it('includes every route-choice model in the scenario space', () => {
    const scenarios = enumerateScenarios()
    for (const model of ROUTE_CHOICE_MODELS) {
      expect(scenarios.some((s) => s.routeChoice === model), model).toBe(true)
    }
  })
})

/* ========================================================================== */
/* RULE 10 — 30 °C is an API default, not a health threshold                  */
/* ========================================================================== */

describe('RULE 10 — the reference temperature is an API analytic default', () => {
  it('defaults to 30 and sweeps 30/35/40', () => {
    expect(BASE_SCENARIO.referenceTemperatureC).toBe(30)
    expect([...REFERENCE_TEMPERATURES_C]).toEqual([30, 35, 40])
  })

  it('lowers exposure monotonically as the reference rises', () => {
    const table = tableFor()
    const values = REFERENCE_TEMPERATURES_C.map((referenceTemperatureC) =>
      exposureForScenario(table, { ...BASE_SCENARIO, referenceTemperatureC })!,
    )
    expect(values[0]!).toBeGreaterThan(values[1]!)
    expect(values[1]!).toBeGreaterThan(values[2]!)
  })
})

/* ========================================================================== */
/* RULE 9 & 12 — scenario envelope, and assumption sensitivity                */
/* ========================================================================== */

describe('RULE 9/12 — scenario envelope across all five dimensions', () => {
  it('enumerates the full cross product of the five dimensions', () => {
    const scenarios = enumerateScenarios()
    expect(scenarios).toHaveLength(
      DEMAND_PROFILES.length *
        ROUTE_CHOICE_MODELS.length *
        WAIT_CAP_SCENARIOS.length *
        REFERENCE_TEMPERATURES_C.length *
        DRIFT_QUARTERS.length,
    )
    expect(scenarios).toHaveLength(324)
    expect(new Set(scenarios.map((s) => JSON.stringify(s))).size).toBe(scenarios.length)
  })

  it('names exactly the five dimensions the rules require', () => {
    expect([...SCENARIO_DIMENSIONS]).toEqual([
      'demandProfile',
      'routeChoice',
      'waitCap',
      'referenceTemperatureC',
      'ridershipQuarter',
    ])
  })

  it('reports low, high and a spread ratio over the whole cross product', () => {
    const table = tableFor()
    const envelope = scenarioEnvelope(table, enumerateScenarios())
    expect(envelope.scenariosEvaluated).toBe(324)
    expect(envelope.low!).toBeLessThanOrEqual(envelope.high!)
    expect(envelope.spreadRatio!).toBeGreaterThan(1)
    // The base value must lie inside its own envelope.
    const base = exposureForScenario(table, BASE_SCENARIO)!
    expect(base).toBeGreaterThanOrEqual(envelope.low!)
    expect(base).toBeLessThanOrEqual(envelope.high!)
  })

  it('models temporal drift with sourced quarters, not an invented multiplier', () => {
    expect([...DRIFT_QUARTERS]).toEqual(['2024_4', '2024_3', '2024_2'])
    const table = tableFor()
    const values = DRIFT_QUARTERS.map((ridershipQuarter) =>
      exposureForScenario(table, { ...BASE_SCENARIO, ridershipQuarter })!,
    )
    // The fixture publishes 100 / 120 / 90 riders across the three quarters, so
    // the drift dimension genuinely moves the value.
    expect(values[1]!).toBeGreaterThan(values[0]!)
    expect(values[2]!).toBeLessThan(values[0]!)
  })
})

/* ========================================================================== */
/* Core arithmetic and missing-data behaviour                                 */
/* ========================================================================== */

describe('exposure arithmetic', () => {
  it('is riders × wait × excess, summed over the analysed hours', () => {
    const table = tableFor()
    const result = computeStopExposure(table, BASE_SCENARIO)
    let expected = 0
    for (const hour of result.hourly) {
      expect(hour.waitMinutes).toBeCloseTo(5, 3) // even 10-minute service
      expected += hour.riders * (hour.waitMinutes ?? 0) * (hour.excessC ?? 0)
    }
    // The displayed decomposition is rounded for presentation, so it
    // reconstructs the total to within a rounding error rather than exactly.
    expect(Math.abs(result.exposure! - expected) / expected).toBeLessThan(0.001)
    expect(result.hourly.map((hour) => hour.excessC)).toEqual([8, 14, 11])
  })

  it('scales linearly with ridership', () => {
    const base = computeStopExposure(tableFor(), BASE_SCENARIO).exposure!
    const doubled = computeStopExposure(
      tableFor(
        stop({
          ridership: {
            baseQuarter: '2024_4',
            byQuarter: {
              '2024_4': { weekday: 200, weekend: 80 },
              '2024_3': { weekday: 200, weekend: 80 },
              '2024_2': { weekday: 200, weekend: 80 },
            },
          },
        }),
      ),
      BASE_SCENARIO,
    ).exposure!
    expect(doubled).toBeCloseTo(base * 2, 2)
  })

  it('never produces a negative excess', () => {
    const cool = new Map([
      [11, 20],
      [14, 25],
      [17, 28],
    ])
    const result = computeStopExposure(tableFor(stop(), cool), BASE_SCENARIO)
    expect(result.exposure).toBe(0)
    expect(result.hourly.every((hour) => (hour.excessC ?? 0) >= 0)).toBe(true)
  })

  it('reports missing inputs rather than substituting zero', () => {
    expect(tableFor(stop({ ridership: null })).missing).toContain('published ridership')
    // The day type is named: a stop with no SATURDAY service is a different
    // fact from a stop with no service at all, and the message says which.
    expect(tableFor(stop({ service: null })).missing).toContain('scheduled weekday service')
    expect(tableFor(stop(), new Map()).missing).toContain('heat signal')
    expect(computeStopExposure(tableFor(stop({ ridership: null })), BASE_SCENARIO).exposure)
      .toBeNull()
  })

  it('is deterministic', () => {
    const a = computeStopExposure(tableFor(), BASE_SCENARIO)
    const b = computeStopExposure(tableFor(), BASE_SCENARIO)
    expect(b).toEqual(a)
  })
})
