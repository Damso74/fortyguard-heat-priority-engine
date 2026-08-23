/**
 * Metric B — local thermal anomaly.
 *
 * ## What it estimates
 *
 * How unusual a cell's temperature is **for its own surroundings**, rather than
 * for the city. This is the one question ridership data cannot answer and a
 * coarse gridded product cannot answer either: it needs a hyperlocal surface.
 *
 *     z(c) = ( v(c) − median(N(c)) ) / ( 1.4826 · MAD(N(c)) )
 *
 * where `N(c)` is every other cell within `radiusMeters` of `c`.
 *
 * ## Why median and MAD rather than mean and standard deviation
 *
 * The thing being detected — a hot spot — is exactly the thing that would
 * contaminate a mean-and-σ background. Median and MAD have a 50% breakdown
 * point, so a genuine anomaly does not inflate the baseline it is being measured
 * against. The 1.4826 factor makes MAD a consistent estimator of σ for normally
 * distributed data, so `z` reads on the familiar scale.
 *
 * ## Leave-one-out by construction
 *
 * A cell is **excluded from its own background**. Without that, a strong anomaly
 * partly defines the baseline it is compared to and is systematically
 * under-detected. This is structural here, not an option.
 *
 * ## Out-of-sample validation
 *
 * A hot cell at one moment could be sensor noise. So the background is fitted
 * independently per snapshot and the anomalies are compared **across held-out
 * snapshots**: an anomaly that is real (asphalt, no canopy, a west-facing wall)
 * persists through the afternoon; noise does not. Reported as rank correlation
 * plus top-decile retention.
 */

import type { ThermalCell } from '@/lib/types'
import { MAD_TO_SIGMA, medianInPlace, round, spearman } from './stats'
import { GRID_REFERENCE_LATITUDE, metersPerDegreeLat, metersPerDegreeLon } from '@/lib/geo/measure'

export interface AnomalyParameters {
  /** Radius of the local background, in metres. */
  radiusMeters: number
  /** Minimum neighbours required before a z-score is reported at all. */
  minNeighbours: number
}

export const DEFAULT_ANOMALY_PARAMETERS: AnomalyParameters = {
  radiusMeters: 1000,
  minNeighbours: 12,
}

export interface CellAnomaly {
  cellId: string
  snapshot: string
  lon: number
  lat: number
  value: number
  /**
   * Local background level, or **null** when no background could be measured.
   *
   * Null rather than 0. A zero here is a real temperature on a Celsius-like
   * scale, so "no neighbours" and "the neighbourhood sits at zero" used to be
   * the same value — and the first is a gap while the second is a finding.
   */
  backgroundC: number | null
  /** Robust scale of the local background, or null when it could not be measured. */
  scaleC: number | null
  /** Robust z-score, or null when the neighbourhood is too small or degenerate. */
  z: number | null
  neighbours: number
}

const LON_M = metersPerDegreeLon(GRID_REFERENCE_LATITUDE)
const LAT_M = metersPerDegreeLat()

/** Bucket index for a coarse spatial hash keyed on the search radius. */
function bucketKey(lon: number, lat: number, radiusMeters: number): string {
  const col = Math.floor((lon * LON_M) / radiusMeters)
  const row = Math.floor((lat * LAT_M) / radiusMeters)
  return `${col}:${row}`
}

/**
 * Compute the robust local anomaly for every cell of one snapshot.
 *
 * A spatial hash keyed on the radius keeps this linear in practice: only the
 * 3×3 block of buckets around a cell can contain a neighbour within range.
 */
