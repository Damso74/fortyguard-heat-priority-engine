/**
 * Basemap style.
 *
 * Deliberately key-free: the product must not require anyone to obtain a new
 * credential to see the map. OpenFreeMap's Positron style exposes the street
 * network clearly beneath the measured heat surface, without an API-key
 * watermark. Its public MapLibre endpoint and attribution requirements are
 * documented at https://openfreemap.org/quick_start/.
 */

export const DEFAULT_BASEMAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/positron'

/** Resolve the style the browser should load. */
export function resolveMapStyle(override?: string): string {
  const trimmed = (override ?? '').trim()
  return trimmed.length > 0 ? trimmed : DEFAULT_BASEMAP_STYLE_URL
}
