import { describe, expect, it } from 'vitest'
import { evaluateThermalGate } from '@/lib/gates/thermal-gate'
import type { CellAnomaly } from '@/lib/metrics/anomaly'

function surface(snapshot: string, base: number): CellAnomaly[] {
  return Array.from({ length: 12 }, (_, index) => ({
    cellId: `${snapshot}-${index}`,
    snapshot,
    lon: -112.07 + index * 0.0001,
    lat: 33.45,
    value: base + index * 0.001,
    backgroundC: base,
    scaleC: 0.01,
    z: index / 10,
    neighbours: 11,
  }))
}

describe('thermal gate for spatially uniform absolute heat', () => {
  it('permits confirmed heat only as a conditional factor when every snapshot is above 30 °C', () => {
    const snapshots = ['2024-07-15T08:00', '2024-07-15T14:00', '2024-07-15T20:00']
    const anomalies = new Map(snapshots.map((snapshot, index) => [snapshot, surface(snapshot, 34 + index * 2)]))

    const report = evaluateThermalGate({
      layer: {
        dataMode: 'CACHED_REAL_DATA',
        unit: '°C',
        analyticType: 'tcm',
        snapshots,
      },
      anomaliesBySnapshot: anomalies,
      stopsTotal: 10,
      stopsWithTemperature: 10,
      unitConfirmed: true,
    })

    expect(report.outcome).toBe('GO_CONDITIONAL_FACTOR_ONLY')
    expect(report.reasons.join(' ')).toMatch(/cannot support a hotspot or local-anomaly claim/)
  })

  it('still refuses a uniform surface below the documented reference', () => {
    const snapshots = ['2024-07-15T08:00', '2024-07-15T14:00']
    const anomalies = new Map(snapshots.map((snapshot) => [snapshot, surface(snapshot, 24)]))

    const report = evaluateThermalGate({
      layer: {
        dataMode: 'CACHED_REAL_DATA',
        unit: '°C',
        analyticType: 'tcm',
        snapshots,
      },
      anomaliesBySnapshot: anomalies,
      stopsTotal: 10,
      stopsWithTemperature: 10,
      unitConfirmed: true,
    })

    expect(report.outcome).toBe('NO_GO_THERMAL_SIGNAL')
  })
})
