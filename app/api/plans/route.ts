import { ENGINE_VERSION, executeRun } from '@/lib/agent/run'
import { cacheKeyFor, recallByCacheKey, recallRun, rememberRun } from '@/lib/agent/run-store'
import { toPlanSummary } from '@/lib/agent/summary'
import { RunRequestSchema } from '@/lib/agent/request'
import { serverEnv } from '@/lib/config/server-env'
import { loadDatasetManifest } from '@/lib/data/stops'
import { FortyGuardError } from '@/lib/fortyguard/errors'
import { snapshotStoreStamp } from '@/lib/fortyguard/snapshot-store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Requests are tiny; anything larger is rejected before it is parsed. */
const MAX_REQUEST_BYTES = 64 * 1024

/**
 * Ceiling on the interactive response, enforced rather than hoped for.
 *
 * The full run was 5.58 MB decoded for a 50-stop plan over central Phoenix. Most
 * of that was cell geometry repeated 10,212 times and per-stop detail for the 816
 * stops nobody opened, and none of it was needed to draw the screen. The summary
 * is about 1.27 MB; this budget leaves headroom for a larger area while still
 * failing loudly rather than drifting back.
 *
 * A test asserts the same number against the default request, so the guard is
 * deterministic and cannot be satisfied by a fast machine.
 */
export const MAX_SUMMARY_BYTES = 1_800_000

export async function POST(request: Request): Promise<Response> {
  const declaredLength = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    return Response.json({ error: 'Request body too large.' }, { status: 413 })
  }

  const text = await request.text()
  if (text.length > MAX_REQUEST_BYTES) {
    return Response.json({ error: 'Request body too large.' }, { status: 413 })
  }

  let body: unknown
  try {
    body = text.trim().length ? JSON.parse(text) : {}
  } catch {
    return Response.json({ error: 'Request body is not valid JSON.' }, { status: 400 })
  }

  try {
    // The engine is deterministic in the request, the stop dataset, the engine
    // version and the thermal source, so those four are the whole cache key.
    // Anything that would change the answer changes the key with it — including
    // committing a snapshot, which the store stamp covers.
    // The PARSED request, after defaults. Keying on the raw body meant `{}` and
    // `{"aoiId":"central-phoenix", …}` were different keys for the same run, and
    // — worse — that `{}` stayed cached across midnight, when its defaulted
    // `analysisDate` silently became a different day.
    const normalised = RunRequestSchema.safeParse(body ?? {})
    const cacheKey = cacheKeyFor({
      request: normalised.success ? normalised.data : body,
      datasetSha256: loadDatasetManifest().artifact.canonicalSha256,
      engineVersion: ENGINE_VERSION,
      snapshotStoreStamp: snapshotStoreStamp(),
    })

    const cached = recallByCacheKey(cacheKey)
    let run = cached?.run
    if (!run) {
      const computed = await executeRun(body)
      rememberRun(computed, body, { cacheKey })
      /*
       * Read the run back rather than using the one just computed.
       *
       * The store is first-write-wins, so if an id is already held the stored
       * object is the one an export will freeze — and returning the fresh twin
       * would put a different object on screen from the one the export uses.
       * They should be equal; "should be" is what this removes.
       */
      run = recallRun(computed.runId)?.run ?? computed
    }

    // The summary is a transport form of the *stored* run — the same object the
    // export freezes — so the screen and the exported plan cannot disagree.
    const payload = JSON.stringify(toPlanSummary(run))
    // `string.length` counts UTF-16 code units, not bytes: the degree sign, the
    // em dashes and the `·` in every unit label are two bytes each on the wire.
    // What travels is UTF-8, so that is what the budget is measured in.
    const bytes = Buffer.byteLength(payload, 'utf8')

    if (bytes > MAX_SUMMARY_BYTES) {
      return Response.json(
        {
          error:
            `The interactive response is ${bytes} UTF-8 bytes, above the ${MAX_SUMMARY_BYTES}-byte ` +
            'budget. Something that belongs in the detail path has been added to the summary.',
        },
        { status: 500 },
      )
    }

    return new Response(payload, {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Run-Id': run.runId,
        'X-Payload-Bytes': String(bytes),
        'X-Run-Cache': cached ? 'hit' : 'miss',
      },
    })
  } catch (error) {
    if (error instanceof FortyGuardError) {
      // The message is already redacted by the client.
      return Response.json(
        { error: error.message, kind: error.kind, status: error.status },
        { status: 502 },
      )
    }
    const message = error instanceof Error ? error.message : 'Run failed.'
    // Never echo the environment: strip anything that looks like the key.
    const key = serverEnv().FORTYGUARD_API_KEY
    const safe = key ? message.split(key).join('[REDACTED]') : message
    return Response.json({ error: safe }, { status: 400 })
  }
}
