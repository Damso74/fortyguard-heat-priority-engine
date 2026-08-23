import { describe, expect, it } from 'vitest'
import type { TransitStop } from '@/lib/types'
import { RunRequestSchema, dayTypeForDate } from '@/lib/agent/request'
import { executeRun } from '@/lib/agent/run'
import {
  clockTimetableFor,
  precedingDayType,
  projectServiceDayToClock,
} from '@/lib/metrics/exposure'
import {
  MIN_HOLDOUT_SNAPSHOTS,
  attachAnomaliesToStops,
  computeSnapshotAnomalies,
  halfCellDiagonalMeters,
  pointInRing,
  validateAnomalies,
  type CellAnomaly,
} from '@/lib/metrics/anomaly'
import { resolveProductMode, selectProductMode } from '@/lib/gates/product-mode'
import { FortyGuardClient } from '@/lib/fortyguard/client'
import { FortyGuardError } from '@/lib/fortyguard/errors'

/**
 * Second hardening pass: calendar-versus-service-day semantics, cell matching,
 * holdout sufficiency and redirect handling.
 */

/* ========================================================================== */
/* Date versus day type                                                       */
/* ========================================================================== */

describe('analysisDate and the analysed day type', () => {
  it('derives the day type from the calendar date, in civil time', () => {
    // 2026-08-03 is a Monday, 2026-08-01 a Saturday, 2026-08-02 a Sunday.
    expect(dayTypeForDate('2026-08-03')).toBe('weekday')
    expect(dayTypeForDate('2026-08-01')).toBe('saturday')
    expect(dayTypeForDate('2026-08-02')).toBe('sunday')
  })

  it('is not shifted by the host timezone', () => {
    // `new Date('2026-08-02')` parses as UTC midnight, which is the previous
    // evening anywhere west of Greenwich — Phoenix included. Parsing the
    // components avoids that entirely.
    const previous = process.env.TZ
    try {
      process.env.TZ = 'America/Phoenix'
      expect(dayTypeForDate('2026-08-02')).toBe('sunday')
      process.env.TZ = 'Pacific/Kiritimati'
      expect(dayTypeForDate('2026-08-02')).toBe('sunday')
    } finally {
      process.env.TZ = previous
    }
  })

  it('defaults the request to the day the date actually falls on', () => {
    const saturday = RunRequestSchema.parse({ analysisDate: '2026-08-01' })
    expect(saturday.dayType).toBeUndefined()
    // The default is applied by the engine, which knows the date.
    expect(dayTypeForDate(saturday.analysisDate)).toBe('saturday')
  })

  it('labels a mismatched run as a counterfactual rather than describing that day', async () => {
    // A Monday date with the Saturday timetable: legitimate as a scenario,
    // misleading if reported as "Saturday".
    const run = await executeRun(
      {
        aoiId: 'central-phoenix',
        capacity: 5,
        analysisDate: '2026-08-03',
        dayType: 'saturday',
      },
      { now: () => new Date('2026-08-04T12:00:00Z') },
    )
    expect(run.dayTypeResolution.dateFallsOn).toBe('weekday')
    expect(run.dayTypeResolution.analysed).toBe('saturday')
    expect(run.dayTypeResolution.matchesDate).toBe(false)
    // Near the top of the list, above the routine caveats. The synthetic-layer
    // warning outranks it, which is the right order.
    const counterfactual = run.limitations.findIndex((line) => line.includes('COUNTERFACTUAL RUN'))
    expect(counterfactual).toBeGreaterThanOrEqual(0)
    expect(counterfactual).toBeLessThan(2)
    expect(run.limitations[counterfactual]).toMatch(
      /is a weekday, but the saturday timetable was analysed/,
    )
  }, 120_000)

  it('does not label a matching run as a counterfactual', async () => {
    const run = await executeRun(
      { aoiId: 'central-phoenix', capacity: 5, analysisDate: '2026-08-03' },
      { now: () => new Date('2026-08-04T12:00:00Z') },
    )
    expect(run.dayTypeResolution.matchesDate).toBe(true)
    expect(run.request.dayType).toBe('weekday')
    expect(run.limitations.join(' ')).not.toMatch(/COUNTERFACTUAL/)
  }, 120_000)
})

