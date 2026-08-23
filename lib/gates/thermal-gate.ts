import type { ThermalLayer } from '@/lib/types'
import type { CellAnomaly } from '@/lib/metrics/anomaly'
import { percentileSorted, round, spearman } from '@/lib/metrics/stats'

/**
 * Does the thermal layer discriminate between places, and does it do so
 * consistently?
 *
 * This is the gate that decides whether a thermal product may be claimed at all.
 * It runs in one of two modes:
 *
 * - **Absolute** applies when the returned metric is a confirmed Celsius
 *   temperature. It keeps the thresholds the spike established: an
 *   interpercentile spread of at least 1.5 °C on two or more snapshots.
 * - **Relative** applies to anything else, or to °C values whose field and unit
 *   have not been confirmed by a capability probe. Reusing a degree threshold on
 *   an unconfirmed or non-temperature metric would be meaningless, so the test
 *   becomes scale-free: the spread must reach 15% of the observed median.
 */

export type ThermalGateOutcome =
  | 'GO_THERMAL_SIGNAL'
  | 'GO_CONDITIONAL_FACTOR_ONLY'
  | 'NO_GO_THERMAL_SIGNAL'
  | 'BLOCKED_LIVE'

export interface ThermalGateReport {
  outcome: ThermalGateOutcome
  mode: 'absolute_celsius' | 'relative' | 'blocked'
  unit: string | null
  /** Share of stops in the area that received a temperature. */
  stopCoverage: number
  cellsReturned: number
  snapshots: Array<{ snapshot: string; cells: number; spread: number | null }>
  strongSnapshots: number
  medianRankCorrelation: number | null
  thresholds: Record<string, number>
  reasons: string[]
}

const MIN_STOP_COVERAGE = 0.9
const MIN_CELLS = 8
const ABSOLUTE_SPREAD_C = 1.5
const CONDITIONAL_SPREAD_C = 0.75
/**
 * FortyGuard's documented default for its exceedance and persistence analytics.
 * This is a product reference, not a health threshold. When an entire confirmed
 * Celsius surface is above it, spatial uniformity does not make heat irrelevant:
 * the surface may condition a transit-burden ranking, but may not claim hotspots.
 */
const CONDITIONAL_ABSOLUTE_TEMPERATURE_C = 30
const RELATIVE_SPREAD_RATIO = 0.15
const CONDITIONAL_RELATIVE_RATIO = 0.075
const MIN_STRONG_SNAPSHOTS = 2
const MIN_RANK_CORRELATION = 0.6

