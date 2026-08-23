import { compactHeatCells } from '@/lib/agent/summary'
import { ANALYSIS_TIMEZONE } from '@/lib/agent/request'
import { FORTYGUARD_PILOT_REQUEST, getAoi } from '@/lib/geo/aoi'
import { loadThermalSnapshot } from '@/lib/fortyguard/snapshot-store'

export const runtime = 'nodejs'

/**
 * A lightweight, cacheable read path for the immutable pilot heat surface.
 *
 * Switching the Heat monitor hour used to execute the complete planning engine
 * again, even though the screen only needed the 150 cells for that hour. This
 * endpoint reads the already validated, committed capture and deliberately does
 * not create a run: plan exports and audit details remain bound to /api/plans.
 */
export async function GET(request: Request): Promise<Response> {
  const time = new URL(request.url).searchParams.get('time')
  if (!time || !FORTYGUARD_PILOT_REQUEST.snapshotTimes.some((candidate) => candidate === time)) {
    return Response.json(
      { error: `time must be one of: ${FORTYGUARD_PILOT_REQUEST.snapshotTimes.join(', ')}` },
      { status: 400 },
    )
  }

  try {
    const aoi = getAoi(FORTYGUARD_PILOT_REQUEST.aoiId)
    const lookup = loadThermalSnapshot({
      aoiId: FORTYGUARD_PILOT_REQUEST.aoiId,
      analysisDate: FORTYGUARD_PILOT_REQUEST.analysisDate,
      snapshotTimes: [time],
      analyticType: 'tcm',
      granularityMeters: aoi.thermalGranularityMeters,
      filterType: 1,
      timezone: ANALYSIS_TIMEZONE,
    })
    if (!lookup.snapshot) {
      return Response.json({ error: lookup.reason ?? 'Stored snapshot unavailable.' }, { status: 404 })
    }

    const snapshot = lookup.snapshot
    const cells = snapshot.cells
      .filter((cell) => cell.snapshot === `${FORTYGUARD_PILOT_REQUEST.analysisDate}T${time}`)
      .map((cell) => ({
        lon: cell.centroidLon,
        lat: cell.centroidLat,
        ring: cell.ring,
        value: cell.value,
        z: null,
      }))

    const payload = {
      time,
      cellCount: cells.length,
      granularityMeters: snapshot.request.granularityMeters,
      valueField: snapshot.source.valueField,
      temperatureUnit: snapshot.source.unit,
      attestationSha256: snapshot.attestationSha256,
      heatCells: compactHeatCells(cells),
    }

    return Response.json(payload, {
      headers: {
        // The source is a content-attested file committed with the deployment.
        // Browsers reuse it for an hour and Vercel can serve it from the edge
        // for a day, then revalidate it while continuing to serve the last
        // verified value.
        'Cache-Control': 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800',
        ETag: `"${snapshot.attestationSha256}-${time}"`,
        'X-Thermal-Source': 'committed-real-snapshot',
      },
    })
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'Stored snapshot unavailable.' },
      { status: 500 },
    )
  }
}