/* ========================================================================== */
/* Weekend midnight transitions                                               */
/* ========================================================================== */

describe('early clock hours come from the preceding service day', () => {
  it('names the day that actually runs the small hours', () => {
    // Saturday 01:00 is served by Friday night — a weekday.
    expect(precedingDayType('saturday')).toBe('weekday')
    // Sunday 01:00 is served by Saturday night.
    expect(precedingDayType('sunday')).toBe('saturday')
    // Monday 01:00 is served by Sunday night; the conservative choice for the
    // weekday bucket, which also covers Tue–Fri mornings served by a weekday.
    expect(precedingDayType('weekday')).toBe('sunday')
  })

  it('splits a service day into its in-day and after-midnight parts', () => {
    expect(projectServiceDayToClock([600, 1510], 'inDay')).toEqual([600])
    expect(projectServiceDayToClock([600, 1510], 'afterMidnight')).toEqual([70])
    // 24:00 exactly belongs to the following morning, not to hour 0 of this day.
    expect(projectServiceDayToClock([1440], 'inDay')).toEqual([])
    expect(projectServiceDayToClock([1440], 'afterMidnight')).toEqual([0])
  })

  it('builds Saturday morning from Friday night, not from Saturday night', () => {
    const stop: TransitStop = {
      id: 1,
      code: 1,
      name: 'Midnight Stop',
      description: '',
      lat: 33.45,
      lon: -112.07,
      routes: ['1'],
      ridership: null,
      service: {
        byDayType: {
          // Weekday runs late: 00:40 and 01:10 the following morning.
          weekday: {
            dailyDepartures: 3,
            routeCount: 1,
            hourlyDepartures: new Array(24).fill(0),
            routeDepartures: { '1': [1380, 1480, 1510] },
            departuresAfterMidnight: 2,
          },
          // Saturday itself stops at 23:00 and runs nothing after midnight.
          saturday: {
            dailyDepartures: 1,
            routeCount: 1,
            hourlyDepartures: new Array(24).fill(0),
            routeDepartures: { '1': [1380] },
            departuresAfterMidnight: 0,
          },
        },
      },
      legacyRidershipIndex: null,
      matchMethod: 'stop_id',
      shelterStatus: 'unknown',
    }

    const saturday = clockTimetableFor(stop, 'saturday')!
    // 23:00 is Saturday's own; 00:40 and 01:10 are Friday night's, carried in.
    expect(saturday['1']).toEqual([40, 70, 1380])

    // The weekday timetable keeps its own in-day trips and inherits Sunday's
    // after-midnight ones — of which there are none here.
    const weekday = clockTimetableFor(stop, 'weekday')!
    expect(weekday['1']).toEqual([1380])
  })

  it('does not wrap a day type onto its own morning', () => {
    // The old behaviour: Saturday's 25:10 becoming Saturday 01:10. That is
    // Sunday morning's service, not Saturday's.
    const stop: TransitStop = {
      id: 2,
      code: 2,
      name: 'Late Saturday',
      description: '',
      lat: 33.45,
      lon: -112.07,
      routes: ['1'],
      ridership: null,
      service: {
        byDayType: {
          saturday: {
            dailyDepartures: 1,
            routeCount: 1,
            hourlyDepartures: new Array(24).fill(0),
            routeDepartures: { '1': [1510] },
            departuresAfterMidnight: 1,
          },
        },
      },
      legacyRidershipIndex: null,
      matchMethod: 'stop_id',
      shelterStatus: 'unknown',
    }
    // Saturday has no in-day departures and no preceding weekday entry here, so
    // it has no timetable at all — rather than a fabricated 01:10.
    expect(clockTimetableFor(stop, 'saturday')).toBeNull()
    // Sunday inherits it, which is where it belongs.
    expect(clockTimetableFor(stop, 'sunday')!['1']).toEqual([70])
  })
})

