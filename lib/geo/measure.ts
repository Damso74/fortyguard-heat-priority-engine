/**
 * Small, dependency-free geodesy helpers.
 *
 * Everything here is deliberately explicit about its approximation so the
 * numbers shown in the UI can be described honestly:
 *
 * - distances use the haversine formula on a spherical Earth (R = 6371.0088 km),
 *   which is accurate to well under a metre at city scale;
 * - areas use a local equirectangular approximation evaluated at the shape's
 *   mid-latitude. Over a Phoenix-sized rectangle the error is a fraction of a
 *   percent, which is why every tile is sized against a ceiling with headroom
 *   rather than against the plan limit exactly.
 */

import type { BoundingBox } from '@/lib/types'

export const EARTH_RADIUS_METERS = 6_371_008.8
export const SQ_METERS_PER_SQ_MILE = 2_589_988.110336

/** Reference latitude used to anchor the analysis grid. Phoenix city centre. */
export const GRID_REFERENCE_LATITUDE = 33.45

export function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180
}

export function haversineMeters(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const lat1 = toRadians(a.lat)
  const lat2 = toRadians(b.lat)
  const dLat = lat2 - lat1
  const dLon = toRadians(b.lon - a.lon)
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** Metres per degree of latitude. Constant enough at city scale. */
export function metersPerDegreeLat(): number {
  return (Math.PI / 180) * EARTH_RADIUS_METERS
}

/** Metres per degree of longitude at a given latitude. */
export function metersPerDegreeLon(latitude: number): number {
  return (Math.PI / 180) * EARTH_RADIUS_METERS * Math.cos(toRadians(latitude))
}

export function bboxMidLatitude(bbox: BoundingBox): number {
  return (bbox.minLat + bbox.maxLat) / 2
}

export function bboxWidthMeters(bbox: BoundingBox): number {
  return (bbox.maxLon - bbox.minLon) * metersPerDegreeLon(bboxMidLatitude(bbox))
}

export function bboxHeightMeters(bbox: BoundingBox): number {
  return (bbox.maxLat - bbox.minLat) * metersPerDegreeLat()
}

export function bboxAreaSqMeters(bbox: BoundingBox): number {
  return Math.abs(bboxWidthMeters(bbox) * bboxHeightMeters(bbox))
}

export function bboxAreaSqMiles(bbox: BoundingBox): number {
  return bboxAreaSqMeters(bbox) / SQ_METERS_PER_SQ_MILE
}

export function bboxContains(bbox: BoundingBox, point: { lat: number; lon: number }): boolean {
  return (
    point.lon >= bbox.minLon &&
    point.lon <= bbox.maxLon &&
    point.lat >= bbox.minLat &&
    point.lat <= bbox.maxLat
  )
}

export function bboxRing(bbox: BoundingBox): Array<[number, number]> {
  return [
    [bbox.minLon, bbox.minLat],
    [bbox.maxLon, bbox.minLat],
    [bbox.maxLon, bbox.maxLat],
    [bbox.minLon, bbox.maxLat],
    [bbox.minLon, bbox.minLat],
  ]
}

export function bboxCentroid(bbox: BoundingBox): { lat: number; lon: number } {
  return {
    lat: (bbox.minLat + bbox.maxLat) / 2,
    lon: (bbox.minLon + bbox.maxLon) / 2,
  }
}

/** Ray-casting point-in-ring test. Rings may be open or closed. */
export function pointInRing(
  lon: number,
  lat: number,
  ring: ReadonlyArray<readonly [number, number]>,
): boolean {
  let inside = false
  const count = ring.length
  if (count < 3) return false
  for (let i = 0, j = count - 1; i < count; j = i++) {
    const current = ring[i]
    const previous = ring[j]
    if (!current || !previous) continue
    const [xi, yi] = current
    const [xj, yj] = previous
    if (yi > lat !== yj > lat) {
      const crossing = ((xj - xi) * (lat - yi)) / (yj - yi) + xi
      if (lon < crossing) inside = !inside
    }
  }
  return inside
}

/** Polygon ring centroid (area-weighted). Falls back to the vertex mean. */
export function ringCentroid(
  ring: ReadonlyArray<readonly [number, number]>,
): { lon: number; lat: number } {
  let twiceArea = 0
  let x = 0
  let y = 0
  const count = ring.length
  for (let i = 0, j = count - 1; i < count; j = i++) {
    const current = ring[i]
    const previous = ring[j]
    if (!current || !previous) continue
    const cross = previous[0] * current[1] - current[0] * previous[1]
    twiceArea += cross
    x += (previous[0] + current[0]) * cross
    y += (previous[1] + current[1]) * cross
  }
  if (Math.abs(twiceArea) < 1e-12) {
    let sumX = 0
    let sumY = 0
    let seen = 0
    for (const vertex of ring) {
      if (!vertex) continue
      sumX += vertex[0]
      sumY += vertex[1]
      seen += 1
    }
    return seen ? { lon: sumX / seen, lat: sumY / seen } : { lon: 0, lat: 0 }
  }
  return { lon: x / (3 * twiceArea), lat: y / (3 * twiceArea) }
}
