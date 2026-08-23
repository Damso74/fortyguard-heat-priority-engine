import { createHash } from 'node:crypto'
import type { AuditEvent, RunState } from '@/lib/types'
import { assertTransition } from '@/lib/agent/state-machine'
import { redactText } from '@/lib/fortyguard/redact'

/**
 * Append-only audit trail.
 *
 * Every state transition writes one record. Records are redacted on the way in,
 * not on the way out, so an export can never contain a secret that the log
 * happened to keep. Each record carries a hash of its own payload so a tampered
 * export is detectable.
 */

export interface TransitionInput {
  step: RunState
  inputSummary: string
  outputSummary: string
  decision: string
  source: string
  payloadForHash?: unknown
  error?: string | null
}

export class AuditLog {
  private readonly events: AuditEvent[] = []
  private current: RunState = 'created'
  private sequence = 0

  constructor(
    private readonly runId: string,
    private readonly now: () => Date = () => new Date(),
    private readonly secrets: readonly string[] = [],
  ) {
    this.events.push({
      timestamp: this.now().toISOString(),
      runId,
      sequence: this.sequence++,
      step: 'created',
      inputSummary: 'Run created',
      outputSummary: `Run id ${runId}`,
      decision: 'start',
      source: 'lib/agent/run.ts',
      hash: null,
      error: null,
    })
  }

  get state(): RunState {
    return this.current
  }

  get records(): readonly AuditEvent[] {
    return this.events
  }

  /** Move the machine and record it. Throws on an illegal transition. */
  transition(input: TransitionInput): AuditEvent {
    assertTransition(this.current, input.step)
    this.current = input.step

    const hash =
      input.payloadForHash === undefined
        ? null
        : createHash('sha256')
            .update(JSON.stringify(input.payloadForHash))
            .digest('hex')
            .slice(0, 32)

    const event: AuditEvent = {
      timestamp: this.now().toISOString(),
      runId: this.runId,
      sequence: this.sequence++,
      step: input.step,
      inputSummary: redactText(input.inputSummary, this.secrets),
      outputSummary: redactText(input.outputSummary, this.secrets),
      decision: redactText(input.decision, this.secrets),
      source: input.source,
      hash,
      error: input.error ? redactText(input.error, this.secrets) : null,
    }
    this.events.push(event)
    return event
  }

  toJSON(): AuditEvent[] {
    return [...this.events]
  }
}

/**
 * Append one event to a completed trail, leaving the prefix untouched.
 *
 * The export path used to build a **new** `AuditLog` and replay every recorded
 * event through it. That regenerated each event's timestamp from the export's
 * clock, so the trail said the run had validated, tiled, normalised, gated and
 * scored at the moment somebody clicked download. An audit whose timestamps are
 * rewritten every time it is read is not an audit.
 *
 * The prefix here is the *same array elements*, by construction: nothing in this
 * function can alter an earlier record, so "the export preserved the original
 * audit" is a property of the code rather than a claim to be spot-checked.
 */
export function appendAuditEvent(
  events: readonly AuditEvent[],
  input: TransitionInput,
  options: { now?: () => Date; secrets?: readonly string[] } = {},
): AuditEvent[] {
  const last = events[events.length - 1]
  if (!last) throw new Error('Cannot append to an empty audit trail.')
  assertTransition(last.step, input.step)

  const now = options.now ?? (() => new Date())
  const secrets = options.secrets ?? []
  const hash =
    input.payloadForHash === undefined
      ? null
      : createHash('sha256')
          .update(JSON.stringify(input.payloadForHash))
          .digest('hex')
          .slice(0, 32)

  return [
    ...events,
    {
      timestamp: now().toISOString(),
      runId: last.runId,
      sequence: last.sequence + 1,
      step: input.step,
      inputSummary: redactText(input.inputSummary, secrets),
      outputSummary: redactText(input.outputSummary, secrets),
      decision: redactText(input.decision, secrets),
      source: input.source,
      hash,
      error: input.error ? redactText(input.error, secrets) : null,
    },
  ]
}

/**
 * Digest of an audit trail, in order.
 *
 * Recorded on the attestation, so the name is bound not only to a run id but to
 * the exact sequence of records that existed when it was made. A later export
 * that produced a different prefix would produce a different digest, and the two
 * artefacts would visibly disagree.
 */
export function auditHash(events: readonly AuditEvent[]): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        events.map((event) => [
          event.sequence,
          event.timestamp,
          event.runId,
          event.step,
          event.inputSummary,
          event.outputSummary,
          event.decision,
          event.source,
          event.hash,
          event.error,
        ]),
      ),
    )
    .digest('hex')
}

/**
 * Deterministic run id.
 *
 * Derived from the request, the dataset hash and the engine version, so an
 * identical run reproduces an identical id. Timestamps are deliberately not
 * part of the hash — otherwise the same analysis would be unverifiable an hour
 * later.
 */
export function deriveRunId(parts: {
  request: unknown
  datasetSha256: string
  engineVersion: string
  /**
   * Content hash of the thermal layer this run was built on.
   *
   * Without it the id was a function of the request and the stop dataset only,
   * so two runs against **different thermal surfaces** produced the same id —
   * and an export could not be checked against the numbers behind it. A
   * synthetic run passes the fixture's own digest, so a fixture run and a real
   * run of the same request are visibly different runs.
   */
  thermalSha256: string
}): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        request: parts.request,
        dataset: parts.datasetSha256,
        engine: parts.engineVersion,
        thermal: parts.thermalSha256,
      }),
    )
    .digest('hex')
  return `run_${digest.slice(0, 16)}`
}
