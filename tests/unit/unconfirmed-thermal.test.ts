import { describe, expect, it } from 'vitest'
import { executeRun } from '@/lib/agent/run'
import { serverEnv } from '@/lib/config/server-env'
import type { ThermalLayer } from '@/lib/types'

/**
 * On a REAL layer with an unconfirmed unit, the thermal arithmetic does not run.
 *
 * Masking the result afterwards was not enough, and the difference is not
 * cosmetic. `max(0, T − 30)` subtracts a Celsius constant from a number of
 * unknown scale, and the 30/35/40 sweep does it three times. Whatever came out
 * was still computed, still summed into an envelope, and still reachable as
 * `exposureObserved`, `temperatureC`, `excessC` and `meanExcessC` — a set of
 * fully-populated columns with no unit behind any of them, on a screen whose
 * banner said "cached real data".
 *
 * The shipped manifest confirms nothing, so a real layer here is exactly the
 * unconfirmed case.
 */

/** A layer that claims to be a real capture. Values are arbitrary by construction. */
function realLayer(): ThermalLayer {
  const snapshots = ['2026-08-03T11:00', '2026-08-03T14:00', '2026-08-03T17:00']
  const cells = snapshots.flatMap((snapshot) => Array.from({ length: 40 }, (_unused, index) => {
    const lon = -112.09 + (index % 8) * 0.004
    const lat = 33.44 + Math.floor(index / 8) * 0.004
    return {
      id: `cell-${index}`,
      centroidLon: lon,
      centroidLat: lat,
      ring: [
        [lon - 0.002, lat - 0.002],
        [lon + 0.002, lat - 0.002],
        [lon + 0.002, lat + 0.002],
        [lon - 0.002, lat + 0.002],
        [lon - 0.002, lat - 0.002],
      ] as Array<[number, number]>,
      // Deliberately in the range a Celsius reading would occupy, which is the
      // whole problem: nothing about the number says what it is.
      value: 38 + (index % 11) * 0.9,
      snapshot,
    }
  }))
  return {
    dataMode: 'CACHED_REAL_DATA',
    provenance: 'REAL',
    unit: null,
    valueField: 'tcm',
    analyticType: 'tcm',
    granularityMeters: 60,
    snapshots,
    timezone: 'America/Phoenix',
    cells,
    label: 'CACHED REAL DATA',
    sourceNotes: [],
  }
}

const REQUEST = {
  aoiId: 'central-phoenix',
  capacity: 10,
  analysisDate: '2026-08-03',
  snapshotTimes: ['11:00', '14:00', '17:00'],
}

const OPTIONS = {
  now: () => new Date('2026-08-04T12:00:00Z'),
  env: { ...serverEnv(), DATA_MODE: 'demo' as const },
}

describe('an unconfirmed real layer produces no thermal quantity at all', () => {
  it('computes no exposure, no excess and no reference-temperature arithmetic', async () => {
    const run = await executeRun(REQUEST, { ...OPTIONS, thermalLayer: realLayer() })

    expect(run.manifest.dataMode).toBe('CACHED_REAL_DATA')
    expect(run.methodology.exposure.celsiusReadingPermitted).toBe(false)

    for (const result of run.results) {
      // The masked value AND the observed one. `exposureObserved` existed so
      // nothing was hidden; on an unconfirmed layer there is nothing to hide,
      // because nothing was computed.
      expect(result.exposure).toBeNull()
      expect(result.exposureObserved).toBeNull()
      expect(result.meanExcessC).toBeNull()
      expect(result.envelopeLow).toBeNull()
      expect(result.envelopeHigh).toBeNull()
      for (const hour of result.hourly) {
        expect(hour.temperatureC).toBeNull()
        expect(hour.excessC).toBeNull()
        expect(hour.exposure).toBeNull()
      }
    }
  }, 120_000)

  it('drops the exposure axis from the evidence rather than labelling it', async () => {
    const run = await executeRun(REQUEST, { ...OPTIONS, thermalLayer: realLayer() })
    expect(run.manifest.axes.exposure).toBe(false)
    expect(run.manifest.evidenceMode).not.toBe('HEAT_EXPOSURE_AND_ANOMALY')
    expect(run.manifest.blockingReasons.join(' ')).toMatch(/capability probe has not confirmed/)
  }, 120_000)

  it('also withholds the anomaly axis, because the field is not confirmed to be heat', async () => {
    const run = await executeRun(REQUEST, { ...OPTIONS, thermalLayer: realLayer() })
    // Neither axis survives an entirely unconfirmed capability, so the run offers
    // no ranked recommendation at all.
    expect(run.manifest.axes.anomaly).toBe(false)
    expect(run.manifest.mode).toBe('NO_GO_THERMAL_PRODUCT')
    expect(run.plan.selectedIds).toEqual([])
    expect(run.plan.headline).toMatch(/NO RANKED RECOMMENDATION/)
    expect(run.manifest.blockingReasons.join(' ')).toMatch(
      /Scale-invariance is not evidence that the data is heat/,
    )
  }, 120_000)

  it('still runs the whole product on the labelled synthetic fixture', async () => {
    // The fixture claims nothing about the API and says `°C (synthetic)`
    // everywhere, so it is exempt — otherwise the demo would be unreachable and
    // the honesty rule would have removed the thing it was protecting.
    const run = await executeRun(REQUEST, OPTIONS)
    expect(run.manifest.dataMode).toBe('DEMO_SYNTHETIC')
    expect(run.methodology.exposure.thermalUnitLabel).toBe('°C (synthetic)')
    expect(run.results.some((result) => result.exposure !== null)).toBe(true)
  }, 120_000)
})
