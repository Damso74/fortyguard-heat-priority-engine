import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  checkpointPath,
  readCheckpoint,
  runCapture,
  writeCheckpoint,
  type CaptureSpec,
} from '@/lib/fortyguard/capture'
import { FortyGuardClient, assertAttestedBaseUrl } from '@/lib/fortyguard/client'
import { buildThermalSnapshot, validateThermalSnapshot } from '@/lib/fortyguard/snapshot'
import { capabilityFingerprint } from '@/lib/fortyguard/capability'
import { getAoi } from '@/lib/geo/aoi'
import { planTiles } from '@/lib/geo/tiles'
import type { ThermalCell } from '@/lib/types'

/**
 * Third-round audit findings, each with the path that defeated the guarantee.
 *
 * Every one of these passed the previous suite. They are grouped here rather than
 * scattered so the pattern is visible: in each case a check existed and something
 * downstream disagreed with it about what a value meant.
 */

const AOI = getAoi('central-phoenix')
const SPEC: CaptureSpec = {
  aoiId: AOI.id,
  analysisDate: '2026-08-03',
  snapshotTimes: ['14:00'],
  analyticType: 'tcm',
  granularityMeters: 60,
  filterType: 1,
  timezone: 'America/Phoenix',
  maxTileSqMi: 9,
}
const TILE_COUNT = planTiles(AOI, SPEC.maxTileSqMi).tiles.length

async function inTemporaryTree(body: () => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'hpe-audit3-'))
  const previous = process.cwd()
  try {
    process.chdir(directory)
    await body()
  } finally {
    process.chdir(previous)
    rmSync(directory, { recursive: true, force: true })
  }
}

/** Counts POSTs the way the API bills them. */
function countingClient() {
  let submissions = 0
  const stub = {
    get submissions() {
      return submissions
    },
    async runHeatmap(
      _request: unknown,
      options: { resumeActivityId?: string; onSubmitIntent?: () => void; onActivityId?: (id: string) => void } = {},
    ) {
      if (!options.resumeActivityId) {
        options.onSubmitIntent?.()
        submissions += 1
        options.onActivityId?.(`activity-${submissions}-0a1b2c3d4e5f`)
      }
      return {
        activityId: options.resumeActivityId ?? `activity-${submissions}-0a1b2c3d4e5f`,
        collection: {
          type: 'FeatureCollection' as const,
          features: Array.from({ length: 12 }, (_u, index) => ({
            type: 'Feature' as const,
            properties: { average_temperature: 40 + index * 0.4 },
            geometry: {
              type: 'Polygon' as const,
              coordinates: [
                [
                  [-112.1 + index * 0.002, 33.45],
                  [-112.099 + index * 0.002, 33.45],
                  [-112.099 + index * 0.002, 33.451],
                  [-112.1 + index * 0.002, 33.451],
                  [-112.1 + index * 0.002, 33.45],
                ],
              ],
            },
          })),
        },
        rawStatus: {},
        contract: {
          submitStatus: 200,
          submitEnvelope: 'data.activity_id' as const,
          statusEnvelopePath: 'data.result.map_data',
          statusWord: 'Completed',
          pollAttempts: 1,
          elapsedMs: 1,
          resultFetchedFromUrl: null,
          featureCount: 12,
          notes: [],
        },
        fromCache: false,
        cacheKey: 'k',
      }
    },
  }
  return stub as unknown as FortyGuardClient & { submissions: number }
}

/* ========================================================================== */
/* P0 — a blank activity id bought submissions outside the budget             */
/* ========================================================================== */

