import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  CaptureBudgetError,
  CaptureLockedError,
  CaptureReconciliationError,
  acquireCaptureLock,
  checkpointPath,
  planCapture,
  readCheckpoint,
  runCapture,
  writeCheckpoint,
  type CaptureCheckpoint,
  type CaptureSpec,
} from '@/lib/fortyguard/capture'
import { FortyGuardError } from '@/lib/fortyguard/errors'
import { FortyGuardClient } from '@/lib/fortyguard/client'
import { capabilityFingerprint } from '@/lib/fortyguard/capability'
import { applyTimezoneStrategy, localWallClockToUtcMs, zoneOffsetMinutes } from '@/lib/fortyguard/timezone'
import { getAoi } from '@/lib/geo/aoi'
import { planTiles } from '@/lib/geo/tiles'

/**
 * The credit guard, exercised.
 *
 * Every test here is about money. None of them touches the network: the client
 * is a stub, and the one real `FortyGuardClient` in the file is constructed with
 * no key so it refuses to build a request at all.
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

/** A FeatureCollection shaped like the real one, with enough cells to be valid. */
function mapData(count = 12, base = 40) {
  return {
    type: 'FeatureCollection' as const,
    features: Array.from({ length: count }, (_unused, index) => ({
      type: 'Feature' as const,
      properties: { average_temperature: base + index * 0.4 },
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
  }
}

/**
 * A stub standing in for the client.
 *
 * `submissions` counts POSTs the way the API would bill them: a call carrying a
 * `resumeActivityId` polls work already paid for and is not counted.
 */
/**
 * Ids must be unique across the whole capture, including across a resume.
 *
 * Each stub used to number from 1, so a run that resumed one paid unit and
 * submitted the rest produced two units sharing `activity-1-…`. The snapshot
 * rejects a repeated id — correctly, since two submissions cannot share one —
 * so the counter is global to the file rather than to the stub.
 */
let activityCounter = 0

function stubClient(
  behaviour: (call: number) => 'ok' | FortyGuardError = () => 'ok',
): FortyGuardClient & { submissions: number; resumes: number; calls: number } {
  const stub = {
    calls: 0,
    submissions: 0,
    resumes: 0,
    lastActivityId: '',
    async runHeatmap(
      _request: unknown,
      options: {
        resumeActivityId?: string
        onSubmitIntent?: () => void
        onActivityId?: (id: string) => void
      } = {},
    ) {
      stub.calls += 1
      if (options.resumeActivityId) {
        stub.resumes += 1
      } else {
        options.onSubmitIntent?.()
        stub.submissions += 1
        const outcome = behaviour(stub.submissions)
        if (outcome !== 'ok') throw outcome
        activityCounter += 1
        stub.lastActivityId = `activity-${activityCounter}-8f2c1b0a4d6e`
        options.onActivityId?.(stub.lastActivityId)
      }
      return {
        activityId: options.resumeActivityId ?? stub.lastActivityId,
        collection: mapData(),
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
  return stub as unknown as FortyGuardClient & {
    submissions: number
    resumes: number
    calls: number
  }
}

/**
 * Run a body inside a throwaway cwd.
 *
 * `await body()` rather than `return body()`: with the latter the `finally`
 * fires the moment the promise is *created*, so the working directory is
 * restored before a single `await` inside the body has run — and every
 * checkpoint the test thought it was writing to a temporary tree lands in the
 * repository instead.
 */
async function inTemporaryTree(body: () => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'hpe-capture-'))
  const previous = process.cwd()
  try {
    process.chdir(directory)
    await body()
  } finally {
    process.chdir(previous)
    rmSync(directory, { recursive: true, force: true })
  }
}

/* ========================================================================== */
/* Timezone: the strategy is executed, not merely declared                    */
/* ========================================================================== */

describe('the timezone strategy is applied and both timestamps are recorded', () => {
  it('knows the Phoenix offset from the IANA database, in both halves of the year', () => {
    // Arizona does not observe daylight saving, so unlike its neighbours the
    // offset must NOT move between January and July.
    expect(zoneOffsetMinutes('America/Phoenix', Date.UTC(2026, 0, 15))).toBe(-420)
    expect(zoneOffsetMinutes('America/Phoenix', Date.UTC(2026, 6, 15))).toBe(-420)
    // A neighbour that does, as a control: if this stopped moving, the lookup
    // would be a hardcoded constant wearing a timezone's name.
    expect(zoneOffsetMinutes('America/Denver', Date.UTC(2026, 0, 15))).toBe(-420)
    expect(zoneOffsetMinutes('America/Denver', Date.UTC(2026, 6, 15))).toBe(-360)
  })

  it('resolves a local wall clock to the right instant', () => {
    expect(localWallClockToUtcMs('America/Phoenix', '2026-08-03', '14:00')).toBe(
      Date.parse('2026-08-03T21:00:00Z'),
    )
  })

  it('transmits the wall clock verbatim under the unconverted strategy', () => {
    const plan = applyTimezoneStrategy({
      strategy: 'send_local_wallclock_unconverted',
      timezone: 'America/Phoenix',
      analysisDate: '2026-08-03',
      localTime: '19:00',
    })
    expect(plan.transmittedDate).toBe('2026-08-03')
    expect(plan.transmittedTime).toBe('19:00')
    expect(plan.crossesDayBoundary).toBe(false)
    // The instant is still recorded, so the two strategies stay comparable.
    expect(plan.transmittedIsoUtc).toBe('2026-08-04T02:00:00.000Z')
    expect(plan.requestedLocalIso).toBe('2026-08-03T19:00:00-07:00')
  })

  it('moves the civil DATE, not just the time, when converting across midnight', () => {
    // 19:00 on 3 August in Phoenix is 02:00 on 4 AUGUST in UTC. Converting the
    // time while keeping the date is a bug that only appears either side of
    // midnight — which is exactly where an evening heat snapshot sits.
    const evening = applyTimezoneStrategy({
      strategy: 'convert_to_utc',
      timezone: 'America/Phoenix',
      analysisDate: '2026-08-03',
      localTime: '19:00',
    })
    expect(evening.transmittedDate).toBe('2026-08-04')
    expect(evening.transmittedTime).toBe('02:00')
    expect(evening.crossesDayBoundary).toBe(true)

    // And the other edge: an early-morning local hour stays on the same UTC day.
    const morning = applyTimezoneStrategy({
      strategy: 'convert_to_utc',
      timezone: 'America/Phoenix',
      analysisDate: '2026-08-03',
      localTime: '04:00',
    })
    expect(morning.transmittedDate).toBe('2026-08-03')
    expect(morning.transmittedTime).toBe('11:00')
    expect(morning.crossesDayBoundary).toBe(false)

    // 17:00 local is exactly midnight UTC: the boundary case itself.
    const boundary = applyTimezoneStrategy({
      strategy: 'convert_to_utc',
      timezone: 'America/Phoenix',
      analysisDate: '2026-08-03',
      localTime: '17:00',
    })
    expect(boundary.transmittedDate).toBe('2026-08-04')
    expect(boundary.transmittedTime).toBe('00:00')
  })

  it('records the plan on the capture, so a claim can be checked against it', () => {
    const plan = planCapture(AOI, SPEC)
    expect(plan.timestamps).toHaveLength(1)
    expect(plan.timestamps[0]).toMatchObject({
      requestedLocalTime: '14:00',
      transmittedTime: '14:00',
      transmittedIsoUtc: '2026-08-03T21:00:00.000Z',
    })
  })
})

/* ========================================================================== */
/* Budget                                                                      */
/* ========================================================================== */

describe('no capture runs without an explicit, sufficient budget', () => {
  it('refuses a zero or absent budget', async () => {
    await inTemporaryTree(async () => {
      const client = stubClient()
      for (const budget of [0, -1, 1.5, Number.NaN]) {
        await expect(
          runCapture({ aoi: AOI, spec: SPEC, client, maxNewSubmissions: budget }),
        ).rejects.toThrow(CaptureBudgetError)
      }
      expect(client.submissions).toBe(0)
    })
  })

  it('refuses to start a plan larger than the budget, submitting nothing at all', async () => {
    await inTemporaryTree(async () => {
      const client = stubClient()
      await expect(
        runCapture({ aoi: AOI, spec: SPEC, client, maxNewSubmissions: TILE_COUNT - 1 }),
      ).rejects.toThrow(/Nothing was submitted/)
      // The point of checking up front: not one tile was bought before the
      // shortfall was noticed.
      expect(client.submissions).toBe(0)
    })
  })

  it('spends exactly the plan when the budget covers it', async () => {
    await inTemporaryTree(async () => {
      const client = stubClient()
      const result = await runCapture({
        aoi: AOI,
        spec: SPEC,
        client,
        maxNewSubmissions: TILE_COUNT,
      })
      expect(client.submissions).toBe(TILE_COUNT)
      expect(result.submittedUnits).toBe(TILE_COUNT)
      expect(result.resumedUnits).toBe(0)
      expect(result.cells).toBeGreaterThan(0)
    })
  })

  it('enforces the budget again on resume, so it cannot be spent twice', async () => {
    await inTemporaryTree(async () => {
      // A checkpoint in which exactly one unit was paid for.
      const client = stubClient()
      await expect(
        runCapture({ aoi: AOI, spec: SPEC, client, maxNewSubmissions: TILE_COUNT }),
      ).resolves.toBeTruthy()

      const checkpoint = readCheckpoint(SPEC)!
      // Strip the ids from every unit but the first: a partially-paid resume.
      for (const unit of checkpoint.units.slice(1)) {
        unit.activityId = null
        unit.intentRecordedAtUtc = null
        unit.submittedAtUtc = null
        unit.completedAtUtc = null
      }
      writeCheckpoint(checkpoint)

      const resumed = stubClient()
      await expect(
        runCapture({ aoi: AOI, spec: SPEC, client: resumed, maxNewSubmissions: 1 }),
      ).rejects.toThrow(CaptureBudgetError)
      expect(resumed.submissions).toBe(0)

      // With a budget that covers the remainder, the paid unit is polled rather
      // than bought again.
      const finishing = stubClient()
      const result = await runCapture({
        aoi: AOI,
        spec: SPEC,
        client: finishing,
        maxNewSubmissions: TILE_COUNT - 1,
      })
      expect(finishing.resumes).toBe(1)
      expect(finishing.submissions).toBe(TILE_COUNT - 1)
      expect(result.resumedUnits).toBe(1)
    })
  })
})

/* ========================================================================== */
/* Journal, ambiguity and reconciliation                                       */
/* ========================================================================== */

describe('an ambiguous submission stops the run and is never retried', () => {
  it('records the intent before the request and the id the moment it arrives', async () => {
    await inTemporaryTree(async () => {
      const client = stubClient()
      await runCapture({ aoi: AOI, spec: SPEC, client, maxNewSubmissions: TILE_COUNT })
      const checkpoint = readCheckpoint(SPEC)!
      expect(checkpoint.submissionsIntended).toBe(TILE_COUNT)
      for (const unit of checkpoint.units) {
        expect(unit.intentRecordedAtUtc).not.toBeNull()
        expect(unit.activityId).not.toBeNull()
      }
    })
  })

  it('stops on a dropped POST, leaves the intent on disk, and submits nothing more', async () => {
    await inTemporaryTree(async () => {
      const client = stubClient((call) =>
        call === 1
          ? new FortyGuardError('AMBIGUOUS_SUBMISSION', 'Network failure calling POST /v1/heatmap')
          : 'ok',
      )
      await expect(
        runCapture({ aoi: AOI, spec: SPEC, client, maxNewSubmissions: TILE_COUNT }),
      ).rejects.toThrow(CaptureReconciliationError)

      // Exactly one POST left the process. The remaining tiles were not bought.
      expect(client.submissions).toBe(1)

      const checkpoint = JSON.parse(
        readFileSync(checkpointPath(SPEC), 'utf-8'),
      ) as CaptureCheckpoint
      const stranded = checkpoint.units[0]!
      expect(stranded.intentRecordedAtUtc).not.toBeNull()
      expect(stranded.activityId).toBeNull()
      expect(stranded.unresolved?.kind).toBe('AMBIGUOUS_SUBMISSION')
    })
  })

  it('refuses to resume past an unresolved unit rather than resubmitting it', async () => {
    await inTemporaryTree(async () => {
      const first = stubClient((call) =>
        call === 1 ? new FortyGuardError('AMBIGUOUS_SUBMISSION', 'connection reset') : 'ok',
      )
      await expect(
        runCapture({ aoi: AOI, spec: SPEC, client: first, maxNewSubmissions: TILE_COUNT }),
      ).rejects.toThrow(CaptureReconciliationError)

      // The obvious wrong behaviour: a resume that "helpfully" retries the unit
      // whose outcome nobody knows, paying for it a second time.
      const second = stubClient()
      await expect(
        runCapture({ aoi: AOI, spec: SPEC, client: second, maxNewSubmissions: TILE_COUNT }),
      ).rejects.toThrow(/Reconcile against the account/)
      expect(second.submissions).toBe(0)
    })
  })

  it('treats a crash after the activity id arrived as work already paid for', async () => {
    await inTemporaryTree(async () => {
      // Simulate the crash: intent and id recorded, nothing polled.
      const client = stubClient()
      await runCapture({ aoi: AOI, spec: SPEC, client, maxNewSubmissions: TILE_COUNT })
      const checkpoint = readCheckpoint(SPEC)!
      for (const unit of checkpoint.units) {
        unit.completedAtUtc = null
        unit.cells = null
      }
      writeCheckpoint(checkpoint)

      const resumed = stubClient()
      const result = await runCapture({
        aoi: AOI,
        spec: SPEC,
        client: resumed,
        maxNewSubmissions: TILE_COUNT,
      })
      expect(resumed.submissions).toBe(0)
      expect(resumed.resumes).toBe(TILE_COUNT)
      expect(result.resumedUnits).toBe(TILE_COUNT)
    })
  })

  it('refuses a checkpoint whose unit set is not exactly tiles x hours', async () => {
    /*
     * `readCheckpoint` used to be a cast with one request-key check. Everything
     * downstream then treated the unit list as authoritative — which tiles to
     * buy, which are already paid for, how much budget is left — so a truncated,
     * duplicated or hand-edited file could buy the wrong units and then attest to
     * a plan that had never been submitted.
     */
    await inTemporaryTree(async () => {
      const client = stubClient()
      await runCapture({ aoi: AOI, spec: SPEC, client, maxNewSubmissions: TILE_COUNT })

      const truncated = readCheckpoint(SPEC)!
      truncated.units = truncated.units.slice(0, 1)
      writeCheckpoint(truncated)
      const afterTruncation = stubClient()
      await expect(
        runCapture({ aoi: AOI, spec: SPEC, client: afterTruncation, maxNewSubmissions: TILE_COUNT }),
      ).rejects.toThrow(/It was not written for this plan/)
      expect(afterTruncation.submissions).toBe(0)

      const duplicated = readCheckpoint(SPEC)!
      duplicated.units = [...duplicated.units, { ...duplicated.units[0]! }]
      writeCheckpoint(duplicated)
      const afterDuplication = stubClient()
      await expect(
        runCapture({ aoi: AOI, spec: SPEC, client: afterDuplication, maxNewSubmissions: TILE_COUNT }),
      ).rejects.toThrow(/more than once/)
      expect(afterDuplication.submissions).toBe(0)

      const malformed = readCheckpoint(SPEC)!
      // @ts-expect-error deliberately corrupting a field the cast used to accept
      malformed.units[0]!.transmittedTime = 42
      writeCheckpoint(malformed)
      await expect(
        runCapture({ aoi: AOI, spec: SPEC, client: stubClient(), maxNewSubmissions: TILE_COUNT }),
      ).rejects.toThrow(/malformed unit/)
    })
  })

  it('attests the timestamps that were sent, not the ones the plan would produce', async () => {
    await inTemporaryTree(async () => {
      const client = stubClient()
      await runCapture({ aoi: AOI, spec: SPEC, client, maxNewSubmissions: TILE_COUNT })

      // A checkpoint written under a different strategy: the units carry what was
      // actually transmitted, and it no longer matches what the plan produces.
      const drifted = readCheckpoint(SPEC)!
      for (const unit of drifted.units) unit.transmittedTime = '21:00'
      writeCheckpoint(drifted)

      await expect(
        runCapture({ aoi: AOI, spec: SPEC, client: stubClient(), maxNewSubmissions: TILE_COUNT }),
      ).rejects.toThrow(/predates a strategy change/)
    })
  })

  it('refuses to resume a checkpoint started under a different capability', async () => {
    await inTemporaryTree(async () => {
      const client = stubClient()
      await runCapture({ aoi: AOI, spec: SPEC, client, maxNewSubmissions: TILE_COUNT })
      const checkpoint = readCheckpoint(SPEC)!
      checkpoint.capabilityFingerprint = 'd'.repeat(64)
      for (const unit of checkpoint.units) unit.activityId = null
      for (const unit of checkpoint.units) unit.intentRecordedAtUtc = null
      writeCheckpoint(checkpoint)

      const second = stubClient()
      await expect(
        runCapture({ aoi: AOI, spec: SPEC, client: second, maxNewSubmissions: TILE_COUNT }),
      ).rejects.toThrow(/two different sets of answers/)
      expect(second.submissions).toBe(0)
    })
  })
})

/* ========================================================================== */
/* Concurrency                                                                 */
/* ========================================================================== */

describe('two capture processes cannot both submit', () => {
  it('takes the lock before any network call, and fails closed while it is held', async () => {
    await inTemporaryTree(async () => {
      const release = acquireCaptureLock(SPEC)
      const client = stubClient()
      await expect(
        runCapture({ aoi: AOI, spec: SPEC, client, maxNewSubmissions: TILE_COUNT }),
      ).rejects.toThrow(CaptureLockedError)
      // Not one tile was bought by the second process.
      expect(client.submissions).toBe(0)
      release()

      const after = stubClient()
      await expect(
        runCapture({ aoi: AOI, spec: SPEC, client: after, maxNewSubmissions: TILE_COUNT }),
      ).resolves.toBeTruthy()
    })
  })

  it('releases the lock even when the run fails', async () => {
    await inTemporaryTree(async () => {
      const failing = stubClient(() => new FortyGuardError('SERVER_ERROR', 'HTTP 500'))
      await expect(
        runCapture({ aoi: AOI, spec: SPEC, client: failing, maxNewSubmissions: TILE_COUNT }),
      ).rejects.toThrow()
      // A leaked lock would block every future capture of this request.
      const release = acquireCaptureLock(SPEC)
      release()
    })
  })
})

/* ========================================================================== */
/* Nothing deployable can reach the submission primitive                       */
/* ========================================================================== */

describe('the submission path is unreachable from anything that ships', () => {
  it('is not imported, directly or transitively, by any route or component', async () => {
    const { readdirSync, statSync } = await import('node:fs')
    const roots = ['app', 'components']
    const banned = [
      'fortyguard/client',
      'fortyguard/capture',
      'geo/tiles', // only reachable via the run result, never imported for submission
    ]

    const offenders: string[] = []
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory)) {
        const full = join(directory, entry)
        if (statSync(full).isDirectory()) {
          walk(full)
          continue
        }
        if (!/\.(ts|tsx)$/.test(entry)) continue
        const source = readFileSync(full, 'utf-8')
        for (const module of banned.slice(0, 2)) {
          if (source.includes(`@/lib/${module}`)) offenders.push(`${full} -> ${module}`)
        }
      }
    }
    for (const root of roots) walk(join(process.cwd(), root))
    expect(offenders).toEqual([])
  })

  it('constructs no request at all without a key, so a keyless deployment cannot 401', async () => {
    const fetchImpl = vi.fn()
    const client = new FortyGuardClient({
      apiKey: '',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await expect(
      client.submitHeatmap({
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
      }),
    ).rejects.toMatchObject({ kind: 'NO_API_KEY' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('binds every capture to the capability fingerprint in force when it ran', async () => {
    await inTemporaryTree(async () => {
      const client = stubClient()
      const result = await runCapture({
        aoi: AOI,
        spec: SPEC,
        client,
        maxNewSubmissions: TILE_COUNT,
      })
      expect(result.snapshot.source.capabilityFingerprint).toBe(capabilityFingerprint())
      expect(result.snapshot.source.timezoneStrategyApplied).toBe(true)
      expect(result.snapshot.source.capture.timestamps).toHaveLength(1)
      // The reviewed shipped manifest confirms this field and literal unit; the
      // capture records those answers rather than inferring them from a number.
      expect(result.snapshot.source.unitConfirmed).toBe(true)
      expect(result.snapshot.source.unit).toBe('°C')
    })
  })
})