/* ========================================================================== */
/* Cell matching                                                              */
/* ========================================================================== */

describe('a stop is matched to the cell that contains it', () => {
  const square = (lon: number, lat: number, halfDeg: number): Array<[number, number]> => [
    [lon - halfDeg, lat - halfDeg],
    [lon + halfDeg, lat - halfDeg],
    [lon + halfDeg, lat + halfDeg],
    [lon - halfDeg, lat + halfDeg],
  ]

  it('computes the half diagonal from the ring rather than assuming one', () => {
    // ~60 m cell at this latitude: half diagonal ≈ 42 m, not 120.
    const ring = square(-112.07, 33.45, 0.00027)
    const half = halfCellDiagonalMeters(ring)!
    expect(half).toBeGreaterThan(35)
    expect(half).toBeLessThan(50)
    expect(half).toBeLessThan(120)
  })

  it('tests containment on the ring', () => {
    const ring = square(-112.07, 33.45, 0.001)
    expect(pointInRing({ lon: -112.07, lat: 33.45 }, ring)).toBe(true)
    expect(pointInRing({ lon: -112.0705, lat: 33.4505 }, ring)).toBe(true)
    expect(pointInRing({ lon: -112.05, lat: 33.45 }, ring)).toBe(false)
  })

  it('prefers the containing cell, and refuses a stop beyond the half diagonal', () => {
    const cells = [
      {
        id: 'a',
        centroidLon: -112.07,
        centroidLat: 33.45,
        ring: square(-112.07, 33.45, 0.00027),
        value: 40,
        snapshot: '2026-08-03T11:00',
      },
    ]
    const anomalies = computeSnapshotAnomalies(cells)
    const rings = new Map(cells.map((cell) => [cell.id, cell.ring]))
    const bySnapshot = new Map<string, CellAnomaly[]>([['2026-08-03T11:00', anomalies]])

    // Inside the polygon.
    const inside = attachAnomaliesToStops(
      [{ id: 1, lat: 33.45, lon: -112.07 }],
      bySnapshot,
      rings,
    )
    expect(inside.get(1)!.matchedBy).toBe('containment')
    expect(inside.get(1)!.bySnapshot[0]!.value).toBe(40)

    // ~100 m away: outside the polygon AND beyond its 42 m half diagonal. The
    // old 120 m tolerance would have matched this.
    const far = attachAnomaliesToStops(
      [{ id: 2, lat: 33.4509, lon: -112.07 }],
      bySnapshot,
      rings,
    )
    expect(far.get(2)!.matchedBy).toBe('none')
    expect(far.get(2)!.bySnapshot[0]!.value).toBeNull()
  })

  it('will not match at all when no ring is available to bound the distance', () => {
    const cells = [
      {
        id: 'a',
        centroidLon: -112.07,
        centroidLat: 33.45,
        ring: [] as Array<[number, number]>,
        value: 40,
        snapshot: '2026-08-03T11:00',
      },
    ]
    const bySnapshot = new Map<string, CellAnomaly[]>([
      ['2026-08-03T11:00', computeSnapshotAnomalies(cells)],
    ])
    // No geometry means no defensible tolerance, so no match.
    const attached = attachAnomaliesToStops([{ id: 1, lat: 33.45, lon: -112.07 }], bySnapshot)
    expect(attached.get(1)!.matchedBy).toBe('none')
  })
})

/* ========================================================================== */
/* Holdout sufficiency                                                        */
/* ========================================================================== */