describe('an activity id is a real id or it is null', () => {
  it('refuses a blank id rather than letting the budget and the client disagree', async () => {
    /*
     * The bypass: `unit.activityId !== null` read `''` as "already paid for", so
     * the unit was excluded from the budget — while the client's `if (activityId)`
     * read the same value as falsy and submitted. N blanked units therefore made
     * N submissions under a budget of 1.
     */
    await inTemporaryTree(async () => {
      const first = countingClient()
      await runCapture({ aoi: AOI, spec: SPEC, client: first, maxNewSubmissions: TILE_COUNT })

      const blanked = readCheckpoint(SPEC)!
      for (const unit of blanked.units) unit.activityId = ''
      writeCheckpoint(blanked, SPEC)

      const second = countingClient()
      await expect(
        runCapture({ aoi: AOI, spec: SPEC, client: second, maxNewSubmissions: 1 }),
      ).rejects.toThrow(/neither null nor a plausible id/)
      // The whole point: not one submission was made under the budget of 1.
      expect(second.submissions).toBe(0)
    })
  })

  it('refuses a blank resumeActivityId at the client, too', async () => {
    const fetchImpl = vi.fn()
    const client = new FortyGuardClient({
      apiKey: 'your_key_placeholder_never_sent',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await expect(
      client.runHeatmap(
        {
          polygon_aoi: {
            type: 'FeatureCollection',
            features: [
              {
                type: 'Feature',
                properties: {},
                geometry: {
                  type: 'Polygon',
                  coordinates: [
                    [
                      [-112.1, 33.45],
                      [-112.0, 33.45],
                      [-112.0, 33.5],
                      [-112.1, 33.5],
                      [-112.1, 33.45],
                    ],
                  ],
                },
              },
            ],
          },
          date_time: { start_date: '2026-08-03', start_time: '14:00', filter_type: 1 },
          granularity: 60,
          analytic_type: 'tcm',
        },
        { resumeActivityId: '   ' },
      ),
    ).rejects.toThrow(/the two differ by the price/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('refuses a unit key that does not name its own tile and hour', async () => {
    await inTemporaryTree(async () => {
      const client = countingClient()
      await runCapture({ aoi: AOI, spec: SPEC, client, maxNewSubmissions: TILE_COUNT })
      const tampered = readCheckpoint(SPEC)!
      tampered.units[0]!.key = 'some-other-tile@09:00'
      writeCheckpoint(tampered, SPEC)
      await expect(
        runCapture({ aoi: AOI, spec: SPEC, client: countingClient(), maxNewSubmissions: TILE_COUNT }),
      ).rejects.toThrow(/must name the tile and hour it bought/)
    })
  })
})

/* ========================================================================== */
/* P0 — the checkpoint's own spec was trusted                                 */
/* ========================================================================== */

describe('a checkpoint cannot redirect where the intent journal is written', () => {
  it('refuses an embedded spec that differs from the request', async () => {
    /*
     * `writeCheckpoint` derived its path from `checkpoint.spec`, which came from
     * disk. An edited spec sent this run's pre-POST intent into a different file
     * — so the record whose whole job is to make a spent credit visible landed
     * where nobody looks, and the original checkpoint stayed resumable.
     */
    await inTemporaryTree(async () => {
      const client = countingClient()
      await runCapture({ aoi: AOI, spec: SPEC, client, maxNewSubmissions: TILE_COUNT })

      const redirected = readCheckpoint(SPEC)!
      redirected.spec = { ...redirected.spec, analysisDate: '2026-09-09' }
      writeCheckpoint(redirected, SPEC)

      await expect(
        runCapture({ aoi: AOI, spec: SPEC, client: countingClient(), maxNewSubmissions: TILE_COUNT }),
      ).rejects.toThrow(/embeds a spec that differs/)
    })
  })

  it('writes to the path derived from the caller’s spec, not the file’s', async () => {
    await inTemporaryTree(async () => {
      const client = countingClient()
      await runCapture({ aoi: AOI, spec: SPEC, client, maxNewSubmissions: TILE_COUNT })

      const checkpoint = readCheckpoint(SPEC)!
      const elsewhere = { ...SPEC, aoiId: 'somewhere-else' }
      checkpoint.spec = elsewhere
      writeCheckpoint(checkpoint, SPEC)

      // The write landed where THIS request's checkpoint belongs, and nothing
      // was created at the path the tampered spec names. Reading it back is
      // separately refused — that is the previous test — so the filesystem is
      // what this one asserts on.
      expect(existsSync(checkpointPath(SPEC))).toBe(true)
      expect(existsSync(checkpointPath(elsewhere))).toBe(false)
    })
  })
})

/* ========================================================================== */
/* P0 — the validator trusted types the later checks coerced                  */
/* ========================================================================== */

describe('a snapshot cannot smuggle a value through a coercion', () => {
  const cells: ThermalCell[] = Array.from({ length: 10 }, (_u, index) => {
    const lon = -112.07 + index * 0.002
    const lat = 33.45 + index * 0.002
    return {
      id: `c${index}`,
      centroidLon: lon,
      centroidLat: lat,
      ring: [
        [lon - 0.001, lat - 0.001],
        [lon + 0.001, lat - 0.001],
        [lon + 0.001, lat + 0.001],
        [lon - 0.001, lat + 0.001],
      ] as Array<[number, number]>,
      value: 41 + index * 0.3,
      snapshot: '2026-08-03T14:00',
    }
  })

  const request = {
    aoiId: 'central-phoenix',
    analysisDate: '2026-08-03',
    snapshotTimes: ['14:00'],
    analyticType: 'tcm',
    granularityMeters: 60,
    filterType: 1,
    timezone: 'America/Phoenix',
  }

  const sourceWith = (overrides: Record<string, unknown>) =>
    ({
      dataMode: 'LIVE_FORTYGUARD',
      provenance: 'REAL',
      activityIds: ['9f3c1a77-2b40-4d8e-9c11-6a0f5d2e8b31'],
      valueField: 'tcm',
      unit: null,
      unitConfirmed: false,
      semanticsConfirmed: false,
      timezoneStrategy: 'send_local_wallclock_unconverted',
      timezoneStrategyApplied: true,
      capabilityProbeRunId: null,
      capabilityFingerprint: capabilityFingerprint(),
      capture: {
        capturedAtUtc: '2026-08-03T20:00:00.000Z',
        captureToolVersion: 'test',
        tileCount: 1,
        submissionCount: 1,
        timestamps: [
          {
            requestedLocalDate: '2026-08-03',
            requestedLocalTime: '14:00',
            requestedLocalIso: '2026-08-03T14:00:00-07:00',
            transmittedDate: '2026-08-03',
            transmittedTime: '14:00',
            transmittedIsoUtc: '2026-08-03T21:00:00.000Z',
          },
        ],
      },
      notes: [],
      ...overrides,
    }) as never

  it('rejects a numeric activity id, which the placeholder checks let through', () => {
    // `RE.test(12345678)` is false and `(12345678).length < 8` is false, so both
    // guards passed a value that is not an id at all. Digests cannot catch this:
    // they are computed from the file.
    const forged = buildThermalSnapshot({
      request,
      source: sourceWith({ activityIds: [12345678] }),
      cells,
    })
    expect(() => validateThermalSnapshot(forged)).toThrow(/activityIds must be an array of strings/)
  })

  it('rejects a string where a confirmation boolean belongs', () => {
    // `"false"` is a non-empty string and therefore truthy, so a file asserting
    // the opposite of what it said passed every check that read the flag.
    for (const flag of ['unitConfirmed', 'semanticsConfirmed', 'timezoneStrategyApplied']) {
      const forged = buildThermalSnapshot({ request, source: sourceWith({ [flag]: 'false' }), cells })
      expect(() => validateThermalSnapshot(forged), flag).toThrow(
        new RegExp(`${flag} must be a boolean`),
      )
    }
  })
})

/* ========================================================================== */
/* High — the key must not follow a redirect off-origin                       */
/* ========================================================================== */

describe('the API key goes to the API and nowhere else', () => {
  it('drops the auth header when a poll redirect leaves the origin', async () => {
    const seen: Array<{ url: string; auth: string | undefined }> = []
    const replies = [
      { status: 200, body: { data: { activity_id: 'abc-123-def' } } },
      { status: 302, body: {}, location: 'https://cdn.fortyguard.com/status/abc' },
      {
        status: 200,
        body: {
          data: {
            activity_id: 'abc-123-def',
            status: 'Completed',
            result: {
              map_data: {
                type: 'FeatureCollection',
                features: [
                  {
                    type: 'Feature',
                    properties: { average_temperature: 41 },
                    geometry: {
                      type: 'Polygon',
                      coordinates: [
                        [
                          [-112.1, 33.45],
                          [-112.099, 33.45],
                          [-112.099, 33.451],
                          [-112.1, 33.451],
                          [-112.1, 33.45],
                        ],
                      ],
                    },
                  },
                ],
              },
            },
          },
        },
      },
    ]
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      seen.push({ url: String(url), auth: headers['api-key'] })
      const reply = replies.shift()!
      return new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: {
          'Content-Type': 'application/json',
          ...(reply.location ? { location: reply.location } : {}),
        },
      })
    })

    const client = new FortyGuardClient({
      apiKey: 'your_key_placeholder_never_sent',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      resultHostAllowlist: ['fortyguard.com'],
      now: () => 0,
      sleep: async () => {},
    })
    await client.runHeatmap({
      polygon_aoi: {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: {},
            geometry: {
              type: 'Polygon',
              coordinates: [
                [
                  [-112.1, 33.45],
                  [-112.0, 33.45],
                  [-112.0, 33.5],
                  [-112.1, 33.5],
                  [-112.1, 33.45],
                ],
              ],
            },
          },
        ],
      },
      date_time: { start_date: '2026-08-03', start_time: '14:00', filter_type: 1 },
      granularity: 60,
      analytic_type: 'tcm',
    })

    const offOrigin = seen.filter((call) => call.url.includes('cdn.fortyguard.com'))
    expect(offOrigin.length).toBeGreaterThan(0)
    // The allowlist exists so a RESULT can come from a CDN, which needs no
    // credential. Re-sending the header on every hop handed the key to every
    // allowlisted host.
    for (const call of offOrigin) expect(call.auth).toBeUndefined()
    // …and the API origin still gets it.
    expect(seen.filter((call) => call.url.includes('api.fortyguard.com'))[0]!.auth).toBeDefined()
  })

  it('binds the whole origin, not only the hostname', () => {
    expect(() =>
      assertAttestedBaseUrl('https://api.fortyguard.com:8443', 'api.fortyguard.com'),
    ).toThrow(/a different port is a different service/)
    expect(() =>
      assertAttestedBaseUrl('https://api.fortyguard.com/proxy/elsewhere', 'api.fortyguard.com'),
    ).toThrow(/path prefix/)
    expect(() => assertAttestedBaseUrl('https://api.fortyguard.com/', 'api.fortyguard.com')).not.toThrow()
  })
})
