import { describe, expect, it } from 'vitest'
import { executeRun, finalizeRun } from '@/lib/agent/run'
import { appendAuditEvent, auditHash } from '@/lib/audit/log'
import { exportPlanCsv, exportRunJson } from '@/lib/export/plan-export'
import { clearRunStore, recallRun, rememberRun, requestDigest } from '@/lib/agent/run-store'

/**
 * An export is a frozen representation of a completed run.
 *
 * The defect: `finalizeRun` built a **new** `AuditLog` and replayed every
 * recorded event through it. Each replayed event took its timestamp from the
 * export's clock, so a plan downloaded on Thursday carried a trail claiming it
 * had validated, tiled, normalised, gated and scored on Thursday — whatever day
 * it had actually run. Sequence numbers were re-derived and payload hashes moved
 * with them. The one artefact whose entire purpose is to be unchanged was
 * rewritten on every read.
 */

const REQUEST = { aoiId: 'central-phoenix', capacity: 5, analysisDate: '2026-08-03' }

describe('the audit prefix survives the export byte for byte', () => {
  it('appends two records and touches nothing before them', async () => {
    const run = await executeRun(REQUEST, { now: () => new Date('2026-08-04T12:00:00Z') })
    const before = JSON.parse(JSON.stringify(run.audit))

    // Export much later, from a different clock.
    const finalized = finalizeRun(run, {
      attestedBy: 'A Reviewer',
      now: () => new Date('2026-09-30T09:15:00Z'),
    })

    expect(finalized.audit).toHaveLength(before.length + 2)
    // Element for element, not merely "the same length and the same last step".
    expect(finalized.audit.slice(0, before.length)).toEqual(before)
    // …and byte for byte once serialised, which is what an export writes.
    expect(JSON.stringify(finalized.audit.slice(0, before.length))).toBe(JSON.stringify(before))
    expect(auditHash(finalized.audit.slice(0, before.length))).toBe(auditHash(before))

    const appended = finalized.audit.slice(before.length)
    expect(appended.map((event) => event.step)).toEqual(['approved', 'exported'])
    expect(appended.every((event) => event.timestamp === '2026-09-30T09:15:00.000Z')).toBe(true)
    // Sequence continues rather than restarting.
    expect(appended[0]!.sequence).toBe(before[before.length - 1].sequence + 1)
    expect(appended[1]!.sequence).toBe(appended[0]!.sequence + 1)
  }, 120_000)

  it('binds the attestation to the audit as it stood when it was reviewed', async () => {
    const run = await executeRun(REQUEST, { now: () => new Date('2026-08-04T12:00:00Z') })
    const reviewed = auditHash(run.audit)
    const finalized = finalizeRun(run, { attestedBy: 'A Reviewer' })

    expect(finalized.attestation?.reviewedAuditSha256).toBe(reviewed)
    expect(finalized.attestation?.runId).toBe(run.runId)
    // The digest names the prefix, not the exported trail: the two extra records
    // are the attestation itself, and a claim cannot cover its own record.
    expect(auditHash(finalized.audit)).not.toBe(reviewed)
    const approved = finalized.audit.find((event) => event.step === 'approved')!
    expect(approved.decision).toContain(reviewed.slice(0, 16))
    expect(approved.decision).toMatch(/NAMED SELF-ATTESTATION/)
    expect(approved.decision).toMatch(/not an authenticated approval/)
  }, 120_000)

  it('produces the same export twice, and a later export of the same prefix', async () => {
    const run = await executeRun(REQUEST, { now: () => new Date('2026-08-04T12:00:00Z') })
    const at = (iso: string) => finalizeRun(run, { attestedBy: 'A Reviewer', now: () => new Date(iso) })

    const first = at('2026-08-04T12:05:00Z')
    const later = at('2027-01-01T00:00:00Z')

    // Everything before the attestation is identical across a five-month gap.
    expect(later.audit.slice(0, run.audit.length)).toEqual(first.audit.slice(0, run.audit.length))
    expect(later.attestation?.reviewedAuditSha256).toBe(first.attestation?.reviewedAuditSha256)

    // The exported artefacts differ only in the attestation timestamps.
    const strip = (text: string) => text.replace(/2026-08-04T12:05:00\.000Z|2027-01-01T00:00:00\.000Z/g, 'AT')
    // `artefactWrittenAtUtc` is stamped from the wall clock when the FILE is
    // written, which is not when anything in it happened. It is named that way
    // and sits outside the attestation for exactly this reason, so it is
    // normalised here rather than pinned to a value the test would have to
    // invent. Everything else must match across the five-month gap.
    const normalise = (text: string) =>
      strip(text).replace(/"artefactWrittenAtUtc": "[^"]+"/, '"artefactWrittenAtUtc": "AT"')
    expect(normalise(exportRunJson(later))).toBe(normalise(exportRunJson(first)))
  }, 120_000)

  it('records the run id, the audit digest and the resolved mode in the CSV', async () => {
    const run = await executeRun(REQUEST, { now: () => new Date('2026-08-04T12:00:00Z') })
    const csv = exportPlanCsv(finalizeRun(run, { attestedBy: 'A Reviewer' }))
    expect(csv).toContain(run.runId)
    expect(csv).toContain('named_self_attestation')
    expect(csv).toContain('product_mode_permitted_by_evidence')
    expect(csv).toContain('data_mode_resolved')
    expect(csv).toContain('axes_used')
  }, 120_000)

  it('refuses an illegal transition rather than rebuilding the trail to fit', async () => {
    const run = await executeRun(REQUEST, { now: () => new Date('2026-08-04T12:00:00Z') })
    // `validating` cannot follow `awaiting_approval`; the state machine says so,
    // and appending must respect it rather than starting a fresh log.
    expect(() =>
      appendAuditEvent(run.audit, {
        step: 'validating',
        inputSummary: 'x',
        outputSummary: 'x',
        decision: 'x',
        source: 'test',
      }),
    ).toThrow()
    expect(() =>
      appendAuditEvent([], {
        step: 'approved',
        inputSummary: 'x',
        outputSummary: 'x',
        decision: 'x',
        source: 'test',
      }),
    ).toThrow(/empty audit trail/)
  }, 120_000)
})

describe('the export is bound to a run this server actually holds', () => {
  it('recalls the exact run object, not an equal one', async () => {
    clearRunStore()
    const run = await executeRun(REQUEST)
    rememberRun(run, REQUEST)
    const stored = recallRun(run.runId)!
    // Identity, not equality: the exported plan is the object the screen was
    // built from, so the two cannot drift.
    expect(stored.run).toBe(run)
    expect(stored.requestSha256).toBe(requestDigest(REQUEST))
    expect(recallRun('run_does_not_exist')).toBeNull()
    clearRunStore()
    expect(recallRun(run.runId)).toBeNull()
  }, 120_000)

  it('evicts the oldest run rather than growing without bound', async () => {
    clearRunStore()
    const run = await executeRun(REQUEST)
    for (let index = 0; index < 40; index += 1) {
      rememberRun({ ...run, runId: `run_${index}` }, { index })
    }
    expect(recallRun('run_0')).toBeNull()
    expect(recallRun('run_39')).not.toBeNull()
    clearRunStore()
  }, 120_000)
})
