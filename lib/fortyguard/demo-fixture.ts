import type { AreaOfInterest, ThermalCell, ThermalLayer } from '@/lib/types'
import { GRID_REFERENCE_LATITUDE, metersPerDegreeLat, metersPerDegreeLon } from '@/lib/geo/measure'
import {
  buildThermalSnapshot,
  type ThermalSnapshot,
  type ThermalSnapshotRequest,
} from './snapshot'

/**
 * Explicitly synthetic thermal layer.
 *
 * This exists so the engine, the interface and the whole demo path stay
 * exercisable while no FortyGuard key is available. Three rules govern it:
 *
 * 1. it is never presented as a measurement. Every surface that renders it is
 *    fed `dataMode: 'DEMO_SYNTHETIC'` and `provenance: 'SYNTHETIC'`, and the
 *    application shows a permanent banner, not a tooltip;
 * 2. it is fully deterministic — an integer hash lattice, no `Math.random` — so
 *    two runs of the demo produce identical rankings and the tests can assert
 *    exact values;
 * 3. it is a *plausible shape*, not a copy of any real measurement: a smooth
 *    urban-heat-island bump over downtown plus a correlated surface-texture
 *    field. It intentionally does not claim to reproduce Phoenix conditions on
 *    any particular date.
 *
 * The values are in °C-like units so the documented `tcm` gate thresholds can be
 * exercised end to end. They are labelled `°C (synthetic)` everywhere.
 */

export const SYNTHETIC_UNIT = '°C (synthetic)'
export const SYNTHETIC_VALUE_FIELD = 'tcm'
export const SYNTHETIC_GRANULARITY_METERS = 100

/** Downtown Phoenix, used as the centre of the modelled heat-island bump. */
const UHI_CENTER = { lon: -112.0740, lat: 33.4484 }

/** Baseline value per snapshot hour. Chosen to look like an August afternoon. */
const HOURLY_BASELINE: Record<string, number> = {
  '11:00': 38.2,
  '12:00': 40.4,
  '13:00': 42.3,
  '14:00': 43.6,
  '15:00': 43.9,
  '16:00': 42.8,
  '17:00': 41.2,
  '18:00': 39.6,
}

const DEFAULT_BASELINE = 40.0

/** 32-bit integer hash. Deterministic across platforms and Node versions. */
function hash2(x: number, y: number, seed: number): number {
  let h = (x | 0) * 374761393 + (y | 0) * 668265263 + seed * 2246822519
  h = (h ^ (h >>> 13)) >>> 0
  h = Math.imul(h, 1274126177) >>> 0
  return (h ^ (h >>> 16)) >>> 0
}

/** Hash to the unit interval. */
function unit(x: number, y: number, seed: number): number {
  return hash2(x, y, seed) / 4294967295
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t)
}

/** Bilinear value noise over an integer lattice — smooth, seeded, reproducible. */
function valueNoise(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const tx = smoothstep(x - x0)
  const ty = smoothstep(y - y0)
  const v00 = unit(x0, y0, seed)
  const v10 = unit(x0 + 1, y0, seed)
  const v01 = unit(x0, y0 + 1, seed)
  const v11 = unit(x0 + 1, y0 + 1, seed)
  const top = v00 + (v10 - v00) * tx
  const bottom = v01 + (v11 - v01) * tx
  return top + (bottom - top) * ty
}

const LON_M = metersPerDegreeLon(GRID_REFERENCE_LATITUDE)
const LAT_M = metersPerDegreeLat()

/**
 * Sparse, spatially fixed hot patches.
 *
 * These stand in for what a hyperlocal sensor actually finds and a coarse
 * gridded product cannot: a bare asphalt junction, a large parking apron, a
 * west-facing wall. They are what metric B is designed to detect, so the fixture
 * would be useless without them — a purely smooth field has no local anomalies
 * to find, and the validation step would have nothing to validate.
 *
 * They are deterministic and **spatially fixed across snapshots**, which is what
 * makes the out-of-sample persistence check meaningful: a real anomaly is still
 * there at 17:00, and this one is too.
 */