export function computeSnapshotAnomalies(
  cells: readonly ThermalCell[],
  parameters: AnomalyParameters = DEFAULT_ANOMALY_PARAMETERS,
): CellAnomaly[] {
  const { radiusMeters, minNeighbours } = parameters
  if (cells.length === 0) return []

  const buckets = new Map<string, ThermalCell[]>()
  for (const cell of cells) {
    const key = bucketKey(cell.centroidLon, cell.centroidLat, radiusMeters)
    const bucket = buckets.get(key)
    if (bucket) bucket.push(cell)
    else buckets.set(key, [cell])
  }

  const radiusSquared = radiusMeters * radiusMeters
  const output: CellAnomaly[] = []

  for (const cell of cells) {
    const col = Math.floor((cell.centroidLon * LON_M) / radiusMeters)
    const row = Math.floor((cell.centroidLat * LAT_M) / radiusMeters)

    const neighbourValues: number[] = []
    for (let dc = -1; dc <= 1; dc += 1) {
      for (let dr = -1; dr <= 1; dr += 1) {
        const bucket = buckets.get(`${col + dc}:${row + dr}`)
        if (!bucket) continue
        for (const other of bucket) {
          // Leave-one-out: a cell never contributes to its own background.
          if (other.id === cell.id) continue
          const dx = (other.centroidLon - cell.centroidLon) * LON_M
          const dy = (other.centroidLat - cell.centroidLat) * LAT_M
          if (dx * dx + dy * dy <= radiusSquared) neighbourValues.push(other.value)
        }
      }
    }

    // medianInPlace reorders the scratch array; nothing downstream reads its
    // order, and the deviations are computed from the values, not their index.
    const background = medianInPlace(neighbourValues)
    let scale: number | null = null
    if (background !== null) {
      for (let i = 0; i < neighbourValues.length; i += 1) {
        neighbourValues[i] = Math.abs(neighbourValues[i]! - background)
      }
      const mad = medianInPlace(neighbourValues)
      scale = mad === null ? null : mad * MAD_TO_SIGMA
    }

    // A degenerate scale means the neighbourhood is flat: the honest answer is
    // "no anomaly can be measured here", not a division by something tiny.
    const z =
      background === null ||
      scale === null ||
      neighbourValues.length < minNeighbours ||
      scale < 1e-6
        ? null
        : (cell.value - background) / scale

    output.push({
      cellId: cell.id,
      snapshot: cell.snapshot,
      lon: cell.centroidLon,
      lat: cell.centroidLat,
      value: round(cell.value, 3),
      backgroundC: background === null ? null : round(background, 3),
      scaleC: scale === null ? null : round(scale, 4),
      z: z === null ? null : round(z, 3),
      neighbours: neighbourValues.length,
    })
  }

  return output
}

/**
 * What the validation is evidence *about*.
 *
 * A persistence result computed on the synthetic fixture says the fixture is
 * internally self-consistent. It says nothing whatever about Phoenix, and must
 * never be presented as though it did — the fixture's hot patches were placed
 * at fixed positions by construction, so finding them persistent is a check
 * that the estimator works, not a finding about the city.
 */
export type ValidationScope = 'live_measurement' | 'synthetic_fixture'

export type ValidationVerdict = 'PERSISTENT' | 'WEAK' | 'NOT_PERSISTENT' | 'INSUFFICIENT_DATA'

/** One held-out snapshot, validated against the fit **on its own**. */
export interface HoldoutValidation {
  snapshot: string
  /** Cells scored in both the fit and this holdout. */
  comparedCells: number
  rankCorrelation: number | null
  topDecileRetention: number | null
  verdict: ValidationVerdict
  /** Why this holdout is not PERSISTENT. Null when it is. */
  failureReason: string | null
}

export interface AnomalyValidation {
  /** Snapshot whose anomalies were treated as the fit. */
  fitSnapshot: string
  holdoutSnapshots: string[]
  /**
   * Each holdout's own verdict, with its own denominator.
   *
   * The aggregate below is derived from these; they are not derived from it.
   */
  perHoldout: HoldoutValidation[]
  /** Cells compared in the **weakest** holdout — the honest denominator. */
  comparedCells: number
  /** The weakest holdout's rank correlation, not a mean of them. */
  rankCorrelation: number | null
  /** The weakest holdout's top-decile retention. */
  topDecileRetention: number | null
  /** Chance level for the retention figure, for reference. */
  topDecileChanceLevel: number
  verdict: ValidationVerdict
  scope: ValidationScope
  /** Wording safe to display. Never claims Phoenix validation from a fixture. */
  statement: string
  /** Every holdout that failed, and why. Empty when all passed. */
  failureReasons: string[]
  /**
   * Whether this validation is strong enough to support the two-axis product.
   *
   * One holdout snapshot is not out-of-sample validation in any useful sense: a
   * single pair of snapshots taken twenty minutes apart will correlate because
   * the ground has not had time to change, not because the anomaly is real. The
   * anomaly axis may only be *claimed* when at least `MIN_HOLDOUT_SNAPSHOTS`
   * held-out snapshots **each** agree with the fit.
   */
  sufficientHoldouts: boolean
  holdoutCount: number
  minimumHoldouts: number
}

/**
 * Held-out snapshots required before the anomaly axis may be claimed.
 *
 * Two, so a run needs three snapshots in total. With one holdout, "persistent"
 * means "two readings agreed once", which a slow-moving surface guarantees
 * regardless of whether the anomaly is a real feature of the ground.
 */
