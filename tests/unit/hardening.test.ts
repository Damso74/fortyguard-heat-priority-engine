import { describe, expect, it } from 'vitest'
import type { TransitStop } from '@/lib/types'
import { RIDERSHIP_CATEGORY_FOR_DAY_TYPE } from '@/lib/types'
import { RunRequestSchema } from '@/lib/agent/request'
import {
  BASE_SCENARIO,
  buildStopScenarioTable,
  clockTimetableFor,
  enumerateScenarios,
  exposureForScenario,
  projectServiceDayToClock,
  scenarioAvailable,
  scenarioEnvelope,
  scenariosAvailableFor,
} from '@/lib/metrics/exposure'
import { paretoFronts, selectUnderCapacity } from '@/lib/metrics/selection'
import { computeSnapshotAnomalies, validateAnomalies, type CellAnomaly } from '@/lib/metrics/anomaly'

/**
 * The hardening pass: one block per defect, each asserting the behaviour that
 * replaced it rather than merely that the code runs.
 */

const every = (from: number, to: number, step: number): number[] => {
  const out: number[] = []
  for (let minute = from; minute <= to; minute += step) out.push(minute)
  return out
}

function stopWith(overrides: Partial<TransitStop> = {}): TransitStop {
  const weekday = every(6 * 60, 20 * 60, 10)
  const saturday = every(8 * 60, 18 * 60, 30)
  const hourly = (minutes: number[]) => {
    const out = new Array(24).fill(0)
    for (const minute of minutes) out[Math.floor((minute % 1440) / 60)] += 1
    return out
  }
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
          dailyDepartures: weekday.length,
          routeCount: 1,
          hourlyDepartures: hourly(weekday),
          routeDepartures: { '1': weekday },
          departuresAfterMidnight: 0,
        },
        saturday: {
          dailyDepartures: saturday.length,
          routeCount: 1,
          hourlyDepartures: hourly(saturday),
          routeDepartures: { '1': saturday },
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

/* ========================================================================== */
/* 1 — weekend ridership never meets a weekday timetable                      */
/* ========================================================================== */

describe('day types are analysed with their own timetable', () => {
  it('draws the weekend ridership column for Saturday and Sunday, weekday for weekday', () => {
    expect(RIDERSHIP_CATEGORY_FOR_DAY_TYPE).toEqual({
      weekday: 'weekday',
      saturday: 'weekend',
      sunday: 'weekend',
    })
  })

  it('uses the Saturday timetable for a Saturday run, not the weekday one', () => {
    const stop = stopWith()
    const weekday = clockTimetableFor(stop, 'weekday')!
    const saturday = clockTimetableFor(stop, 'saturday')!
    // Genuinely different service, which is the whole point.
    expect(saturday['1']!.length).toBeLessThan(weekday['1']!.length)

    const satTable = buildStopScenarioTable({
      stop,
      temperatureByHour: TEMPS,
      hours: HOURS,
      dayType: 'saturday',
    })
    // A 30-minute Saturday headway must produce a longer wait than a 10-minute
    // weekday one; if the weekday timetable leaked in, these would be equal.
    const wdTable = buildStopScenarioTable({
      stop,
      temperatureByHour: TEMPS,
      hours: HOURS,
      dayType: 'weekday',
    })
    const satWait = satTable.waitByModel.get('union_timetable|uncapped')![0]!
    const wdWait = wdTable.waitByModel.get('union_timetable|uncapped')![0]!
    expect(satWait).toBeGreaterThan(wdWait)
  })

  it('reports no service for a day type the stop does not run', () => {
    const table = buildStopScenarioTable({
      stop: stopWith(),
      temperatureByHour: TEMPS,
      hours: HOURS,
      dayType: 'sunday',
    })
    expect(table.hasService).toBe(false)
    expect(table.missing).toContain('scheduled sunday service')
    expect(exposureForScenario(table, BASE_SCENARIO)).toBeNull()
  })
})

/* ========================================================================== */
/* 2 — missing ridership stays null; the denominator is what was evaluated    */
/* ========================================================================== */

describe('unavailable scenarios are excluded, not scored as zero', () => {
  const partial = stopWith({
    ridership: {
      baseQuarter: '2024_4',
      byQuarter: {
        '2024_4': { weekday: 100, weekend: 40 },
        // Published for the base quarter only.
        '2024_3': { weekday: null, weekend: null },
        '2024_2': { weekday: null, weekend: null },
      },
    },
  })

  it('marks a quarter with no published figure unavailable rather than zero', () => {
    const table = buildStopScenarioTable({
      stop: partial,
      temperatureByHour: TEMPS,
      hours: HOURS,
      dayType: 'weekday',
    })
    expect(table.quartersUnavailable.sort()).toEqual(['2024_2', '2024_3'])

    // Zero exposure and no exposure are different facts.
    expect(exposureForScenario(table, { ...BASE_SCENARIO, ridershipQuarter: '2024_3' })).toBeNull()
    expect(scenarioAvailable(table, { ...BASE_SCENARIO, ridershipQuarter: '2024_3' })).toBe(false)
    expect(scenarioAvailable(table, BASE_SCENARIO)).toBe(true)
  })

  it('reports the evaluated denominator, not the offered one', () => {
    const scenarios = enumerateScenarios()
    const table = buildStopScenarioTable({
      stop: partial,
      temperatureByHour: TEMPS,
      hours: HOURS,
      dayType: 'weekday',
    })
    // One of three quarters survives, so exactly a third of the grid is evaluable.
    const available = scenariosAvailableFor(table, scenarios)
    expect(available).toBe(scenarios.length / 3)

    const envelope = scenarioEnvelope(table, scenarios)
    expect(envelope.scenariosEvaluated).toBe(available)
    expect(envelope.scenariosOffered).toBe(scenarios.length)
    expect(envelope.scenariosUnavailable).toBe(scenarios.length - available)
  })
})

/* ========================================================================== */
/* 3 — partial thermal coverage yields no load at all                         */
/* ========================================================================== */

describe('thermal coverage must be complete for the analysed hours', () => {
  const twoOfThree = new Map([
    [11, 38],
    [14, 44],
  ])

  it('refuses to sum over whichever hours happened to arrive', () => {
    const table = buildStopScenarioTable({
      stop: stopWith(),
      temperatureByHour: twoOfThree,
      hours: HOURS,
      dayType: 'weekday',
    })
    expect(table.hasTemperature).toBe(true)
    expect(table.thermalCoverageComplete).toBe(false)
    expect(table.hoursWithTemperature).toBe(2)
    expect(table.missing.join(' ')).toMatch(/heat signal for 1 of 3 analysed hours/)
    // A partial sum would be smaller for a reason indistinguishable from a
    // genuinely cooler stop, so there is no number at all.
    expect(exposureForScenario(table, BASE_SCENARIO)).toBeNull()
    expect(scenarioAvailable(table, BASE_SCENARIO)).toBe(false)
  })

  it('accepts a stop covered for every analysed hour', () => {
    const table = buildStopScenarioTable({
      stop: stopWith(),
      temperatureByHour: TEMPS,
      hours: HOURS,
      dayType: 'weekday',
    })
    expect(table.thermalCoverageComplete).toBe(true)
    expect(exposureForScenario(table, BASE_SCENARIO)).not.toBeNull()
  })
})

/* ========================================================================== */
/* 4 — snapshot times: distinct whole hours                                   */
/* ========================================================================== */

describe('snapshot times are validated as distinct whole hours', () => {
  const parse = (snapshotTimes: string[]) =>
    RunRequestSchema.safeParse({ aoiId: 'central-phoenix', snapshotTimes })

  it('accepts distinct whole hours', () => {
    expect(parse(['08:00', '14:00', '20:00']).success).toBe(true)
  })

  it('rejects a minute value rather than silently truncating it', () => {
    const result = parse(['14:30'])
    expect(result.success).toBe(false)
    expect(JSON.stringify(result)).toMatch(/whole hours/)
  })

  it('rejects two snapshots in the same hour rather than paying for one twice', () => {
    const result = parse(['14:00', '14:00'])
    expect(result.success).toBe(false)
    expect(JSON.stringify(result)).toMatch(/distinct hours/)
  })

  it('still rejects a malformed time', () => {
    expect(parse(['25:00']).success).toBe(false)
    expect(parse(['noon']).success).toBe(false)
  })
})

/* ========================================================================== */
/* 5 — pins are deduplicated and never analytically robust                    */
/* ========================================================================== */

describe('analyst pins', () => {
  const candidates = Array.from({ length: 8 }, (_, index) => ({
    id: `s${index}`,
    lat: 33.4 + index * 0.02,
    lon: -112.1 + index * 0.02,
    exposure: 100 - index * 10,
    anomalyZ: index * 0.1,
  }))

  it('consumes one slot per pinned location, not one per mention', () => {
    const result = selectUnderCapacity(candidates, {
      capacity: 3,
      includedIds: ['s7', 's7', 's7'],
    })
    expect(result.pinnedIds).toEqual(['s7'])
    expect(result.selectedIds.filter((id) => id === 's7')).toHaveLength(1)
    expect(new Set(result.selectedIds).size).toBe(result.selectedIds.length)
    expect(result.notes.join(' ')).toMatch(/duplicate pin/i)
  })

  it('keeps pinned ids separate from the ranking', () => {
    const result = selectUnderCapacity(candidates, { capacity: 3, includedIds: ['s7'] })
    expect(result.pinnedIds).toEqual(['s7'])
    const entry = result.entries.find((e) => e.candidateId === 's7')!
    expect(entry.reasonCode).toBe('MANUAL_INCLUDE')
    expect(entry.reason).toMatch(/instruction, not a finding/)
  })

  it('excludes a pin from an exclusion', () => {
    const result = selectUnderCapacity(candidates, {
      capacity: 3,
      includedIds: ['s7'],
      excludedIds: ['s7'],
    })
    expect(result.pinnedIds).toEqual([])
  })
})

/* ========================================================================== */
/* 6a — Pareto ties share a front                                             */
/* ========================================================================== */

describe('Pareto layering handles ties', () => {
  it('puts identical points on the same front', () => {
    const fronts = paretoFronts([
      { id: 'a', a: 5, b: 5 },
      { id: 'b', a: 5, b: 5 },
      { id: 'c', a: 5, b: 5 },
    ])
    // Neither dominates the other, so all three are front 1.
    expect(fronts[0]!.sort()).toEqual(['a', 'b', 'c'])
    expect(fronts).toHaveLength(1)
  })

  it('does not demote a point that merely equals another on one axis', () => {
    const fronts = paretoFronts([
      { id: 'high-a', a: 9, b: 1 },
      { id: 'tie-b', a: 5, b: 5 },
      { id: 'tie-b2', a: 4, b: 5 },
      { id: 'high-b', a: 1, b: 9 },
    ])
    // `tie-b2` is dominated by `tie-b` (worse a, equal b) so it drops; the rest
    // are mutually non-dominated.
    expect(fronts[0]!.sort()).toEqual(['high-a', 'high-b', 'tie-b'])
    expect(fronts[1]).toEqual(['tie-b2'])
  })

  it('never loses a candidate across the fronts', () => {
    const points = Array.from({ length: 40 }, (_, index) => ({
      id: `p${index}`,
      a: index % 5,
      b: index % 7,
    }))
    const fronts = paretoFronts(points)
    expect(fronts.flat().sort()).toEqual(points.map((p) => p.id).sort())
    expect(new Set(fronts.flat()).size).toBe(points.length)
  })
})

/* ========================================================================== */
/* 6b — retention matches cells, not z values                                 */
/* ========================================================================== */

describe('top-decile retention matches on cell identity', () => {
  /** Two snapshots over the same lattice, with a fixed hot patch. */
  const lattice = (snapshot: string, offset: number): CellAnomaly[] => {
    const cells = []
    for (let row = 0; row < 12; row += 1) {
      for (let col = 0; col < 12; col += 1) {
        const hot = row >= 5 && row <= 6 && col >= 5 && col <= 6
        cells.push({
          id: `${snapshot}:${row}:${col}`,
          centroidLon: -112.1 + col * 0.004,
          centroidLat: 33.4 + row * 0.004,
          ring: [] as Array<[number, number]>,
          value: 40 + (hot ? 4 : 0) + offset + ((row * 7 + col * 3) % 5) * 0.01,
          snapshot,
        })
      }
    }
    return computeSnapshotAnomalies(cells, { radiusMeters: 900, minNeighbours: 5 })
  }

  it('retains the same places across snapshots, not merely the same numbers', () => {
    const bySnapshot = new Map([
      ['2026-08-03T11:00', lattice('2026-08-03T11:00', 0)],
      ['2026-08-03T14:00', lattice('2026-08-03T14:00', 3)],
    ])
    const result = validateAnomalies(bySnapshot, 'synthetic_fixture')
    expect(result.comparedCells).toBeGreaterThan(20)
    // A fixed hot patch must be recovered; matching on identity is what makes
    // this meaningful on a lattice where many cells share a z.
    expect(result.topDecileRetention).toBeGreaterThan(0.5)
    expect(result.rankCorrelation).toBeGreaterThan(0.6)
  })

  it('is deterministic when many cells share the same z', () => {
    const flatish = (snapshot: string): CellAnomaly[] => {
      const cells = []
      for (let row = 0; row < 10; row += 1) {
        for (let col = 0; col < 10; col += 1) {
          cells.push({
            id: `${snapshot}:${row}:${col}`,
            centroidLon: -112.1 + col * 0.004,
            centroidLat: 33.4 + row * 0.004,
            ring: [] as Array<[number, number]>,
            // Deliberately repetitive: many identical z values.
            value: 40 + (col % 2),
            snapshot,
          })
        }
      }
      return computeSnapshotAnomalies(cells, { radiusMeters: 900, minNeighbours: 5 })
    }
    const build = () =>
      validateAnomalies(
        new Map([
          ['2026-08-03T11:00', flatish('2026-08-03T11:00')],
          ['2026-08-03T14:00', flatish('2026-08-03T14:00')],
        ]),
        'synthetic_fixture',
      )
    expect(build().topDecileRetention).toBe(build().topDecileRetention)
  })
})

/* ========================================================================== */
/* 7 — GTFS service-day semantics survive into the engine                     */
/* ========================================================================== */

describe('service-day times past 24:00', () => {
  it('separates the in-day part from the part that serves the next morning', () => {
    // 25:10 is 1510 in service-day minutes. It is 01:10 on the clock, but it is
    // the FOLLOWING calendar morning, so it belongs to the next day's timetable
    // rather than being wrapped onto this one.
    expect(projectServiceDayToClock([1510], 'inDay')).toEqual([])
    expect(projectServiceDayToClock([1510], 'afterMidnight')).toEqual([70])

    expect(projectServiceDayToClock([0, 1440], 'inDay')).toEqual([0])
    expect(projectServiceDayToClock([0, 1440], 'afterMidnight')).toEqual([0])

    expect(projectServiceDayToClock([1380, 1500, 60], 'inDay')).toEqual([60, 1380])
    expect(projectServiceDayToClock([1380, 1500, 60], 'afterMidnight')).toEqual([60])
  })

  it('carries a late-night departure into the following calendar morning', () => {
    // 23:50 today, then 00:10 tomorrow. The 00:10 trip serves the NEXT calendar
    // day, so it appears on that day's timetable, not on this one.
    const stop = stopWith({
      service: {
        byDayType: {
          weekday: {
            dailyDepartures: 2,
            routeCount: 1,
            hourlyDepartures: new Array(24).fill(0).map((_, h) => (h === 23 || h === 0 ? 1 : 0)),
            routeDepartures: { '1': [1430, 1450] },
            departuresAfterMidnight: 1,
          },
        },
      },
    })
    // This weekday keeps only its own in-day trip.
    expect(clockTimetableFor(stop, 'weekday')!['1']).toEqual([1430])
    // Saturday, whose preceding day is a weekday, inherits the 00:10 trip.
    expect(clockTimetableFor(stop, 'saturday')!['1']).toEqual([10])
  })

  it('preserves the raw service-day value in the dataset shape', () => {
    const stop = stopWith({
      service: {
        byDayType: {
          weekday: {
            dailyDepartures: 1,
            routeCount: 1,
            hourlyDepartures: new Array(24).fill(0),
            routeDepartures: { '1': [1510] },
            departuresAfterMidnight: 1,
          },
        },
      },
    })
    // Unwrapped in the record; projected only by the named assumption, and onto
    // the day it actually serves.
    expect(stop.service!.byDayType.weekday!.routeDepartures['1']).toEqual([1510])
    expect(clockTimetableFor(stop, 'weekday')).toBeNull()
    expect(clockTimetableFor(stop, 'saturday')!['1']).toEqual([70])
  })
})
