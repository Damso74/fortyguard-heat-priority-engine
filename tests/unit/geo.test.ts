import { describe, expect, it } from 'vitest'
import type { AreaOfInterest } from '@/lib/types'
import { AREAS_OF_INTEREST, getAoi } from '@/lib/geo/aoi'
import { planTiles, tileToPolygonAoi, verifyCoverage } from '@/lib/geo/tiles'
import {
  bboxAreaSqMiles,
  bboxContains,
  haversineMeters,
  pointInRing,
  ringCentroid,
} from '@/lib/geo/measure'

/* -------------------------------------------------------------------------- */
/* Measurement                                                                */
/* -------------------------------------------------------------------------- */

describe('measurement helpers', () => {
  it('computes known distances', () => {
    // One degree of latitude is very close to 111.2 km.
    expect(haversineMeters({ lat: 33, lon: -112 }, { lat: 34, lon: -112 })).toBeCloseTo(111_195, -2)
    expect(haversineMeters({ lat: 33.45, lon: -112 }, { lat: 33.45, lon: -112 })).toBe(0)
  })

  it('detects points inside and outside a ring', () => {
    const square: Array<[number, number]> = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
      [0, 0],
    ]
    expect(pointInRing(0.5, 0.5, square)).toBe(true)
    expect(pointInRing(1.5, 0.5, square)).toBe(false)
    expect(pointInRing(-0.1, 0.5, square)).toBe(false)
    expect(pointInRing(0.5, 1.5, square)).toBe(false)
    expect(pointInRing(0.5, 0.5, [[0, 0]])).toBe(false)
  })

  it('computes a ring centroid', () => {
    const square: Array<[number, number]> = [
      [0, 0],
      [2, 0],
      [2, 2],
      [0, 2],
      [0, 0],
    ]
    const centroid = ringCentroid(square)
    expect(centroid.lon).toBeCloseTo(1, 9)
    expect(centroid.lat).toBeCloseTo(1, 9)
  })

  it('tests bbox containment inclusively', () => {
    const bbox = { minLon: -1, minLat: -1, maxLon: 1, maxLat: 1 }
    expect(bboxContains(bbox, { lat: 0, lon: 0 })).toBe(true)
    expect(bboxContains(bbox, { lat: 1, lon: 1 })).toBe(true)
    expect(bboxContains(bbox, { lat: 1.0001, lon: 0 })).toBe(false)
  })
})

/* -------------------------------------------------------------------------- */
/* Tiling                                                                     */
/* -------------------------------------------------------------------------- */

describe('AOI tiling', () => {
  it('keeps every tile under the ceiling', () => {
    for (const aoi of AREAS_OF_INTEREST) {
      for (const ceiling of [9, 5, 2]) {
        const plan = planTiles(aoi, ceiling)
        expect(plan.tiles.length).toBeGreaterThan(0)
        for (const tile of plan.tiles) {
          expect(tile.areaSqMi, `${aoi.id} @ ${ceiling}`).toBeLessThanOrEqual(ceiling + 1e-9)
        }
      }
    }
  })

  it('covers the AOI with no gap and no overlap', () => {
    for (const aoi of AREAS_OF_INTEREST) {
      const plan = planTiles(aoi, 9)
      expect(plan.coversAoi, aoi.id).toBe(true)
      expect(verifyCoverage(aoi.bbox, plan.tiles)).toBe(true)
    }
  })

  it('detects a hole punched in the plan', () => {
    const aoi = getAoi('central-phoenix')
    const plan = planTiles(aoi, 9)
    const withHole = plan.tiles.filter((_, index) => index !== 1)
    expect(verifyCoverage(aoi.bbox, withHole)).toBe(false)
    expect(verifyCoverage(aoi.bbox, [])).toBe(false)
  })

  it('detects a tile that has been shrunk away from its neighbour', () => {
    const aoi = getAoi('central-phoenix')
    const plan = planTiles(aoi, 9)
    const first = plan.tiles[0]!
    const shifted = [
      { ...first, bbox: { ...first.bbox, maxLon: first.bbox.maxLon - 0.001 } },
      ...plan.tiles.slice(1),
    ]
    expect(verifyCoverage(aoi.bbox, shifted)).toBe(false)
  })

  it('rejects the spike’s single 34.9 mi² polygon at the conservative ceiling', () => {
    // The spike submitted the whole panel bbox as one request. Under a 9 mi²
    // ceiling that must become several tiles, never one.
    const plan = planTiles(getAoi('central-phoenix'), 9)
    expect(plan.aoiAreaSqMi).toBeGreaterThan(30)
    expect(plan.tiles.length).toBeGreaterThanOrEqual(5)
  })

  it('emits a closed polygon ring in the API request shape', () => {
    const plan = planTiles(getAoi('central-phoenix'), 9)
    const payload = tileToPolygonAoi(plan.tiles[0]!)
    const ring = payload.features[0]!.geometry.coordinates[0]!
    expect(payload.type).toBe('FeatureCollection')
    expect(ring).toHaveLength(5)
    expect(ring[0]).toEqual(ring[4])
  })

  it('rejects a nonsensical ceiling', () => {
    const aoi = getAoi('central-phoenix')
    expect(() => planTiles(aoi, 0)).toThrow(/positive finite/)
    expect(() => planTiles(aoi, Number.NaN)).toThrow(/positive finite/)
  })

  it('rejects an empty area of interest', () => {
    const empty: AreaOfInterest = {
      id: 'empty',
      label: 'Empty',
      description: '',
      bbox: { minLon: 0, minLat: 0, maxLon: 0, maxLat: 0 },
      thermalGranularityMeters: 60,
    }
    expect(() => planTiles(empty, 9)).toThrow(/empty bounding box/)
  })

  it('sizes Central Phoenix into a demonstrable number of requests', () => {
    const plan = planTiles(getAoi('central-phoenix'), 9)
    expect(plan.tiles.length).toBeLessThanOrEqual(8)
    expect(bboxAreaSqMiles(getAoi('central-phoenix').bbox)).toBeGreaterThan(35)
  })
})

/* -------------------------------------------------------------------------- */
/* Zones                                                                      */