export const MIN_HOLDOUT_SNAPSHOTS = 2

/** Cells that must be scored in both fit and holdout before a verdict is offered. */
export const MIN_COMPARED_CELLS = 20

/** Thresholds a single holdout must clear on its own. */
export const PERSISTENT_RANK_CORRELATION = 0.6
export const PERSISTENT_TOP_DECILE_RETENTION = 0.5
export const WEAK_RANK_CORRELATION = 0.3

/** The only place validation wording is produced, so it cannot drift. */
export function validationStatement(
  verdict: AnomalyValidation['verdict'],
  scope: ValidationScope,
): string {
  if (scope === 'synthetic_fixture') {
    return (
      `Estimator self-check on the synthetic fixture: ${verdict}. ` +
      'This demonstrates that the anomaly estimator recovers spatially fixed features ' +
      'it was given. It is NOT evidence about Phoenix, and no Phoenix anomaly has been ' +
      'validated — no FortyGuard measurement exists in this run.'
    )
  }
  switch (verdict) {
    case 'PERSISTENT':
      return 'Validated on held-out FortyGuard snapshots: the same locations remain anomalous.'
    case 'WEAK':
      return 'Partially validated on held-out FortyGuard snapshots; treat the anomaly axis as indicative.'
    case 'NOT_PERSISTENT':
      return 'Not validated: anomalies did not persist across held-out FortyGuard snapshots.'
    default:
      return 'Insufficient data to validate the anomaly out of sample.'
  }
}

/** Cells are matched on rounded position, not id: ids embed the snapshot. */
const positionKey = (entry: CellAnomaly) => `${entry.lon.toFixed(5)}|${entry.lat.toFixed(5)}`

/**
 * Validate **one** held-out snapshot against the fit.
 *
 * The position key travels with each pair. Retention is a question about
 * *cells* — "is this place still in the top decile?" — and an earlier version
 * answered it by comparing z VALUES: it built a Set of top-decile fit z-scores
 * and asked whether each top-decile holdout z was in that set. Two different
 * cells sharing a z counted as retained, and a cell whose z shifted by 1e-9
 * counted as lost. On a gridded surface with many repeated values that is not a
 * rounding-level error; identity is the position, as it always should have been.
 */
function validateOneHoldout(
  snapshot: string,
  fitByPosition: ReadonlyMap<string, number>,
  entries: readonly CellAnomaly[],
): HoldoutValidation {
  const shared: Array<{ key: string; fit: number; out: number }> = []
  for (const entry of entries) {
    if (entry.z === null) continue
    const fit = fitByPosition.get(positionKey(entry))
    if (fit === undefined) continue
    shared.push({ key: positionKey(entry), fit, out: entry.z })
  }

  if (shared.length < MIN_COMPARED_CELLS) {
    return {
      snapshot,
      comparedCells: shared.length,
      rankCorrelation: null,
      topDecileRetention: null,
      verdict: 'INSUFFICIENT_DATA',
      failureReason:
        `${snapshot}: only ${shared.length} cell(s) were scored in both the fit and this ` +
        `holdout; ${MIN_COMPARED_CELLS} are required before a verdict is offered.`,
    }
  }

  const correlation = spearman(
    shared.map((entry) => entry.fit),
    shared.map((entry) => entry.out),
  )

  const decileSize = Math.max(1, Math.floor(shared.length * 0.1))
  // Ties at the decile boundary are broken on the position key so the set is
  // deterministic rather than dependent on sort stability.
  const topFit = new Set(
    [...shared]
      .sort((a, b) => b.fit - a.fit || (a.key < b.key ? -1 : 1))
      .slice(0, decileSize)
      .map((entry) => entry.key),
  )
  const topOut = [...shared]
    .sort((a, b) => b.out - a.out || (a.key < b.key ? -1 : 1))
    .slice(0, decileSize)
  const retention = topOut.filter((entry) => topFit.has(entry.key)).length / decileSize

  let verdict: ValidationVerdict = 'NOT_PERSISTENT'
  if (
    correlation !== null &&
    correlation >= PERSISTENT_RANK_CORRELATION &&
    retention >= PERSISTENT_TOP_DECILE_RETENTION
  ) {
    verdict = 'PERSISTENT'
  } else if (correlation !== null && correlation >= WEAK_RANK_CORRELATION) {
    verdict = 'WEAK'
  }

  const failureReason =
    verdict === 'PERSISTENT'
      ? null
      : `${snapshot}: rank correlation ${correlation === null ? 'n/a' : correlation.toFixed(3)} ` +
        `(needs ≥ ${PERSISTENT_RANK_CORRELATION}) and top-decile retention ` +
        `${retention.toFixed(3)} (needs ≥ ${PERSISTENT_TOP_DECILE_RETENTION}) over ` +
        `${shared.length} shared cell(s).`

  return {
    snapshot,
    comparedCells: shared.length,
    rankCorrelation: correlation === null ? null : round(correlation, 3),
    topDecileRetention: round(retention, 3),
    verdict,
    failureReason,
  }
}

