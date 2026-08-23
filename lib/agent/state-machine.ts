import type { RunState } from '@/lib/types'

/**
 * The orchestration state machine.
 *
 * This is a pipeline, not a chatbot. The agent is the deterministic sequencing
 * of load → validate → tile → submit → poll → normalise → gate → score →
 * approve → export, with an audit event on every transition. No language model
 * participates in any of it: nothing here calls one, and the ranking is
 * produced by `lib/metrics` alone.
 */

export const HAPPY_PATH: readonly RunState[] = [
  'created',
  'validating',
  'tiling',
  'submitted',
  'polling',
  'normalizing',
  'quality_gate',
  'scoring',
  'awaiting_approval',
  'approved',
  'exported',
] as const

export const TERMINAL_STATES: ReadonlySet<RunState> = new Set([
  'exported',
  'blocked',
  'failed',
  'cancelled',
])

/** Any step may fail, be blocked, or be cancelled; nothing may skip forward. */
const ALTERNATE_TARGETS: readonly RunState[] = ['blocked', 'failed', 'cancelled']

const TRANSITIONS: Record<RunState, readonly RunState[]> = {
  created: ['validating', ...ALTERNATE_TARGETS],
  validating: ['tiling', ...ALTERNATE_TARGETS],
  // A run with no live path skips submission and polling, going straight to
  // normalising the fixture. That edge is explicit rather than implied.
  tiling: ['submitted', 'normalizing', ...ALTERNATE_TARGETS],
  submitted: ['polling', ...ALTERNATE_TARGETS],
  polling: ['normalizing', ...ALTERNATE_TARGETS],
  normalizing: ['quality_gate', ...ALTERNATE_TARGETS],
  quality_gate: ['scoring', ...ALTERNATE_TARGETS],
  scoring: ['awaiting_approval', ...ALTERNATE_TARGETS],
  awaiting_approval: ['approved', ...ALTERNATE_TARGETS],
  approved: ['exported', ...ALTERNATE_TARGETS],
  exported: [],
  blocked: [],
  failed: [],
  cancelled: [],
}

export function canTransition(from: RunState, to: RunState): boolean {
  return (TRANSITIONS[from] ?? []).includes(to)
}

export function allowedTransitions(from: RunState): readonly RunState[] {
  return TRANSITIONS[from] ?? []
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: RunState,
    readonly to: RunState,
  ) {
    super(
      `Illegal run transition ${from} -> ${to}. Allowed: ${
        (TRANSITIONS[from] ?? []).join(', ') || '(terminal)'
      }`,
    )
    this.name = 'InvalidTransitionError'
  }
}

export function assertTransition(from: RunState, to: RunState): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to)
}
