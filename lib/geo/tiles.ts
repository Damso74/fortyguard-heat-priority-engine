import type { AnalysisTile, AreaOfInterest, BoundingBox, TilePlan } from '@/lib/types'
import { bboxAreaSqMiles, bboxHeightMeters, bboxWidthMeters } from './measure'

/**
 * Split an area of interest into request-sized tiles.
 *
 * The spike submitted a single ~34.9 mi² polygon on the strength of a marketing
 * figure. The documented plan ceilings are 10 mi² (API Basic and API Startup)
 * and 50 mi² (API Premium), so a single-polygon submission of that size is
 * rejected on the plans a hackathon key is most likely to carry. This planner
 * therefore defaults to a conservative ceiling below the smallest documented
 * limit and refuses to emit a tile above it.
 *
 * The tiles form an exact partition of the AOI rectangle: they share edges,
 * never overlap in area, and their union is the AOI with no gap. That property
 * is asserted by `verifyCoverage` and by the unit tests.
 */

export const DEFAULT_MAX_TILE_SQ_MI = 9

export function planTiles(
  aoi: AreaOfInterest,
  maxTileSqMi: number = DEFAULT_MAX_TILE_SQ_MI,
): TilePlan {
  if (!(maxTileSqMi > 0) || !Number.isFinite(maxTileSqMi)) {
    throw new Error(`maxTileSqMi must be a positive finite number, received ${maxTileSqMi}`)
  }

  const { bbox } = aoi
  if (bbox.maxLon <= bbox.minLon || bbox.maxLat <= bbox.minLat) {
    throw new Error(`Area of interest ${aoi.id} has an empty bounding box`)
  }

  const aoiAreaSqMi = bboxAreaSqMiles(bbox)
  const widthMeters = bboxWidthMeters(bbox)
  const heightMeters = bboxHeightMeters(bbox)
  const aspect = widthMeters / heightMeters

  /** Lay out a rows×cols partition of the AOI rectangle. */
  const layout = (rows: number, cols: number): AnalysisTile[] => {
    const lonEdges: number[] = []
    for (let col = 0; col <= cols; col += 1) {
      // The far edge reuses the AOI bound verbatim so floating-point drift can
      // never open a sliver of uncovered area at the boundary, and adjacent
      // tiles share the *identical* interior edge value.
      lonEdges.push(
        col === cols ? bbox.maxLon : bbox.minLon + (col * (bbox.maxLon - bbox.minLon)) / cols,
      )
    }
    const latEdges: number[] = []
    for (let row = 0; row <= rows; row += 1) {
      latEdges.push(
        row === rows ? bbox.maxLat : bbox.minLat + (row * (bbox.maxLat - bbox.minLat)) / rows,
      )
    }

    const output: AnalysisTile[] = []
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const tileBbox: BoundingBox = {
          minLon: lonEdges[col]!,
          maxLon: lonEdges[col + 1]!,
          minLat: latEdges[row]!,
          maxLat: latEdges[row + 1]!,
        }
        output.push({
          id: `${aoi.id}-r${row}c${col}`,
          bbox: tileBbox,
          areaSqMi: bboxAreaSqMiles(tileBbox),
          row,
          col,
        })
      }
    }
    return output
  }

  // Grow the grid until *every actual tile* fits under the ceiling. Testing the
  // real per-tile area matters: a tile's width in miles depends on its own
  // latitude, so the average is not a safe proxy near the AOI edges.
  let cols = 1
  let rows = 1
  let tiles = layout(rows, cols)
  for (let step = 0; step < 4096; step += 1) {
    const largest = tiles.reduce((best, tile) => Math.max(best, tile.areaSqMi), 0)
    if (largest <= maxTileSqMi) break
    // Grow whichever axis currently produces the more elongated tile.
    if (aspect * (rows / cols) >= 1) cols += 1
    else rows += 1
    tiles = layout(rows, cols)
  }

  const oversized = tiles.find((tile) => tile.areaSqMi > maxTileSqMi + 1e-9)
  if (oversized) {
    throw new Error(
      `Tile ${oversized.id} is ${oversized.areaSqMi.toFixed(3)} mi², above the ceiling of ${maxTileSqMi} mi². Refusing to submit.`,
    )
  }

  const totalAreaSqMi = tiles.reduce((sum, tile) => sum + tile.areaSqMi, 0)

  return {
    aoiId: aoi.id,
    tiles,
    maxTileSqMi,
    totalAreaSqMi,
    aoiAreaSqMi,
    coversAoi: verifyCoverage(bbox, tiles),
  }
}

/**
 * True when the tiles form an exact partition of the AOI rectangle.
 *
 * This is a structural proof rather than an area comparison. Comparing summed
 * tile area against AOI area would be wrong: each rectangle's width in miles is
 * evaluated at its own mid-latitude, so the parts legitimately do not sum to
 * the whole under that approximation. Structure settles the question exactly.
 *
 * The four conditions together imply no gap and no overlap:
 *   1. the distinct longitude edges are `cols + 1` values spanning the AOI;
 *   2. the distinct latitude edges are `rows + 1` values spanning the AOI;
 *   3. every `(row, col)` slot appears exactly once;
 *   4. each tile's bounds are exactly the edge pair its indices select.
 */
export function verifyCoverage(bbox: BoundingBox, tiles: readonly AnalysisTile[]): boolean {
  if (tiles.length === 0) return false

  const rows = new Set(tiles.map((tile) => tile.row)).size
  const cols = new Set(tiles.map((tile) => tile.col)).size
  if (rows * cols !== tiles.length) return false

  const slots = new Set(tiles.map((tile) => `${tile.row}:${tile.col}`))
  if (slots.size !== tiles.length) return false

  const lonEdges = [...new Set(tiles.flatMap((t) => [t.bbox.minLon, t.bbox.maxLon]))].sort(
    (a, b) => a - b,
  )
  const latEdges = [...new Set(tiles.flatMap((t) => [t.bbox.minLat, t.bbox.maxLat]))].sort(
    (a, b) => a - b,
  )
  if (lonEdges.length !== cols + 1 || latEdges.length !== rows + 1) return false
  if (lonEdges[0] !== bbox.minLon || lonEdges[lonEdges.length - 1] !== bbox.maxLon) return false
  if (latEdges[0] !== bbox.minLat || latEdges[latEdges.length - 1] !== bbox.maxLat) return false

  for (const tile of tiles) {
    if (tile.bbox.minLon !== lonEdges[tile.col]) return false
    if (tile.bbox.maxLon !== lonEdges[tile.col + 1]) return false
    if (tile.bbox.minLat !== latEdges[tile.row]) return false
    if (tile.bbox.maxLat !== latEdges[tile.row + 1]) return false
  }

  return true
}

/** GeoJSON FeatureCollection payload for one tile, in the shape the API expects. */
export function tileToPolygonAoi(tile: AnalysisTile): {
  type: 'FeatureCollection'
  features: Array<{
    type: 'Feature'
    properties: Record<string, never>
    geometry: { type: 'Polygon'; coordinates: Array<Array<[number, number]>> }
  }>
} {
  const { bbox } = tile
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [bbox.minLon, bbox.minLat],
              [bbox.maxLon, bbox.minLat],
              [bbox.maxLon, bbox.maxLat],
              [bbox.minLon, bbox.maxLat],
              [bbox.minLon, bbox.minLat],
            ],
          ],
        },
      },
    ],
  }
}