const VERDICT_RANK: Record<ValidationVerdict, number> = {
  PERSISTENT: 3,
  WEAK: 2,
  NOT_PERSISTENT: 1,
  INSUFFICIENT_DATA: 0,
}

/**
 * Hold out snapshots and check whether the same places are anomalous.
 *
 * This is what separates "this asphalt junction is genuinely hotter than its
 * block" from "this cell was noisy at 14:00".
 *
 * ## Every holdout is validated on its own, before anything is combined
 *
 * The previous implementation averaged each position's z **across** the held-out
 * snapshots and then correlated the fit against that average. Averaging before
 * validating is exactly backwards, and it hides the failure it most needs to
 * catch: one perfectly aligned holdout and one perfectly inverted holdout average
 * to a flat field that correlates with nothing — or, with three holdouts, to a
 * field dominated by the two that agreed, so a fully inverted third snapshot
 * disappears into the mean and the run reports PERSISTENT.
 *
 * "The anomaly persisted across the afternoon" is a claim about **each** later
 * reading, so each is now scored against the fit separately, with its own
 * denominator, and the aggregate is the **weakest** of them. A single holdout
 * that fails makes the whole verdict fail, and its reason is reported.
 */
export function validateAnomalies(
  bySnapshot: ReadonlyMap<string, readonly CellAnomaly[]>,
  scope: ValidationScope = 'live_measurement',
): AnomalyValidation {
  const snapshots = [...bySnapshot.keys()].sort()
  const insufficient = (fitSnapshot: string, holdout: string[]): AnomalyValidation => ({
    fitSnapshot,
    holdoutSnapshots: holdout,
    perHoldout: [],
    comparedCells: 0,
    rankCorrelation: null,
    topDecileRetention: null,
    topDecileChanceLevel: 0.1,
    verdict: 'INSUFFICIENT_DATA',
    scope,
    statement: validationStatement('INSUFFICIENT_DATA', scope),
    failureReasons: [
      `Only ${holdout.length} held-out snapshot(s); at least one is needed to validate anything ` +
        `and ${MIN_HOLDOUT_SNAPSHOTS} before the anomaly axis may be claimed.`,
    ],
    sufficientHoldouts: false,
    holdoutCount: holdout.length,
    minimumHoldouts: MIN_HOLDOUT_SNAPSHOTS,
  })

  if (snapshots.length < 2) return insufficient(snapshots[0] ?? '', [])

  const fitSnapshot = snapshots[0]!
  const holdout = snapshots.slice(1)

  const fitByPosition = new Map<string, number>()
  for (const entry of bySnapshot.get(fitSnapshot) ?? []) {
    if (entry.z !== null) fitByPosition.set(positionKey(entry), entry.z)
  }

  const perHoldout = holdout.map((snapshot) =>
    validateOneHoldout(snapshot, fitByPosition, bySnapshot.get(snapshot) ?? []),
  )

  // The weakest holdout decides. `reduce` over the rank rather than a mean,
  // because the question is whether the anomaly held EVERY time, not on average.
  const weakest = perHoldout.reduce((worst, entry) =>
    VERDICT_RANK[entry.verdict] < VERDICT_RANK[worst.verdict] ? entry : worst,
  )

  const failureReasons = perHoldout
    .filter((entry) => entry.failureReason !== null)
    .map((entry) => entry.failureReason as string)

  // A PERSISTENT aggregate additionally requires enough holdouts to have been
  // held out at all: two readings agreeing once is what a slow-moving surface
  // produces regardless of whether the anomaly is a feature of the ground.
  const enoughHoldouts = holdout.length >= MIN_HOLDOUT_SNAPSHOTS
  const verdict: ValidationVerdict =
    weakest.verdict === 'PERSISTENT' && !enoughHoldouts ? 'WEAK' : weakest.verdict

  return {
    fitSnapshot,
    holdoutSnapshots: holdout,
    perHoldout,
    comparedCells: weakest.comparedCells,
    rankCorrelation: weakest.rankCorrelation,
    topDecileRetention: weakest.topDecileRetention,
    topDecileChanceLevel: 0.1,
    verdict,
    scope,
    statement: validationStatement(verdict, scope),
    failureReasons,
    sufficientHoldouts:
      enoughHoldouts && perHoldout.every((entry) => entry.verdict === 'PERSISTENT'),
    holdoutCount: holdout.length,
    minimumHoldouts: MIN_HOLDOUT_SNAPSHOTS,
  }
}

