import {
  RIDERSHIP_SOURCE,
  cleanArcGisLabel,
  isRidershipQuarter,
  parsePublishedNumber,
  type RidershipDayCategory,
  type RidershipResponse,
  type RidershipStop,
} from '@/lib/ridership/source'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const PAGE_SIZE = 2000
const MAX_RECORDS = 6000
const UPSTREAM_TIMEOUT_MS = 20_000

interface ArcGisFeature {
  attributes?: Record<string, unknown>
  geometry?: { x?: unknown; y?: unknown }
}

interface ArcGisPayload {
  features?: ArcGisFeature[]
  count?: number
  exceededTransferLimit?: boolean
  editingInfo?: { lastEditDate?: number; dataLastEditDate?: number }
  error?: { message?: string; details?: string[] }
}

function upstreamUrl(path: string, parameters: Record<string, string>): string {
  const url = new URL(`${RIDERSHIP_SOURCE.layerUrl}${path}`)
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value)
  return url.toString()
}

async function fetchArcGis(url: string): Promise<ArcGisPayload> {
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    next: { revalidate: 3600 },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`Valley Metro returned HTTP ${response.status}.`)
  const payload = (await response.json()) as ArcGisPayload
  if (payload.error) {
    throw new Error(payload.error.message || 'Valley Metro returned an ArcGIS error.')
  }
  return payload
}

function finiteCoordinate(value: unknown, min: number, max: number): number | null {
  const parsed = typeof value === 'number' ? value : Number.NaN
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : null
}

function finiteInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null
}

export function normaliseRidershipFeature(
  feature: ArcGisFeature,
  quarter: string,
  dayCategory: RidershipDayCategory,
): RidershipStop | null {
  const attributes = feature.attributes ?? {}
  const objectId = finiteInteger(attributes.OBJECTID)
  const stopId = finiteInteger(attributes.StopID)
  const lon = finiteCoordinate(feature.geometry?.x, -180, 180)
  const lat = finiteCoordinate(feature.geometry?.y, -90, 90)
  if (objectId === null || stopId === null || lon === null || lat === null) return null

  return {
    objectId,
    stopId,
    stopCode: finiteInteger(attributes.BusStopNum),
    nexTripCode: finiteInteger(attributes.Nextride),
    name: cleanArcGisLabel(attributes.Location, `Stop ${stopId}`),
    jurisdiction: cleanArcGisLabel(attributes.Juris, 'Phoenix'),
    status: cleanArcGisLabel(attributes.Status, 'Unknown'),
    dayCategory,
    lon,
    lat,
    publishedAverage: parsePublishedNumber(attributes[`avg${quarter}`]),
    publishedQuarterTotal: parsePublishedNumber(attributes[`tot${quarter}`]),
  }
}

async function getLastEditUtc(): Promise<string | null> {
  const metadata = await fetchArcGis(upstreamUrl('', { f: 'json' }))
  const timestamp = metadata.editingInfo?.dataLastEditDate ?? metadata.editingInfo?.lastEditDate
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return null
  return new Date(timestamp).toISOString()
}

async function fetchPhoenixStops(
  quarter: string,
  dayCategory: RidershipDayCategory,
): Promise<{ expected: number; features: ArcGisFeature[] }> {
  const where = `Juris='Phoenix' AND Day_Category='${dayCategory}' AND Status='Active'`
  const countPayload = await fetchArcGis(
    upstreamUrl('/query', { where, returnCountOnly: 'true', f: 'json' }),
  )
  const reportedCount = countPayload.count
  if (
    typeof reportedCount !== 'number' ||
    !Number.isSafeInteger(reportedCount) ||
    reportedCount < 0 ||
    reportedCount > MAX_RECORDS
  ) {
    throw new Error('Valley Metro returned an unexpected Phoenix record count.')
  }
  const expected = reportedCount

  const features: ArcGisFeature[] = []
  for (let offset = 0; offset < expected; offset += PAGE_SIZE) {
    const payload = await fetchArcGis(
      upstreamUrl('/query', {
        where,
        outFields:
          `OBJECTID,StopID,BusStopNum,Nextride,Location,Juris,Status,Day_Category,` +
          `avg${quarter},tot${quarter}`,
        returnGeometry: 'true',
        outSR: '4326',
        orderByFields: 'OBJECTID ASC',
        resultOffset: String(offset),
        resultRecordCount: String(Math.min(PAGE_SIZE, expected - offset)),
        f: 'json',
      }),
    )
    const page = payload.features
    if (!Array.isArray(page) || page.length === 0) {
      throw new Error('Valley Metro returned an incomplete page of Phoenix stops.')
    }
    features.push(...page)
  }
  if (features.length !== expected) {
    throw new Error(
      `Valley Metro reported ${expected} Phoenix stops but returned ${features.length}.`,
    )
  }
  return { expected, features }
}

export async function GET(request: Request): Promise<Response> {
  const parameters = new URL(request.url).searchParams
  const quarter = parameters.get('quarter') ?? '2024_4'
  const day = parameters.get('day') ?? 'Weekday'
  if (!isRidershipQuarter(quarter)) {
    return Response.json({ error: 'Unsupported ridership quarter.' }, { status: 400 })
  }
  if (day !== 'Weekday' && day !== 'Weekend') {
    return Response.json({ error: 'Day category must be Weekday or Weekend.' }, { status: 400 })
  }

  try {
    const [{ expected, features }, lastEditUtc] = await Promise.all([
      fetchPhoenixStops(quarter, day),
      getLastEditUtc(),
    ])
    const stops = features
      .map((feature) => normaliseRidershipFeature(feature, quarter, day))
      .filter((stop): stop is RidershipStop => stop !== null)

    const payload: RidershipResponse = {
      source: {
        publisher: RIDERSHIP_SOURCE.publisher,
        layerUrl: RIDERSHIP_SOURCE.layerUrl,
        itemUrl: RIDERSHIP_SOURCE.itemUrl,
        mapViewerUrl: RIDERSHIP_SOURCE.mapViewerUrl,
        lastEditUtc,
        licenceStatus: 'not-published-on-item',
      },
      quarter,
      dayCategory: day,
      jurisdiction: 'Phoenix',
      recordCount: expected,
      stopsWithValue: stops.filter((stop) => stop.publishedAverage !== null).length,
      stops,
    }

    return Response.json(payload, {
      headers: {
        'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400',
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The ridership layer is unavailable.'
    return Response.json({ error: message }, { status: 502 })
  }
}
