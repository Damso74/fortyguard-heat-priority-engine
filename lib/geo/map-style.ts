/**
 * Basemap style.
 *
 * Deliberately key-free: the product must not require anyone to obtain a new
 * credential to see the map. CARTO's Positron raster tiles are served without
 * an API key, are a light cartography suited to municipal analysis work, and
 * carry a clear attribution requirement that is honoured below.
 *
 * Raster rather than vector, on purpose: a vector style pulls glyph and sprite
 * assets from further origins, giving three more ways for the map to fail. The
 * table is the primary surface here, so the basemap should be the boring choice.
 */

export const BASEMAP_ATTRIBUTION =
  '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors, © <a href="https://carto.com/attributions" target="_blank" rel="noreferrer">CARTO</a>'

export interface RasterStyle {
  version: 8
  sources: Record<string, unknown>
  layers: Array<Record<string, unknown>>
}

export function buildBasemapStyle(): RasterStyle {
  return {
    version: 8,
    sources: {
      basemap: {
        type: 'raster',
        tiles: [
          'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png',
          'https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png',
          'https://c.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png',
        ],
        tileSize: 256,
        maxzoom: 19,
        attribution: BASEMAP_ATTRIBUTION,
      },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#f6f8fa' } },
      {
        id: 'basemap',
        type: 'raster',
        source: 'basemap',
        paint: {
          'raster-opacity': 0.62,
          'raster-saturation': -0.7,
          'raster-contrast': -0.1,
        },
      },
    ],
  }
}

/** Resolve the style the browser should load. */
export function resolveMapStyle(override?: string): string | RasterStyle {
  const trimmed = (override ?? '').trim()
  return trimmed.length > 0 ? trimmed : buildBasemapStyle()
}