/**
 * Snapshots a single stop must be scored in before it gets an anomaly at all.
 *
 * Two. A stop with one scored snapshot has a z that no second reading has ever
 * agreed with — it is one number, and calling it "unusually hot for its
 * surroundings across the afternoon" is the claim the whole validation step
 * exists to earn. The surface-level validation says the *estimator* recovers
 * persistent features; it says nothing about a stop the holdouts never covered.
 * Those are two different questions and this is the second one.
 */
export const MIN_SNAPSHOTS_FOR_STOP_ANOMALY = 2

export interface StopAnomaly {
  stopId: number
  /**
   * Mean robust z across the analysed snapshots, or null when too few of them
   * scored this stop. Never a mean of one.
   */
  z: number | null
  /** Per-snapshot z, for the hourly profile. */
  bySnapshot: Array<{ snapshot: string; z: number | null; value: number | null }>
  /** Local background the stop is being compared against, in the layer's unit. */
  backgroundC: number | null
  snapshotsWithValue: number
  /** Snapshots in which this stop actually received a z. The real denominator. */
  snapshotsWithScore: number
  snapshotsAnalysed: number
  minimumSnapshots: number
  /** Why this stop has no anomaly score. Null when it has one. */
  ineligibleReason: string | null
  /** How each snapshot's cell was found. */
  matchedBy: 'containment' | 'nearest_within_half_diagonal' | 'none'
}

/** Half the diagonal of a cell's own bounding box, in metres. */
export function halfCellDiagonalMeters(ring: ReadonlyArray<[number, number]>): number | null {
  if (ring.length < 3) return null
  let minLon = Infinity
  let maxLon = -Infinity
  let minLat = Infinity
  let maxLat = -Infinity
  for (const [lon, lat] of ring) {
    if (lon < minLon) minLon = lon
    if (lon > maxLon) maxLon = lon
    if (lat < minLat) minLat = lat
    if (lat > maxLat) maxLat = lat
  }
  const width = (maxLon - minLon) * LON_M
  const height = (maxLat - minLat) * LAT_M
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null
  return Math.hypot(width, height) / 2
}

/** Ray casting on the cell's own outer ring. */
export function pointInRing(
  point: { lon: number; lat: number },
  ring: ReadonlyArray<[number, number]>,
): boolean {
  if (ring.length < 3) return false
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!
    const [xj, yj] = ring[j]!
    const intersects =
      yi > point.lat !== yj > point.lat &&
      point.lon < ((xj - xi) * (point.lat - yi)) / (yj - yi || Number.EPSILON) + xi
    if (intersects) inside = !inside
  }
  return inside
}

/**
 * Attach the anomaly of the containing cell to each stop.
 *
 * **Containment first.** A stop is in the cell whose polygon contains it; that
 * is the actual question, and the cells arrive as polygons, so it can simply be
 * answered. The previous version skipped straight to nearest-centroid within a
 * hardcoded 120 m, which was wrong twice over: 120 m is not derived from
 * anything (the documented granularities are 60, 80 and 100 m, whose half
 * diagonals are 42, 57 and 71 m), and it is *larger* than a 60 m cell's half
 * diagonal, so a stop could be assigned to a cell it demonstrably sits outside —
 * up to two cells away.
 *
 * **Nearest, bounded by the real half diagonal, second.** When no polygon
 * contains the stop — a seam between tiles, a gap in coverage — the fallback is
 * the nearest centroid within *that cell's own* half diagonal, computed from its
 * ring rather than assumed. Beyond that the honest answer is no match.
 */
