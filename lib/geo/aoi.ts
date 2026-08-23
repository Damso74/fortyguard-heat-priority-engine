import type { AreaOfInterest } from '@/lib/types'
import { bboxAreaSqMiles } from './measure'

/**
 * Analysis areas.
 *
 * `central-phoenix` is the default because it is the largest area that stays
 * demonstrable inside a hackathon credit budget: at the conservative 9 mi²
 * tile ceiling it costs a single-digit number of heatmap submissions per
 * snapshot. `full-phoenix` is offered for completeness and is honest about
 * costing an order of magnitude more requests.
 */
export const AREAS_OF_INTEREST: readonly AreaOfInterest[] = [
  {
    id: 'central-phoenix',
    label: 'Central Phoenix',
    description:
      'Downtown and the surrounding high-ridership grid. Bounded rectangle used as the default analysis area.',
    bbox: { minLon: -112.13, minLat: 33.4, maxLon: -112.03, maxLat: 33.5 },
    thermalGranularityMeters: 60,
  },
  {
    id: 'full-phoenix',
    label: 'Full Phoenix stop extent',
    description:
      'Bounding rectangle of every active Valley Metro stop in the Phoenix jurisdiction. Costs roughly an order of magnitude more FortyGuard requests than Central Phoenix.',
    bbox: { minLon: -112.2907, minLat: 33.292, maxLon: -111.9255, maxLat: 33.7137 },
    thermalGranularityMeters: 60,
  },
  {
    id: 'downtown-phoenix-api-pilot',
    label: 'Downtown Phoenix · verified API pilot',
    description:
      'Returned footprint of three completed FortyGuard captures on 15 July 2024, inside the submitted downtown rectangle. This is the real-data pilot, not a city-wide claim.',
    bbox: {
      minLon: -112.07774530714039,
      minLat: 33.44165867544603,
      maxLon: -112.06699188721771,
      maxLat: 33.45504579568956,
    },
    thermalGranularityMeters: 100,
  },
] as const

export const DEFAULT_AOI_ID = 'central-phoenix'

/** The committed, reviewable real-data pilot shown by the app on first load. */
export const FORTYGUARD_PILOT_REQUEST = {
  aoiId: 'downtown-phoenix-api-pilot',
  analysisDate: '2024-07-15',
  snapshotTimes: ['08:00', '14:00', '20:00'],
} as const

export function getAoi(id: string): AreaOfInterest {
  const found = AREAS_OF_INTEREST.find((area) => area.id === id)
  if (!found) {
    throw new Error(
      `Unknown area of interest: ${id}. Known ids: ${AREAS_OF_INTEREST.map((a) => a.id).join(', ')}`,
    )
  }
  return found
}

export function aoiAreaSqMiles(id: string): number {
  return bboxAreaSqMiles(getAoi(id).bbox)
}
