import type { AuditEvent, DayType, RunResult, StopResult, TransitStop } from '@/lib/types'
import { auditHash } from '@/lib/audit/log'
import { round } from '@/lib/metrics/stats'

/**
 * The compact form of a run, as the interactive endpoint returns it.
 *
 * ## Why the default response is not the whole run
 *
 * `/api/plans` returned the entire `RunResult`: 5.58 MB decoded for a 50-stop
 * plan over central Phoenix, taking 9–11 s to produce and transfer. Half of that
 * was cell geometry and half was per-stop payload, and the two largest single
 * items were things no screen reads:
 *
 * - **every scheduled departure minute for every route at every stop**
 *   (`service.byDayType[*].routeDepartures`, 1.2 MB). The engine needs them to
 *   compute expected waits; the browser shows `dailyDepartures` and `routeCount`.
 * - **an explicit polygon ring per heat cell** (2.7 MB across 10,212 cells) —
 *   which, on a gridded surface, is the same rectangle translated 10,212 times.
 *
 * So the summary drops what the interface does not read and factors out what is
 * repeated. It is a **transport** transformation, not an analytical one: nothing
 * is rounded, recomputed or re-derived, and `expandPlanSummary` reconstructs an
 * object equal to the input for every field the interface uses. A test asserts
 * that round trip, because a payload optimisation that let the screen and the
 * export disagree would be a worse defect than the one it fixed.
 *
 * ## The audit is not summary data
 *
 * The full trail is reachable through the detail path and the export, both bound
 * to the same run id. What travels here is its digest and its shape, which is
 * what a summary needs: enough to say the trail exists and to detect a different
 * one, not the trail itself.
 */

/** Fields of a stop's service the list and the map read. */
export interface SummaryDayTypeService {
  dailyDepartures: number
  routeCount: number
  departuresAfterMidnight: number
}

/**
 * A stop as the summary carries it.
 *
 * Dropped: `description` (36 kB, shown only in the detail panel), the full
 * `ridership.byQuarter` table (140 kB, of which the list reads one figure), the
 * undocumented `legacyRidershipIndex` (never computed on), and every day type's
 * timetable but the one being analysed.
 */
export interface SummaryStop {
  id: number
  code: number | null
  name: string
  lat: number
  lon: number
  routes: string[]
  shelterStatus: TransitStop['shelterStatus']
  /** The analysed day type only. */
  service: SummaryDayTypeService | null
  /** The published figure for the analysed quarter and category. One number. */
  publishedDailyRiders: number | null
}

/**
 * Per-stop fields the list and the map read.
 *
 * Everything else — the hourly decomposition, the per-snapshot anomaly, the
 * confidence rationale, the scenario envelope internals, the coverage counts —
 * is read by the **detail panel**, for one stop at a time. Shipping all of it for
 * every stop in the area spent about 1.4 MB on the 816 stops nobody opened. It
 * comes back from `/api/plans/detail`, bound to the same run id, so the panel
 * shows the same numbers the export carries.
 */
export interface SummaryStopResult {
  stop: SummaryStop
  exposure: number | null
  exposurePercentile: number | null
  anomalyZ: number | null
  anomalyPercentile: number | null
  quadrant: StopResult['quadrant']
  paretoFront: number | null
  ridersInWindow: number
  /** Compact baseline inputs used by the scenario comparison screen. */
  meanWaitMinutes: number | null
  meanExcessC: number | null
  pinned: boolean
  assumptionSensitive: boolean
  scenarioSelectionCount: number
  scenarioCount: number
  scenariosOffered: number
  scenarioSelectionRate: number
  scenarioRankBest: number | null
  scenarioRankWorst: number | null
  confidence: { band: StopResult['confidence']['band']; score: number }
  complete: boolean
}

export interface CompactHeatCells {
  /**
   * Offsets from a cell's centroid, shared by every cell.
   *
   * Present when all rings are congruent, which is what a gridded product
   * produces — and which the engine has already normalised them to, so the shape
   * here is byte-identical to the one the export carries. Null when the
   * footprints are irregular, in which case each cell keeps its own ring.
   */
  ringTemplate: Array<[number, number]> | null
  cells: Array<{
    lon: number
    lat: number
    value: number
    z: number | null
    /** Only when `ringTemplate` is null. */
    ring?: Array<[number, number]>
  }>
}

export interface AuditSummary {
  sha256: string
  eventCount: number
  lastStep: string
  /** Where the full trail is, bound to this run. */
  detailPath: string
}

export type PlanSummary = Omit<RunResult, 'results' | 'heatCells' | 'audit'> & {
  results: SummaryStopResult[]
  heatCells: CompactHeatCells
  audit: AuditSummary
  /** Marks the payload so a consumer cannot mistake it for the full run. */
  payload: 'summary'
}

/**
 * The summary as the browser holds it, with cell footprints reconstructed.
 *
 * `expandHeatCells` rebuilds each ring from the shared template, which is exact:
 * the engine already normalised the rings to `centroid + template`, so this is
 * the inverse of a lossless factorisation rather than an approximation. A test
 * asserts the round trip, because a payload optimisation that let the map draw
 * one polygon while the export recorded another would be a worse defect than the
 * size it fixed.
 */
export type ExpandedPlanSummary = Omit<PlanSummary, 'heatCells'> & {
  heatCells: RunResult['heatCells']
}