describe('the anomaly axis needs enough holdouts to be claimed', () => {
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

  it('will not call a single holdout PERSISTENT, however well it scores', () => {
    const result = validateAnomalies(
      new Map([
        ['2026-08-03T11:00', lattice('2026-08-03T11:00', 0)],
        ['2026-08-03T14:00', lattice('2026-08-03T14:00', 3)],
      ]),
      'synthetic_fixture',
    )
    // The one holdout passes on its own merits…
    expect(result.perHoldout).toHaveLength(1)
    expect(result.perHoldout[0]!.verdict).toBe('PERSISTENT')
    // …but two readings agreeing once is what a slow-moving surface produces
    // whether or not the anomaly is real, so the AGGREGATE is capped at WEAK.
    // It used to read PERSISTENT with a quiet `sufficientHoldouts: false` beside
    // it, which put the strongest word the product owns on the weakest evidence
    // and relied on every downstream reader noticing the flag.
    expect(result.verdict).toBe('WEAK')
    expect(result.holdoutCount).toBe(1)
    expect(result.minimumHoldouts).toBe(MIN_HOLDOUT_SNAPSHOTS)
    expect(result.sufficientHoldouts).toBe(false)
  })

  it('accepts two holdouts', () => {
    const result = validateAnomalies(
      new Map([
        ['2026-08-03T11:00', lattice('2026-08-03T11:00', 0)],
        ['2026-08-03T14:00', lattice('2026-08-03T14:00', 3)],
        ['2026-08-03T17:00', lattice('2026-08-03T17:00', 1.5)],
      ]),
      'synthetic_fixture',
    )
    expect(result.holdoutCount).toBe(2)
    expect(result.sufficientHoldouts).toBe(true)
  })

  it('withholds the two-axis product when holdouts are insufficient', () => {
    const inputs = {
      baselinePass: true,
      shelterInventoryAvailable: false,
      ridershipDocumented: true,
      scheduleAvailable: true,
      exposureCoverage: 0.9,
      anomalyCoverage: 0.9,
      anomalyValidation: 'PERSISTENT',
      sufficientHoldouts: true,
      capabilityConfirmed: true,
      anomalyFieldConfirmed: true,
      liveSignalObtained: false,
      contractExercised: 'fixture' as const,
      dataMode: 'DEMO_SYNTHETIC' as const,
      thermalGate: { outcome: 'GO_THERMAL_SIGNAL' } as never,
      forcedMode: 'auto' as const,
    }
    expect(selectProductMode(inputs).mode).toBe('HEAT_EXPOSURE_AND_ANOMALY')

    const thin = resolveProductMode({ ...inputs, sufficientHoldouts: false })
    expect(thin.mode).toBe('EXPOSURE_ONLY')
    // The reason is a blocking reason, not prose folded into the rationale: it
    // names an axis that is unavailable, and the interface and export read it.
    expect(thin.blockingReasons.join(' ')).toMatch(/too few held-out snapshots/i)
    // And the exclusion is structural — the anomaly cannot reach the ranking.
    expect(thin.axes).toEqual({ exposure: true, anomaly: false })
  })

  it('withholds the exposure axis on a real capture with an unconfirmed capability', () => {
    const inputs = {
      baselinePass: true,
      shelterInventoryAvailable: false,
      ridershipDocumented: true,
      scheduleAvailable: true,
      exposureCoverage: 0.9,
      anomalyCoverage: 0.9,
      anomalyValidation: 'PERSISTENT',
      sufficientHoldouts: true,
      capabilityConfirmed: false,
      // The field IS identified here; only the unit and timezone are missing, so
      // the anomaly axis survives while exposure does not.
      anomalyFieldConfirmed: true,
      liveSignalObtained: true,
      contractExercised: 'live' as const,
      dataMode: 'CACHED_REAL_DATA' as const,
      thermalGate: { outcome: 'GO_THERMAL_SIGNAL' } as never,
      forcedMode: 'auto' as const,
    }
    const result = resolveProductMode(inputs)
    expect(result.mode).toBe('ANOMALY_ONLY')
    expect(result.blockingReasons.join(' ')).toMatch(/capability probe has not confirmed/)
    // Not merely a hidden unit label: the axis is gone from the selection.
    expect(result.axes).toEqual({ exposure: false, anomaly: true })
  })
})

/* ========================================================================== */
/* Redirects                                                                  */
/* ========================================================================== */

