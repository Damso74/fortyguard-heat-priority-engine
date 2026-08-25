export const RIDERSHIP_SOURCE = {
  layerUrl:
    'https://services2.arcgis.com/2t1927381mhTgWNC/arcgis/rest/services/BusRidershipByQuarterForPortal/FeatureServer/6',
  itemUrl: 'https://www.arcgis.com/home/item.html?id=3f5363e04eb74869aa9c67079318719f',
  mapViewerUrl:
    'https://www.arcgis.com/apps/mapviewer/index.html?layers=3f5363e04eb74869aa9c67079318719f',
  publisher: 'Valley Metro',
  itemId: '3f5363e04eb74869aa9c67079318719f',
} as const

export const RIDERSHIP_QUARTERS = [
  { key: '2022_3', label: 'FY2022 Q3', period: 'Jan–Mar 2022', status: 'historical' },
  { key: '2022_4', label: 'FY2022 Q4', period: 'Apr–Jun 2022', status: 'historical' },
  { key: '2023_1', label: 'FY2023 Q1', period: 'Jul–Sep 2022', status: 'historical' },
  { key: '2023_2', label: 'FY2023 Q2', period: 'Oct–Dec 2022', status: 'historical' },
  { key: '2023_3', label: 'FY2023 Q3', period: 'Jan–Mar 2023', status: 'historical' },
  { key: '2023_4', label: 'FY2023 Q4', period: 'Apr–Jun 2023', status: 'historical' },
  { key: '2024_1', label: 'FY2024 Q1', period: 'Jul–Sep 2023', status: 'historical' },
  { key: '2024_2', label: 'FY2024 Q2', period: 'Oct–Dec 2023', status: 'comparison' },
  { key: '2024_3', label: 'FY2024 Q3', period: 'Jan–Mar 2024', status: 'comparison' },
  { key: '2024_4', label: 'FY2024 Q4', period: 'Apr–Jun 2024', status: 'baseline' },
  { key: '2025_1', label: 'FY2025 Q1', period: 'Jul–Sep 2024', status: 'incomplete' },
  { key: '2025_2', label: 'FY2025 Q2', period: 'Oct–Dec 2024', status: 'incomplete' },
  { key: '2025_3', label: 'FY2025 Q3', period: 'Jan–Mar 2025', status: 'incomplete' },
] as const

export type RidershipQuarter = (typeof RIDERSHIP_QUARTERS)[number]['key']
export type RidershipDayCategory = 'Weekday' | 'Weekend'

export interface RidershipStop {
  objectId: number
  stopId: number
  stopCode: number | null
  nexTripCode: number | null
  name: string
  jurisdiction: string
  status: string
  dayCategory: RidershipDayCategory
  lon: number
  lat: number
  publishedAverage: number | null
  publishedQuarterTotal: number | null
}

export interface RidershipResponse {
  source: {
    publisher: string
    layerUrl: string
    itemUrl: string
    mapViewerUrl: string
    lastEditUtc: string | null
    licenceStatus: 'not-published-on-item'
  }
  quarter: RidershipQuarter
  dayCategory: RidershipDayCategory
  jurisdiction: 'Phoenix'
  recordCount: number
  stopsWithValue: number
  stops: RidershipStop[]
}

export function isRidershipQuarter(value: string | null): value is RidershipQuarter {
  return RIDERSHIP_QUARTERS.some((quarter) => quarter.key === value)
}

export function quarterDetails(quarter: RidershipQuarter) {
  return RIDERSHIP_QUARTERS.find((entry) => entry.key === quarter)!
}

/** ArcGIS publishes every quarter field as text. Missing is not zero. */
export function parsePublishedNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null
  if (typeof value !== 'string' || value.trim() === '') return null
  const parsed = Number(value.trim())
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

export function cleanArcGisLabel(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const withoutControls = [...value]
    .map((character) => {
      const code = character.charCodeAt(0)
      return code < 32 || code === 127 ? ' ' : character
    })
    .join('')
  const cleaned = withoutControls.replace(/\s+/g, ' ').trim()
  return cleaned ? cleaned.slice(0, 180) : fallback
}