function hotPatch(lon: number, lat: number): number {
  // 250 m lattice; roughly 4% of cells anchor a patch.
  const px = (lon * LON_M) / 250
  const py = (lat * LAT_M) / 250
  const cx = Math.round(px)
  const cy = Math.round(py)

  let total = 0
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      const gx = cx + dx
      const gy = cy + dy
      if (unit(gx, gy, 4242) > 0.96) {
        // Amplitude 1.8-3.4 °C, decaying over ~120 m.
        const amplitude = 1.8 + unit(gx, gy, 99991) * 1.6
        const distance = Math.hypot((px - gx) * 250, (py - gy) * 250)
        total += amplitude * Math.exp(-((distance / 120) ** 2))
      }
    }
  }
  return total
}

/** The synthetic field, in °C-like units, at one point and one snapshot hour. */
export function syntheticValueAt(lon: number, lat: number, hour: string): number {
  const baseline = HOURLY_BASELINE[hour] ?? DEFAULT_BASELINE

  const dxKm = ((lon - UHI_CENTER.lon) * LON_M) / 1000
  const dyKm = ((lat - UHI_CENTER.lat) * LAT_M) / 1000
  const distanceKm = Math.hypot(dxKm, dyKm)
  // Urban heat island bump: +2.9 °C at the core, decaying over ~5 km.
  const island = 2.9 * Math.exp(-((distanceKm / 5.0) ** 2))

  // Correlated surface texture, ~600 m correlation length. Stands in for the
  // impervious-surface and canopy variation a real sensor would pick up.
  const nx = (lon * LON_M) / 600
  const ny = (lat * LAT_M) / 600
  const texture = (valueNoise(nx, ny, 1337) - 0.5) * 3.2

  // Finer detail at ~150 m so neighbouring cells are not identical.
  const fx = (lon * LON_M) / 150
  const fy = (lat * LAT_M) / 150
  const detail = (valueNoise(fx, fy, 7919) - 0.5) * 0.8

  return Math.round((baseline + island + texture + detail + hotPatch(lon, lat)) * 100) / 100
}

/**
 * Build the synthetic layer for an AOI.
 *
 * Cells are emitted on the same 100 m lattice a real `granularity: 100` request
 * would use, but only where the caller says decision units exist, so a
 * city-wide AOI does not allocate a hundred thousand unused cells.
 */
export function buildDemoThermalLayer(options: {
  aoi: AreaOfInterest
  snapshotTimes: string[]
  analysisDate: string
  timezone: string
  /** Restrict emission to these bounding boxes (usually the zone squares). */
  regions?: Array<{ minLon: number; minLat: number; maxLon: number; maxLat: number }>
}): ThermalLayer {
  const { aoi, snapshotTimes, analysisDate, timezone } = options
  const lonStep = SYNTHETIC_GRANULARITY_METERS / LON_M
  const latStep = SYNTHETIC_GRANULARITY_METERS / LAT_M

  const regions = options.regions?.length ? options.regions : [aoi.bbox]
  const cells: ThermalCell[] = []
  const snapshots: string[] = []

  for (const hour of snapshotTimes) {
    const snapshot = `${analysisDate}T${hour}`
    snapshots.push(snapshot)
    const seen = new Set<string>()

    for (const region of regions) {
      const startCol = Math.floor(region.minLon / lonStep)
      const endCol = Math.ceil(region.maxLon / lonStep)
      const startRow = Math.floor(region.minLat / latStep)
      const endRow = Math.ceil(region.maxLat / latStep)

      for (let row = startRow; row < endRow; row += 1) {
        for (let col = startCol; col < endCol; col += 1) {
          const key = `${col}:${row}`
          if (seen.has(key)) continue
          seen.add(key)

          const minLon = col * lonStep
          const maxLon = (col + 1) * lonStep
          const minLat = row * latStep
          const maxLat = (row + 1) * latStep
          const centroidLon = (minLon + maxLon) / 2
          const centroidLat = (minLat + maxLat) / 2
          if (
            centroidLon < aoi.bbox.minLon ||
            centroidLon > aoi.bbox.maxLon ||
            centroidLat < aoi.bbox.minLat ||
            centroidLat > aoi.bbox.maxLat
          ) {
            continue
          }

          cells.push({
            id: `${snapshot}|${col}|${row}`,
            centroidLon,
            centroidLat,
            ring: [
              [minLon, minLat],
              [maxLon, minLat],
              [maxLon, maxLat],
              [minLon, maxLat],
              [minLon, minLat],
            ],
            value: syntheticValueAt(centroidLon, centroidLat, hour),
            snapshot,
          })
        }
      }
    }
  }

  return {
    dataMode: 'DEMO_SYNTHETIC',
    provenance: 'SYNTHETIC',
    unit: SYNTHETIC_UNIT,
    valueField: SYNTHETIC_VALUE_FIELD,
    analyticType: 'tcm',
    granularityMeters: SYNTHETIC_GRANULARITY_METERS,
    snapshots,
    timezone,
    cells,
    label: 'DEMO — SYNTHETIC',
    sourceNotes: [
      'These values were generated by lib/fortyguard/demo-fixture.ts. They are not measurements.',
      'No FortyGuard API call produced any number on this screen.',
      'The field is a deterministic urban-heat-island bump, correlated surface texture, and ' +
        'sparse fixed hot patches — built so the engine, both metrics and the interface can be ' +
        'exercised without a key.',
      'Rankings produced in this mode are a demonstration of the method, not a finding about Phoenix.',
    ],
  }
}

