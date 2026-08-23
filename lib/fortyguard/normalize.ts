import type { ThermalCell } from '@/lib/types'
import { ringCentroid } from '@/lib/geo/measure'
import type { FortyGuardFeatureCollection } from './schema'

/**
 * Turn a returned FeatureCollection into the internal cell representation.
 *
 * De-duplication is by rounded centroid: overlapping tiles legitimately return
 * the same physical cell twice, and counting it twice would bias any zone whose
 * geometry straddles a tile seam. Ties keep the first occurrence so the result
 * is independent of tile submission order.
 */

/** ~1.1 m at this latitude — well inside a 60 m cell, so no distinct cell collides. */
const CENTROID_PRECISION = 5

export function cellKey(lon: number, lat: number, snapshot: string): string {
  return `${snapshot}|${lon.toFixed(CENTROID_PRECISION)}|${lat.toFixed(CENTROID_PRECISION)}`
}

function outerRing(geometry: { type: string; coordinates: unknown }): Array<[number, number]> | null {
  const coordinates = geometry.coordinates
  if (!Array.isArray(coordinates)) return null

  const asRing = (candidate: unknown): Array<[number, number]> | null => {
    if (!Array.isArray(candidate)) return null
    const ring: Array<[number, number]> = []
    for (const vertex of candidate) {
      if (!Array.isArray(vertex) || vertex.length < 2) return null
      const lon = Number(vertex[0])
      const lat = Number(vertex[1])
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null
      ring.push([lon, lat])
    }
    return ring.length >= 3 ? ring : null
  }

  if (geometry.type === 'Polygon') return asRing(coordinates[0])
  if (geometry.type === 'MultiPolygon') {
    const first = coordinates[0]
    return Array.isArray(first) ? asRing(first[0]) : null
  }
  return null
}

export interface NormalizeOutcome {
  cells: ThermalCell[]
  /** Features skipped because they had no usable geometry or no numeric value. */
  skipped: number
  /** Cells discarded as duplicates of an already-seen centroid. */
  duplicates: number
}

export function normalizeFeatureCollection(
  collection: FortyGuardFeatureCollection,
  options: { valueField: string; snapshot: string; seen?: Set<string> },
): NormalizeOutcome {
  const { valueField, snapshot } = options
  const seen = options.seen ?? new Set<string>()
  const cells: ThermalCell[] = []
  let skipped = 0
  let duplicates = 0

  for (const feature of collection.features) {
    const geometry = feature.geometry
    if (!geometry) {
      skipped += 1
      continue
    }
    const ring = outerRing(geometry)
    if (!ring) {
      skipped += 1
      continue
    }
    const value = (feature.properties ?? {})[valueField]
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      skipped += 1
      continue
    }
    const centroid = ringCentroid(ring)
    const key = cellKey(centroid.lon, centroid.lat, snapshot)
    if (seen.has(key)) {
      duplicates += 1
      continue
    }
    seen.add(key)
    cells.push({
      id: key,
      centroidLon: centroid.lon,
      centroidLat: centroid.lat,
      ring,
      value,
      snapshot,
    })
  }

  // Deterministic ordering regardless of upstream feature order.
  cells.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return { cells, skipped, duplicates }
}