export function evaluateThermalGate(options: {
  layer: Pick<ThermalLayer, 'dataMode' | 'unit' | 'analyticType' | 'snapshots'>
  anomaliesBySnapshot: ReadonlyMap<string, readonly CellAnomaly[]>
  stopsTotal: number
  stopsWithTemperature: number
  unitConfirmed: boolean
}): ThermalGateReport {
  const { layer, anomaliesBySnapshot, stopsTotal, stopsWithTemperature, unitConfirmed } = options
  const reasons: string[] = []

  if (layer.dataMode === 'BLOCKED_LIVE') {
    return {
      outcome: 'BLOCKED_LIVE',
      mode: 'blocked',
      unit: layer.unit,
      stopCoverage: 0,
      cellsReturned: 0,
      snapshots: [],
      strongSnapshots: 0,
      medianRankCorrelation: null,
      thresholds: {},
      reasons: ['No thermal layer was obtained. The live path was never executed.'],
    }
  }

  const absolute = unitConfirmed && layer.analyticType === 'tcm'
  if (!absolute && layer.analyticType === 'tcm') {
    reasons.push(
      'Celsius thresholds withheld: the value field and unit were not confirmed by a capability probe.',
    )
  }

  const snapshots = [...anomaliesBySnapshot.keys()].sort()
  const stopCoverage = stopsTotal > 0 ? stopsWithTemperature / stopsTotal : 0
  const cellsReturned = snapshots.reduce(
    (sum, snapshot) => sum + (anomaliesBySnapshot.get(snapshot)?.length ?? 0),
    0,
  )

  const perSnapshot = snapshots.map((snapshot) => {
    const values = (anomaliesBySnapshot.get(snapshot) ?? []).map((entry) => entry.value)
    values.sort((a, b) => a - b)
    const p90 = percentileSorted(values, 0.9)
    const p10 = percentileSorted(values, 0.1)
    return {
      snapshot,
      cells: values.length,
      spread: p90 !== null && p10 !== null ? round(p90 - p10, 3) : null,
    }
  })

  const medians = snapshots.map((snapshot) => {
    const values = (anomaliesBySnapshot.get(snapshot) ?? []).map((entry) => entry.value)
    values.sort((a, b) => a - b)
    return percentileSorted(values, 0.5) ?? 0
  })
  const overallMedian = medians.length
    ? medians.reduce((sum, value) => sum + value, 0) / medians.length
    : 0
  const absoluteHeatContext =
    absolute &&
    medians.length > 0 &&
    medians.every((median) => median >= CONDITIONAL_ABSOLUTE_TEMPERATURE_C)

  const strongThreshold = absolute
    ? ABSOLUTE_SPREAD_C
    : Math.abs(overallMedian) * RELATIVE_SPREAD_RATIO
  const conditionalThreshold = absolute
    ? CONDITIONAL_SPREAD_C
    : Math.abs(overallMedian) * CONDITIONAL_RELATIVE_RATIO

  const strongSnapshots = perSnapshot.filter(
    (entry) => entry.spread !== null && entry.spread >= strongThreshold,
  ).length
  const maxSpread = perSnapshot.reduce(
    (best, entry) => (entry.spread !== null && entry.spread > best ? entry.spread : best),
    0,
  )

  /* --- spatial rank stability between snapshots, matched on position ------ */
  const byPosition = new Map<string, Map<string, number>>()
  for (const snapshot of snapshots) {
    for (const entry of anomaliesBySnapshot.get(snapshot) ?? []) {
      const key = `${entry.lon.toFixed(5)}|${entry.lat.toFixed(5)}`
      const row = byPosition.get(key) ?? new Map<string, number>()
      row.set(snapshot, entry.value)
      byPosition.set(key, row)
    }
  }

  const correlations: number[] = []
  for (let i = 0; i < snapshots.length; i += 1) {
    for (let j = i + 1; j < snapshots.length; j += 1) {
      const left: number[] = []
      const right: number[] = []
      for (const row of byPosition.values()) {
        const a = row.get(snapshots[i]!)
        const b = row.get(snapshots[j]!)
        if (a !== undefined && b !== undefined) {
          left.push(a)
          right.push(b)
        }
      }
      const value = spearman(left, right)
      if (value !== null) correlations.push(value)
    }
  }
  correlations.sort((a, b) => a - b)
  const medianRankCorrelation =
    correlations.length === 0
      ? null
      : correlations.length % 2 === 1
        ? (correlations[(correlations.length - 1) / 2] ?? null)
        : ((correlations[correlations.length / 2 - 1] ?? 0) +
            (correlations[correlations.length / 2] ?? 0)) / 2

  const coverageOk = stopCoverage >= MIN_STOP_COVERAGE
  const cellsOk = cellsReturned >= MIN_CELLS
  const stable = medianRankCorrelation !== null && medianRankCorrelation >= MIN_RANK_CORRELATION

  if (!coverageOk) {
    reasons.push(
      `Only ${(stopCoverage * 100).toFixed(1)}% of stops received a temperature (minimum ${MIN_STOP_COVERAGE * 100}%).`,
    )
  }
  if (!cellsOk) reasons.push(`Only ${cellsReturned} cells were returned (minimum ${MIN_CELLS}).`)
  if (strongSnapshots < MIN_STRONG_SNAPSHOTS) {
    reasons.push(
      `Spread reached the strong threshold on ${strongSnapshots} snapshot(s); ${MIN_STRONG_SNAPSHOTS} required.`,
    )
  }
  if (!stable) {
    reasons.push(
      medianRankCorrelation === null
        ? 'Rank correlation could not be computed across snapshots.'
        : `Median rank correlation ${medianRankCorrelation.toFixed(2)} is below ${MIN_RANK_CORRELATION}.`,
    )
  }

  let outcome: ThermalGateOutcome
  if (coverageOk && cellsOk && strongSnapshots >= MIN_STRONG_SNAPSHOTS && stable) {
    outcome = 'GO_THERMAL_SIGNAL'
  } else if (
    coverageOk &&
    cellsOk &&
    (maxSpread >= conditionalThreshold || absoluteHeatContext)
  ) {
    outcome = 'GO_CONDITIONAL_FACTOR_ONLY'
    reasons.push(
      absoluteHeatContext && maxSpread < conditionalThreshold
        ? `Every snapshot median was at least ${CONDITIONAL_ABSOLUTE_TEMPERATURE_C} °C. ` +
            'The confirmed absolute heat may condition the transit-burden axis, but weak spatial ' +
            'differentiation cannot support a hotspot or local-anomaly claim.'
        : 'Heat is usable as a secondary factor only.',
    )
  } else {
    outcome = 'NO_GO_THERMAL_SIGNAL'
  }

  return {
    outcome,
    mode: absolute ? 'absolute_celsius' : 'relative',
    unit: layer.unit,
    stopCoverage: round(stopCoverage, 4),
    cellsReturned,
    snapshots: perSnapshot,
    strongSnapshots,
    medianRankCorrelation:
      medianRankCorrelation === null ? null : round(medianRankCorrelation, 3),
    thresholds: {
      minStopCoverage: MIN_STOP_COVERAGE,
      minCells: MIN_CELLS,
      strongSpread: round(strongThreshold, 3),
      conditionalSpread: round(conditionalThreshold, 3),
      conditionalAbsoluteTemperatureC: CONDITIONAL_ABSOLUTE_TEMPERATURE_C,
      minStrongSnapshots: MIN_STRONG_SNAPSHOTS,
      minRankCorrelation: MIN_RANK_CORRELATION,
    },
    reasons,
  }
}