/**
 * The fixture is an explicitly synthetic **snapshot**, not a loose bag of cells.
 *
 * Two reasons it is expressed in the same structure a real capture uses.
 *
 * First, the run id is derived from a snapshot's **attestation** digest, and a
 * synthetic run needs one too — otherwise a fixture run and a real run of the
 * same request could share an id, and an export could not be checked against the
 * numbers behind it.
 *
 * Second, it forces the fixture through exactly the fields a real capture must
 * fill: mode, provenance, activity ids (none), unit confirmation (false),
 * timezone strategy, and capture metadata. There is no shape a synthetic layer
 * can take that a reader might mistake for a measurement, because it is the same
 * shape and every field says what it is.
 *
 * Nothing about it is written to the production snapshot store — that store holds
 * real captures only, and `writeThermalSnapshot` refuses anything else. This
 * object exists in memory for the duration of a run.
 *
 * `capturedAtUtc` is derived from the analysis date rather than the clock, and the
 * fingerprint is the literal string `synthetic`, so the digest — and therefore the
 * run id — is stable across runs, machines and capability-manifest edits. A
 * synthetic layer is not read under the API's answers, so it must not move when
 * they change.
 */
export const SYNTHETIC_CAPABILITY_FINGERPRINT = 'synthetic'

export function buildDemoThermalSnapshot(options: {
  aoi: AreaOfInterest
  request: ThermalSnapshotRequest
  layer: ThermalLayer
}): ThermalSnapshot {
  const { request, layer } = options
  return buildThermalSnapshot({
    request,
    source: {
      dataMode: 'DEMO_SYNTHETIC',
      provenance: 'SYNTHETIC',
      activityIds: [],
      valueField: SYNTHETIC_VALUE_FIELD,
      unit: SYNTHETIC_UNIT,
      unitConfirmed: false,
      semanticsConfirmed: false,
      timezoneStrategy: 'send_local_wallclock_unconverted',
      timezoneStrategyApplied: false,
      capabilityProbeRunId: null,
      capabilityFingerprint: SYNTHETIC_CAPABILITY_FINGERPRINT,
      capture: {
        capturedAtUtc: `${request.analysisDate}T00:00:00.000Z`,
        captureToolVersion: 'lib/fortyguard/demo-fixture.ts',
        tileCount: 0,
        submissionCount: 0,
        timestamps: request.snapshotTimes.map((time) => ({
          requestedLocalDate: request.analysisDate,
          requestedLocalTime: time,
          requestedLocalIso: `${request.analysisDate}T${time}:00-07:00`,
          transmittedDate: request.analysisDate,
          transmittedTime: time,
          transmittedIsoUtc: `${request.analysisDate}T${time}:00.000Z`,
        })),
      },
      notes: [...layer.sourceNotes],
    },
    cells: layer.cells,
  })
}