describe('result redirects are followed by hand and re-validated', () => {
  const clientWith = (fetchImpl: typeof fetch) =>
    new FortyGuardClient({
      apiKey: 'k'.repeat(32),
      resultHostAllowlist: ['api.fortyguard.com'],
      fetchImpl,
      sleep: async () => {},
      random: () => 0.5,
    })

  /** Minimal status payload that points at a result URL. */
  const statusWithResultUrl = (url: string) => ({
    status: 'completed',
    data: { result_url: url },
  })

  const collection = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { tcm: 41 },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [-112.071, 33.449],
              [-112.069, 33.449],
              [-112.069, 33.451],
              [-112.071, 33.451],
            ],
          ],
        },
      },
    ],
  }

  const request = {
    polygon_aoi: {
      type: 'FeatureCollection' as const,
      features: [
        {
          type: 'Feature' as const,
          properties: {},
          geometry: {
            type: 'Polygon' as const,
            coordinates: [
              [
                [-112.08, 33.44],
                [-112.06, 33.44],
                [-112.06, 33.46],
                [-112.08, 33.46],
                [-112.08, 33.44],
              ] as Array<[number, number]>,
            ],
          },
        },
      ],
    },
    date_time: { start_date: '2026-08-03', start_time: '11:00', filter_type: 1 as const },
    granularity: 60 as const,
    analytic_type: 'tcm' as const,
  }

  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

  it('follows an allowlisted redirect and returns the result', async () => {
    const seen: string[] = []
    const client = clientWith((async (input: RequestInfo | URL) => {
      const url = String(input)
      seen.push(url)
      if (url.endsWith('/v1/heatmap')) return json({ data: { activity_id: 'act-1' } })
      if (url.includes('/v1/status/')) {
        return json(statusWithResultUrl('https://api.fortyguard.com/results/a'))
      }
      if (url === 'https://api.fortyguard.com/results/a') {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://cdn.api.fortyguard.com/results/a' },
        })
      }
      return json(collection)
    }) as unknown as typeof fetch)

    const result = await client.runHeatmap(request)
    expect(result.collection.features).toHaveLength(1)
    // Every hop was requested explicitly rather than followed by fetch.
    expect(seen).toContain('https://cdn.api.fortyguard.com/results/a')
  })

  it('refuses a redirect that leaves the allowlist', async () => {
    const client = clientWith((async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/v1/heatmap')) return json({ data: { activity_id: 'act-1' } })
      if (url.includes('/v1/status/')) {
        return json(statusWithResultUrl('https://api.fortyguard.com/results/a'))
      }
      // An allowlisted host bouncing to somewhere else entirely. Default fetch
      // would have followed this and returned the body.
      return new Response(null, {
        status: 302,
        headers: { location: 'https://evil.example.com/exfiltrate' },
      })
    }) as unknown as typeof fetch)

    await expect(client.runHeatmap(request)).rejects.toThrow(FortyGuardError)
    await expect(client.runHeatmap(request, { bypassCache: true })).rejects.toThrow(
      /evil\.example\.com.*not on the allowlist/,
    )
  })

  it('refuses a redirect to a non-https scheme', async () => {
    const client = clientWith((async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/v1/heatmap')) return json({ data: { activity_id: 'act-1' } })
      if (url.includes('/v1/status/')) {
        return json(statusWithResultUrl('https://api.fortyguard.com/results/a'))
      }
      return new Response(null, {
        status: 302,
        headers: { location: 'http://api.fortyguard.com/results/a' },
      })
    }) as unknown as typeof fetch)

    await expect(client.runHeatmap(request)).rejects.toThrow(/https is required/)
  })

  it('stops after a bounded number of hops', async () => {
    let hop = 0
    const client = clientWith((async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/v1/heatmap')) return json({ data: { activity_id: 'act-1' } })
      if (url.includes('/v1/status/')) {
        return json(statusWithResultUrl('https://api.fortyguard.com/results/0'))
      }
      hop += 1
      return new Response(null, {
        status: 302,
        headers: { location: `https://api.fortyguard.com/results/${hop}` },
      })
    }) as unknown as typeof fetch)

    await expect(client.runHeatmap(request)).rejects.toThrow(/exceeded 3 redirects/)
  })
})