export function expandPlanSummary(summary: PlanSummary): ExpandedPlanSummary {
  return { ...summary, heatCells: expandHeatCells(summary.heatCells) }
}

/** Congruence tolerance, in degrees. Well below any coordinate this product emits. */
const RING_EPSILON = 1e-9

/** The precision the engine normalises cell footprints to. */
const RING_DECIMALS = 7

function ringOffsets(
  cell: RunResult['heatCells'][number],
): Array<[number, number]> {
  return cell.ring.map(([lon, lat]) => [
    round(lon - cell.lon, RING_DECIMALS),
    round(lat - cell.lat, RING_DECIMALS),
  ])
}

function sameOffsets(a: Array<[number, number]>, b: Array<[number, number]>): boolean {
  if (a.length !== b.length) return false
  return a.every(
    (point, index) =>
      Math.abs(point[0] - b[index]![0]) < RING_EPSILON &&
      Math.abs(point[1] - b[index]![1]) < RING_EPSILON,
  )
}

export function compactHeatCells(heatCells: RunResult['heatCells']): CompactHeatCells {
  const first = heatCells[0]
  const template = first && first.ring.length > 0 ? ringOffsets(first) : null
  const congruent =
    template !== null &&
    heatCells.every((cell) => cell.ring.length > 0 && sameOffsets(ringOffsets(cell), template))

  return {
    ringTemplate: congruent ? template : null,
    cells: heatCells.map((cell) => ({
      lon: cell.lon,
      lat: cell.lat,
      value: cell.value,
      z: cell.z,
      ...(congruent ? {} : { ring: cell.ring }),
    })),
  }
}

export function expandHeatCells(compact: CompactHeatCells): RunResult['heatCells'] {
  return compact.cells.map((cell) => ({
    lon: cell.lon,
    lat: cell.lat,
    value: cell.value,
    z: cell.z,
    ring:
      cell.ring ??
      (compact.ringTemplate
        ? compact.ringTemplate.map(
            // Rounded to the same 7 decimal places the engine used when it
            // normalised the ring, so this is the exact inverse rather than a
            // reconstruction that lands a float ulp away.
            ([lon, lat]) =>
              [round(cell.lon + lon, RING_DECIMALS), round(cell.lat + lat, RING_DECIMALS)] as [
                number,
                number,
              ],
          )
        : []),
  }))
}

function summariseStop(
  stop: TransitStop,
  dayType: DayType,
  publishedDailyRiders: number | null,
): SummaryStop {
  const service = stop.service?.byDayType?.[dayType]
  return {
    id: stop.id,
    code: stop.code,
    name: stop.name,
    lat: stop.lat,
    lon: stop.lon,
    routes: stop.routes,
    shelterStatus: stop.shelterStatus,
    service: service
      ? {
          dailyDepartures: service.dailyDepartures,
          routeCount: service.routeCount,
          departuresAfterMidnight: service.departuresAfterMidnight,
        }
      : null,
    publishedDailyRiders,
  }
}

export function toPlanSummary(run: RunResult): PlanSummary {
  const { results, heatCells, audit, ...rest } = run
  const last = audit[audit.length - 1]
  const dayType = run.methodology.exposure.dayType

  return {
    ...rest,
    payload: 'summary',
    results: results.map((result) => ({
      stop: summariseStop(result.stop, dayType, result.publishedDailyRiders),
      exposure: result.exposure,
      exposurePercentile: result.exposurePercentile,
      anomalyZ: result.anomalyZ,
      anomalyPercentile: result.anomalyPercentile,
      quadrant: result.quadrant,
      paretoFront: result.paretoFront,
      ridersInWindow: result.ridersInWindow,
      meanWaitMinutes: result.meanWaitMinutes,
      meanExcessC: result.meanExcessC,
      pinned: result.pinned,
      assumptionSensitive: result.assumptionSensitive,
      scenarioSelectionCount: result.scenarioSelectionCount,
      scenarioCount: result.scenarioCount,
      scenariosOffered: result.scenariosOffered,
      scenarioSelectionRate: result.scenarioSelectionRate,
      scenarioRankBest: result.scenarioRankBest,
      scenarioRankWorst: result.scenarioRankWorst,
      confidence: { band: result.confidence.band, score: result.confidence.score },
      complete: result.complete,
    })),
    heatCells: compactHeatCells(heatCells),
    audit: {
      sha256: auditHash(audit),
      eventCount: audit.length,
      lastStep: last?.step ?? 'created',
      detailPath: `/api/plans/detail?runId=${encodeURIComponent(run.runId)}&include=audit`,
    },
  }
}

/**
 * Everything the summary left out for one stop.
 *
 * Read from the **stored run** — the same object the export freezes — so the
 * panel and the exported CSV cannot show different numbers for the same stop.
 */
export type StopDetailPayload = Omit<StopResult, 'stop'> & {
  runId: string
  stop: TransitStop
}

export function stopDetail(run: RunResult, stopId: number): StopDetailPayload | null {
  const result = run.results.find((entry) => entry.stop.id === stopId)
  if (!result) return null
  return { runId: run.runId, ...result }
}

/** The full audit, for the detail path. */
export function auditDetail(run: RunResult): { runId: string; sha256: string; audit: AuditEvent[] } {
  return { runId: run.runId, sha256: auditHash(run.audit), audit: run.audit }
}
