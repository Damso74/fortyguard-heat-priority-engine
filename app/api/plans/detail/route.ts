import { recallRun } from '@/lib/agent/run-store'
import { auditDetail, stopDetail } from '@/lib/agent/summary'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Everything `/api/plans` left out, bound to the run that produced it.
 *
 * The interactive response carries what the list and the map draw. The hourly
 * decomposition, the per-snapshot anomaly, the confidence rationale, the scenario
 * envelope internals and the full audit trail are read one at a time, by a panel
 * somebody opened — so they are fetched one at a time, from here.
 *
 * Two properties matter more than the size saving:
 *
 * - the detail comes from the **stored run**, the same object the export freezes,
 *   so the panel and the exported CSV cannot show different numbers for the same
 *   stop. Re-deriving here would reintroduce exactly the divergence the payload
 *   work was supposed to be safe from;
 * - a run this server no longer holds is a 409 rather than a fresh execution.
 *
 * Read-only. Nothing here executes the engine, reads a snapshot or spends a credit.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const runId = url.searchParams.get('runId')?.trim() ?? ''
  const include = url.searchParams.get('include')?.trim() ?? ''
  const stopIdRaw = url.searchParams.get('stopId')?.trim() ?? ''

  if (!runId) {
    return Response.json({ error: 'runId is required.' }, { status: 400 })
  }

  const stored = recallRun(runId)
  if (!stored) {
    return Response.json(
      {
        error:
          `Run ${runId} is not held by this server. Detail is read from the completed run, never ` +
          're-derived, so a run that has been evicted cannot be described. Re-run the analysis.',
        runId,
      },
      { status: 409 },
    )
  }

  if (include === 'audit') {
    return Response.json(auditDetail(stored.run), {
      headers: { 'Cache-Control': 'no-store' },
    })
  }

  if (!stopIdRaw) {
    return Response.json(
      { error: 'Either stopId or include=audit is required.' },
      { status: 400 },
    )
  }

  const stopId = Number(stopIdRaw)
  if (!Number.isInteger(stopId)) {
    return Response.json({ error: 'stopId must be an integer.' }, { status: 400 })
  }

  const detail = stopDetail(stored.run, stopId)
  if (!detail) {
    return Response.json(
      { error: `Run ${runId} contains no stop ${stopId}.` },
      { status: 404 },
    )
  }

  return Response.json(detail, { headers: { 'Cache-Control': 'no-store' } })
}
