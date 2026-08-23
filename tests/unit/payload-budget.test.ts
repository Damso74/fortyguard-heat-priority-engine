import { describe, expect, it } from 'vitest'
import { executeRun } from '@/lib/agent/run'
import {
  compactHeatCells,
  expandHeatCells,
  expandPlanSummary,
  stopDetail,
  toPlanSummary,
} from '@/lib/agent/summary'
import { MAX_SUMMARY_BYTES } from '@/app/api/plans/route'
import { clearRunStore, recallByCacheKey, rememberRun, cacheKeyFor } from '@/lib/agent/run-store'

/**
 * The interactive payload, budgeted.
 *
 * `/api/plans` returned the entire run: 5,576,488 bytes decoded for a 50-stop
 * plan over central Phoenix, taking 9–11 s end to end. Half was one rectangle
 * repeated 10,212 times; most of the rest was per-stop detail for the 816 stops
 * nobody opened, including every scheduled departure minute of every route.
 *
 * Bytes are deterministic, so the guard is a test rather than a timing
 * threshold. Wall clock on CI hardware is not a property of this repository, and
 * an assertion that flakes gets raised until it means nothing;
 * `npx tsx scripts/measure-payload.mts` reports cold and warm timings instead.
 */

/**
 * The measured size of the response this work replaced, for the same request.
 *
 * In UTF-16 code units, because that is how it was measured and the code that
 * produced it is gone. The reduction is therefore compared like-for-like, while
 * the BUDGET below is enforced in UTF-8 bytes — which is what actually travels,
 * and is larger here because the payload is full of degree signs and em dashes.
 */
const AUDITED_BASELINE_UTF16_UNITS = 5_576_488
const REQUIRED_REDUCTION = 0.7

const REQUEST = { aoiId: 'central-phoenix', capacity: 50, analysisDate: '2026-08-03' }

describe('the interactive response stays inside its budget', () => {
  it('is at least 70% smaller than the response it replaced', async () => {
    const run = await executeRun(REQUEST)
    const json = JSON.stringify(toPlanSummary(run))
    const utf8Bytes = Buffer.byteLength(json, 'utf8')

    // The budget is in UTF-8, because that is what goes over the wire.
    expect(utf8Bytes).toBeLessThanOrEqual(MAX_SUMMARY_BYTES)
    // The reduction is in the units the baseline was measured in.
    expect(1 - json.length / AUDITED_BASELINE_UTF16_UNITS).toBeGreaterThanOrEqual(
      REQUIRED_REDUCTION,
    )
    // Multi-byte characters are real and the two figures must not be conflated.
    expect(utf8Bytes).toBeGreaterThan(json.length)
  }, 120_000)

  it('does not ship the full audit, the timetables or the per-stop detail', async () => {
    const run = await executeRun(REQUEST)
    const summary = toPlanSummary(run)

    // The audit travels as a digest and a shape. The trail itself is one fetch
    // away, bound to the same run id.
    expect(Array.isArray(summary.audit)).toBe(false)
    expect(summary.audit.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(summary.audit.eventCount).toBe(run.audit.length)
    expect(summary.audit.detailPath).toContain(run.runId)

    const serialised = JSON.stringify(summary)
    // The single largest item in the old payload: every departure minute of
    // every route at every stop, which no screen reads.
    expect(serialised).not.toContain('routeDepartures')
    expect(serialised).not.toContain('hourlyDepartures')

    const first = summary.results[0]!
    expect(first).not.toHaveProperty('hourly')
    expect(first).not.toHaveProperty('anomalyBySnapshot')
    expect(first.confidence).toEqual({
      band: run.results[0]!.confidence.band,
      score: run.results[0]!.confidence.score,
    })
  }, 120_000)
})

describe('the compact form cannot make the screen and the export disagree', () => {
  it('reconstructs every cell footprint exactly', async () => {
    const run = await executeRun(REQUEST)
    // The engine normalises congruent rings to `centroid + template`, so
    // factoring the template out and putting it back is lossless by
    // construction — not a rounding that happens to be close enough.
    expect(expandHeatCells(compactHeatCells(run.heatCells))).toEqual(run.heatCells)
    expect(compactHeatCells(run.heatCells).ringTemplate).not.toBeNull()

    const expanded = expandPlanSummary(toPlanSummary(run))
    expect(expanded.heatCells).toEqual(run.heatCells)
  }, 120_000)

  it('keeps irregular footprints verbatim rather than forcing a template', () => {
    const irregular = [
      {
        lon: -112.07,
        lat: 33.45,
        value: 41,
        z: 1,
        ring: [
          [-112.071, 33.449],
          [-112.069, 33.449],
          [-112.07, 33.452],
        ] as Array<[number, number]>,
      },
      {
        lon: -112.06,
        lat: 33.46,
        value: 42,
        z: 2,
        ring: [
          [-112.062, 33.458],
          [-112.058, 33.459],
          [-112.06, 33.463],
        ] as Array<[number, number]>,
      },
    ]
    const compact = compactHeatCells(irregular)
    expect(compact.ringTemplate).toBeNull()
    expect(expandHeatCells(compact)).toEqual(irregular)
  })

  it('serves detail out of the same run object the export freezes', async () => {
    const run = await executeRun(REQUEST)
    const stopId = run.results[0]!.stop.id
    const detail = stopDetail(run, stopId)!
    expect(detail.runId).toBe(run.runId)
    expect(detail.hourly).toEqual(run.results[0]!.hourly)
    expect(detail.confidence).toEqual(run.results[0]!.confidence)
    // The engine's own timetable, which the summary never carries.
    expect(detail.stop.service).toEqual(run.results[0]!.stop.service)
    expect(stopDetail(run, -1)).toBeNull()
  }, 120_000)
})

describe('an identical request is answered from the stored run', () => {
  it('returns the same run object rather than re-deriving it', async () => {
    clearRunStore()
    const key = cacheKeyFor({
      request: REQUEST,
      datasetSha256: 'dataset',
      engineVersion: '2.0.0',
      snapshotStoreStamp: 'stamp',
    })
    expect(recallByCacheKey(key)).toBeNull()

    const run = await executeRun(REQUEST)
    rememberRun(run, REQUEST, { cacheKey: key })
    expect(recallByCacheKey(key)?.run).toBe(run)

    // Key order in the request cannot change the answer.
    const reordered = cacheKeyFor({
      request: { analysisDate: '2026-08-03', capacity: 50, aoiId: 'central-phoenix' },
      datasetSha256: 'dataset',
      engineVersion: '2.0.0',
      snapshotStoreStamp: 'stamp',
    })
    expect(reordered).toBe(key)

    // …but a new dataset, a new engine or a newly committed snapshot must.
    for (const patch of [
      { datasetSha256: 'other' },
      { engineVersion: '2.1.0' },
      { snapshotStoreStamp: 'a capture was committed' },
      { request: { ...REQUEST, capacity: 20 } },
    ]) {
      expect(
        cacheKeyFor({
          request: REQUEST,
          datasetSha256: 'dataset',
          engineVersion: '2.0.0',
          snapshotStoreStamp: 'stamp',
          ...patch,
        }),
      ).not.toBe(key)
    }
    clearRunStore()
  }, 120_000)
})
