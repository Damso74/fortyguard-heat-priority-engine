import { finalizeRun } from '@/lib/agent/run'
import { recallRun, requestDigest } from '@/lib/agent/run-store'
import { auditHash } from '@/lib/audit/log'
import { exportFilename, exportPlanCsv, exportRunJson } from '@/lib/export/plan-export'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_REQUEST_BYTES = 64 * 1024
const MAX_ATTESTOR_LENGTH = 120

/**
 * An export is a **frozen representation of a completed run**, not a second
 * execution of the engine.
 *
 * ## What changed, and why
 *
 * This endpoint used to call `executeRun` again from the same request and compare
 * the resulting run id against the one the browser named. That caught a changed
 * run, which was the point — but it meant every export re-ran the engine, and a
 * second execution produces a second audit trail. The recorded timestamps for
 * validating, tiling, normalising, gating and scoring were regenerated from the
 * export's clock, so a plan downloaded on Thursday carried a trail claiming it had
 * run on Thursday whatever day it actually ran. The one artefact whose whole
 * purpose is to be unchanged was rewritten on every read.
 *
 * The run is now looked up in the store `/api/plans` writes to. The attestation
 * and export records are **appended** to the trail that already exists; nothing
 * before them is touched, no snapshot is read, and no existing timestamp is
 * recomputed.
 *
 * ## Why `expectedRunId` is required
 *
 * It is the lookup key, and it is the binding. The browser attests to a plan it
 * has on screen; the server exports exactly that run or nothing. A run that is no
 * longer held is a 409 saying so — not a re-derivation, which is the behaviour
 * this replaces.
 *
 * ## What "approval" here actually is
 *
 * There is **no authentication in this product**. Anyone who can reach this
 * endpoint can type any name into the box. Calling the result an "approval" would
 * imply an identity check that does not happen, and an export that said "approved
 * by the City of Phoenix" would be a forgery this code helped write.
 *
 * It is therefore a **named self-attestation**: a claim, recorded verbatim, that
 * whoever typed it reviewed the plan, bound to the run id and to the digest of the
 * audit trail as it stood at that moment. That is genuinely useful, and it is not
 * an authorisation. Every surface says so.
 */
export async function POST(request: Request): Promise<Response> {
  const text = await request.text()
  if (text.length > MAX_REQUEST_BYTES) {
    return Response.json({ error: 'Request body too large.' }, { status: 413 })
  }

  let body: {
    request?: unknown
    format?: string
    attestedBy?: string
    approvedBy?: string
    expectedRunId?: string
    /**
     * Digest of the audit trail the browser is attesting to.
     *
     * The run id covers the inputs; this covers the record. Supplying both means
     * an attestation names a specific sequence of events, not merely a request
     * that would reproduce one.
     */
    expectedAuditSha256?: string
    selectedOnly?: boolean
  }
  try {
    body = JSON.parse(text || '{}')
  } catch {
    return Response.json({ error: 'Request body is not valid JSON.' }, { status: 400 })
  }

  const format = body.format === 'json' ? 'json' : 'csv'
  // `approvedBy` is still accepted so an older client is not silently broken,
  // but the field the product uses and documents is `attestedBy`.
  const attestedBy = String(body.attestedBy ?? body.approvedBy ?? '')
    .slice(0, MAX_ATTESTOR_LENGTH)
    .replace(/[\r\n]/g, ' ')
    .trim()

  if (!attestedBy) {
    return Response.json(
      {
        error:
          'A name is required before a plan can be exported. It is recorded as a self-attestation ' +
          'that this plan was reviewed — not as an authenticated approval; this product has no ' +
          'authentication.',
      },
      { status: 400 },
    )
  }

  const expectedRunId = typeof body.expectedRunId === 'string' ? body.expectedRunId.trim() : ''
  if (!expectedRunId) {
    return Response.json(
      {
        error:
          'expectedRunId is required. It binds the attestation to the exact plan that was ' +
          'reviewed; without it an export could carry a name against a plan nobody saw.',
      },
      { status: 400 },
    )
  }

  const stored = recallRun(expectedRunId)
  if (!stored) {
    return Response.json(
      {
        error:
          `Refusing to export: run ${expectedRunId} is not held by this server. An export is a ` +
          'frozen representation of a completed run, so it cannot be produced by re-running the ' +
          'analysis — a second execution would carry a second audit trail with new timestamps. ' +
          'Re-run the analysis, review the plan it produces, and export that.',
        expectedRunId,
      },
      { status: 409 },
    )
  }

  // Defence in depth. The run id already covers the request, the dataset, the
  // engine version and the thermal attestation, so a mismatch here means the
  // caller is attesting to one plan while describing another.
  if (body.request !== undefined && requestDigest(body.request) !== stored.requestSha256) {
    return Response.json(
      {
        error:
          `Refusing to export: run ${expectedRunId} was produced by a different request than the ` +
          'one submitted with this attestation.',
        expectedRunId,
      },
      { status: 409 },
    )
  }

  /*
   * Required, not optional.
   *
   * An optional check is one a caller can decline, and the caller that most
   * wants to decline it is the one attesting to a plan it did not see. The run
   * id covers the inputs; this covers the record.
   */
  const expectedAudit =
    typeof body.expectedAuditSha256 === 'string' ? body.expectedAuditSha256.trim() : ''
  if (!expectedAudit) {
    return Response.json(
      {
        error:
          'expectedAuditSha256 is required. The run id identifies the inputs; the audit digest ' +
          'identifies the record that was reviewed. An attestation needs both, or it names a ' +
          'request rather than a plan.',
      },
      { status: 400 },
    )
  }
  {
    const actual = auditHash(stored.run.audit)
    if (actual !== expectedAudit) {
      return Response.json(
        {
          error:
            `Refusing to export: run ${expectedRunId} is held, but its audit trail digests to ` +
            `${actual}, and the attestation names ${expectedAudit}. The run on screen is not the ` +
            'run this server holds. Re-run the analysis and review the new plan.',
          expectedRunId,
        },
        { status: 409 },
      )
    }
  }

  try {
    const finalized = finalizeRun(stored.run, { attestedBy })

    const payload =
      format === 'json'
        ? exportRunJson(finalized)
        : exportPlanCsv(finalized, { selectedOnly: body.selectedOnly !== false })

    return new Response(payload, {
      status: 200,
      headers: {
        'Content-Type':
          format === 'json' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${exportFilename(finalized, format)}"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Export failed.'
    return Response.json({ error: message }, { status: 400 })
  }
}