export function attachAnomaliesToStops(
  stops: ReadonlyArray<{ id: number; lat: number; lon: number }>,
  anomaliesBySnapshot: ReadonlyMap<string, readonly CellAnomaly[]>,
  ringsByCellId: ReadonlyMap<string, ReadonlyArray<[number, number]>> = new Map(),
  /** Search radius for candidate cells. Not a match tolerance. */
  searchRadiusMeters = 200,
): Map<number, StopAnomaly> {
  const snapshots = [...anomaliesBySnapshot.keys()].sort()
  const indexes = new Map<string, Map<string, CellAnomaly[]>>()

  for (const snapshot of snapshots) {
    const buckets = new Map<string, CellAnomaly[]>()
    for (const entry of anomaliesBySnapshot.get(snapshot) ?? []) {
      const key = bucketKey(entry.lon, entry.lat, searchRadiusMeters)
      const bucket = buckets.get(key)
      if (bucket) bucket.push(entry)
      else buckets.set(key, [entry])
    }
    indexes.set(snapshot, buckets)
  }

  const output = new Map<number, StopAnomaly>()

  for (const stop of stops) {
    const bySnapshot: StopAnomaly['bySnapshot'] = []
    const zValues: number[] = []
    const backgrounds: number[] = []
    let matchedBy: StopAnomaly['matchedBy'] = 'none'

    for (const snapshot of snapshots) {
      const buckets = indexes.get(snapshot)
      let containing: CellAnomaly | null = null
      let nearest: CellAnomaly | null = null
      let nearestDistance = Infinity

      if (buckets) {
        const col = Math.floor((stop.lon * LON_M) / searchRadiusMeters)
        const row = Math.floor((stop.lat * LAT_M) / searchRadiusMeters)
        for (let dc = -1; dc <= 1 && !containing; dc += 1) {
          for (let dr = -1; dr <= 1 && !containing; dr += 1) {
            for (const entry of buckets.get(`${col + dc}:${row + dr}`) ?? []) {
              const ring = ringsByCellId.get(entry.cellId)
              // Containment is the actual question, and the cells are polygons.
              if (ring && pointInRing({ lon: stop.lon, lat: stop.lat }, ring)) {
                containing = entry
                break
              }
              const dx = (entry.lon - stop.lon) * LON_M
              const dy = (entry.lat - stop.lat) * LAT_M
              const distance = Math.hypot(dx, dy)
              if (distance < nearestDistance) {
                nearestDistance = distance
                nearest = entry
              }
            }
          }
        }
      }

      let best: CellAnomaly | null = containing
      if (best) {
        if (matchedBy === 'none') matchedBy = 'containment'
      } else if (nearest) {
        // Fall back to the nearest centroid, bounded by THAT cell's own half
        // diagonal rather than by a constant. A cell with no ring cannot bound
        // anything, so it is not used as a fallback at all.
        const ring = ringsByCellId.get(nearest.cellId)
        const tolerance = ring ? halfCellDiagonalMeters(ring) : null
        if (tolerance !== null && nearestDistance <= tolerance) {
          best = nearest
          if (matchedBy === 'none') matchedBy = 'nearest_within_half_diagonal'
        }
      }

      if (best) {
        bySnapshot.push({ snapshot, z: best.z, value: best.value })
        if (best.z !== null) zValues.push(best.z)
        // Null backgrounds are dropped rather than counted as zero: a cell whose
        // neighbourhood could not be measured has no background, and averaging a
        // manufactured 0 into a Celsius-like scale would drag it towards freezing.
        if (best.backgroundC !== null) backgrounds.push(best.backgroundC)
      } else {
        bySnapshot.push({ snapshot, z: null, value: null })
      }
    }

    const eligible = zValues.length >= MIN_SNAPSHOTS_FOR_STOP_ANOMALY
    const ineligibleReason = eligible
      ? null
      : zValues.length === 0
        ? `No analysed snapshot produced a local anomaly at this stop (${snapshots.length} analysed).`
        : `Scored in ${zValues.length} of ${snapshots.length} analysed snapshot(s); ` +
          `${MIN_SNAPSHOTS_FOR_STOP_ANOMALY} are required before a stop carries an anomaly. ` +
          'One reading is not a persistence claim.'

    output.set(stop.id, {
      stopId: stop.id,
      z: eligible ? round(zValues.reduce((a, b) => a + b, 0) / zValues.length, 3) : null,
      bySnapshot,
      backgroundC: backgrounds.length
        ? round(backgrounds.reduce((a, b) => a + b, 0) / backgrounds.length, 2)
        : null,
      snapshotsWithValue: bySnapshot.filter((entry) => entry.value !== null).length,
      snapshotsWithScore: zValues.length,
      snapshotsAnalysed: snapshots.length,
      minimumSnapshots: MIN_SNAPSHOTS_FOR_STOP_ANOMALY,
      ineligibleReason,
      matchedBy,
    })
  }

  return output
}
