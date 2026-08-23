export type FortyGuardErrorKind =
  | 'NO_API_KEY'
  | 'LIVE_DISABLED'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'RATE_LIMITED'
  | 'SERVER_ERROR'
  | 'BAD_REQUEST'
  | 'TIMEOUT'
  | 'ACTIVITY_FAILED'
  | 'NO_ACTIVITY_ID'
  | 'NO_FEATURE_COLLECTION'
  | 'SCHEMA_MISMATCH'
  | 'PARTIAL_COVERAGE'
  | 'BLOCKED_RESULT_HOST'
  | 'NETWORK'
  /**
   * A submission POST whose outcome is genuinely unknown.
   *
   * The connection dropped, or timed out, or the response could not be parsed —
   * so the request may have reached FortyGuard, been accepted, and started
   * billable work whose activity id we never received. There is no safe automatic
   * response to this. Retrying might buy the same tile twice; treating it as a
   * failure might abandon work already paid for. The only correct action is to
   * stop and have a person reconcile against the account.
   */
  | 'AMBIGUOUS_SUBMISSION'
  /** A budget or opt-in refused the submission before anything was sent. */
  | 'BUDGET_EXHAUSTED'

/** Errors carry a machine-readable kind so the gate layer can classify them. */
export class FortyGuardError extends Error {
  readonly kind: FortyGuardErrorKind
  readonly status: number | null
  readonly detail: unknown

  constructor(
    kind: FortyGuardErrorKind,
    message: string,
    options: { status?: number | null; detail?: unknown; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = 'FortyGuardError'
    this.kind = kind
    this.status = options.status ?? null
    this.detail = options.detail ?? null
  }
}

/**
 * Errors worth retrying **on a safe GET**, and only there.
 *
 * There is deliberately no equivalent for POST. A submission is the billable
 * event, and no FortyGuard contract establishes that `/v1/heatmap` is idempotent:
 * a 429, a 500, a timeout or a dropped connection can all follow a request the
 * server accepted, so a retry can buy the same tile twice. Until an official
 * contract proves otherwise, every POST is treated as non-idempotent and is sent
 * exactly once. See `FortyGuardClient.submitHeatmap`.
 */
export function isRetryablePoll(kind: FortyGuardErrorKind): boolean {
  return kind === 'RATE_LIMITED' || kind === 'SERVER_ERROR' || kind === 'NETWORK'
}

/**
 * Outcomes after which the operator, not the code, must decide what happens next.
 *
 * An ambiguous submission may have spent a credit. Resuming automatically is the
 * one thing that must never happen.
 */
export function requiresManualReconciliation(kind: FortyGuardErrorKind): boolean {
  return kind === 'AMBIGUOUS_SUBMISSION' || kind === 'NO_ACTIVITY_ID'
}

export function kindForStatus(status: number): FortyGuardErrorKind {
  if (status === 401) return 'UNAUTHORIZED'
  if (status === 403) return 'FORBIDDEN'
  if (status === 429) return 'RATE_LIMITED'
  if (status === 400 || status === 422) return 'BAD_REQUEST'
  if (status >= 500) return 'SERVER_ERROR'
  return 'SCHEMA_MISMATCH'
}
