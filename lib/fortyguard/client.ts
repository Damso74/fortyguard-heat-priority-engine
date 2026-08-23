import { FortyGuardError, isRetryablePoll, kindForStatus } from './errors'
import { MemoryResultCache, payloadHash, type ResultCache } from './cache'
import { redactHeaders, redactText, redactValue } from './redact'
import {
  HeatmapRequestSchema,
  extractActivityId,
  extractStatus,
  findFeatureCollection,
  findResultUrl,
  type FortyGuardFeatureCollection,
  type HeatmapRequest,
  type SubmitEnvelope,
} from './schema'

/**
 * Server-side FortyGuard client.
 *
 * Behaviour that is load-bearing for the product's honesty guarantees:
 *
 * - without an API key, no request is constructed at all. The client throws
 *   `NO_API_KEY` before touching the network, so a keyless deployment cannot
 *   produce a 401 that later reads like "we tried and the API was down".
 * - the observed response envelope is recorded on every call and surfaced in
 *   the capability report, rather than being assumed from the OpenAPI file.
 * - a result URL pointing off-host is refused unless its host is on an explicit
 *   allowlist (SSRF guard).
 * - the auth header never reaches a log, an error message or an audit record.
 */

if (typeof window !== 'undefined') {
  throw new Error('lib/fortyguard/client.ts is server-only and must not be bundled for the browser.')
}

export interface ObservedContract {
  submitStatus: number
  submitEnvelope: SubmitEnvelope | null
  statusEnvelopePath: string | null
  statusWord: string | null
  pollAttempts: number
  elapsedMs: number
  resultFetchedFromUrl: string | null
  featureCount: number
  notes: string[]
}

export interface HeatmapResult {
  activityId: string
  collection: FortyGuardFeatureCollection
  /** The completed status payload, redacted. Retained for the capability report. */
  rawStatus: unknown
  contract: ObservedContract
  fromCache: boolean
  cacheKey: string
}

export interface LogEvent {
  level: 'info' | 'warn' | 'error'
  message: string
  detail?: Record<string, unknown>
}

export interface FortyGuardClientOptions {
  apiKey: string
  baseUrl?: string
  /**
   * The host the capability manifest says its answers came from.
   *
   * When supplied, `baseUrl` must be exactly this host. Supplied by the capture
   * CLI from `capability.endpoint.host`.
   */
  attestedHost?: string
  authHeader?: string
  maxConcurrency?: number
  pollTimeoutMs?: number
  maxRetries?: number
  /** Grace period during which a 404 after submission is treated as "not yet visible". */
  postSubmitNotFoundGraceMs?: number
  resultHostAllowlist?: string[]
  cache?: ResultCache<HeatmapResult>
  fetchImpl?: typeof fetch
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** Deterministic jitter source for tests. */
  random?: () => number
  logger?: (event: LogEvent) => void
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Hops allowed when fetching a result URL.
 *
 * Small and fixed. Each hop is re-validated against the allowlist, so this is a
 * bound on effort rather than on trust — but a result that needs more than three
 * redirects is not one worth chasing.
 */
const MAX_RESULT_REDIRECTS = 3

/**
 * Where the key and the request are allowed to go.
 *
 * `FORTYGUARD_API_BASE_URL` was validated only as *a URL*: `http://` passed, any
 * host passed, and nothing compared it to the endpoint the capability manifest
 * says the answers were obtained from. So the key and the payload could be sent
 * to another host while the resulting snapshot attested the manifest's identity —
 * the fingerprint would match, because the fingerprint is computed from the
 * manifest rather than from where the request actually went.
 *
 * Two rules, both cheap and both absolute: the transport must be HTTPS, and when
 * an attested host is supplied the base URL must **be** that host. Overriding the
 * endpoint is legitimate — a staging environment exists — but it has to be done
 * by editing the manifest, which moves the fingerprint and invalidates every
 * snapshot captured under the old one. That is the correct consequence.
 */
export function assertAttestedBaseUrl(baseUrl: string, attestedHost?: string): string {
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch (cause) {
    throw new FortyGuardError('BAD_REQUEST', `FORTYGUARD_API_BASE_URL is not a valid URL.`, {
      cause,
    })
  }
  if (parsed.protocol !== 'https:') {
    throw new FortyGuardError(
      'BLOCKED_RESULT_HOST',
      `Refusing to send an API key over ${parsed.protocol}. FORTYGUARD_API_BASE_URL must be https.`,
    )
  }
  if (attestedHost && parsed.hostname.toLowerCase() !== attestedHost.toLowerCase()) {
    throw new FortyGuardError(
      'BLOCKED_RESULT_HOST',
      `FORTYGUARD_API_BASE_URL points at "${parsed.hostname}", but the capability manifest ` +
        `attests to "${attestedHost}". A capture sent elsewhere would record the manifest's ` +
        'identity for numbers it did not produce. Change the manifest endpoint deliberately — ' +
        'which moves the capability fingerprint and invalidates snapshots captured under the old ' +
        'one — or point the base URL back.',
    )
  }
  /*
   * Comparing the hostname alone left two ways to reach a different service on
   * an attested name: a port, and a path prefix. `https://api.fortyguard.com:8443`
   * and `https://api.fortyguard.com/proxy/elsewhere` both pass a hostname check
   * and both send the key somewhere the manifest never described.
   */
  if (attestedHost && parsed.port !== '') {
    throw new FortyGuardError(
      'BLOCKED_RESULT_HOST',
      `FORTYGUARD_API_BASE_URL names port ${parsed.port}. The capability manifest attests to a ` +
        'host, not a host and an arbitrary port; a different port is a different service.',
    )
  }
  if (attestedHost && parsed.pathname !== '/' && parsed.pathname !== '') {
    throw new FortyGuardError(
      'BLOCKED_RESULT_HOST',
      `FORTYGUARD_API_BASE_URL carries the path prefix "${parsed.pathname}". The endpoint paths ` +
        'come from the capability manifest, so a prefix here would silently redirect every ' +
        'documented route.',
    )
  }
  return baseUrl.replace(/\/+$/, '')
}

/** Minimal counting semaphore; keeps concurrent submissions under the plan limit. */
class Semaphore {
  private active = 0
  private readonly waiting: Array<() => void> = []

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1
      return () => this.release()
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve))
    this.active += 1
    return () => this.release()
  }

  private release(): void {
    this.active -= 1
    const next = this.waiting.shift()
    if (next) next()
  }
}

export class FortyGuardClient {
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly authHeader: string
  private readonly pollTimeoutMs: number
  private readonly maxRetries: number
  private readonly graceMs: number
  private readonly allowlist: string[]
  private readonly cache: ResultCache<HeatmapResult>
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly random: () => number
  private readonly logger: (event: LogEvent) => void
  private readonly semaphore: Semaphore

  constructor(options: FortyGuardClientOptions) {
    this.apiKey = options.apiKey ?? ''
    this.baseUrl = assertAttestedBaseUrl(
      options.baseUrl ?? 'https://api.fortyguard.com',
      options.attestedHost,
    )
    this.authHeader = options.authHeader ?? 'api-key'
    this.pollTimeoutMs = options.pollTimeoutMs ?? 600_000
    this.maxRetries = options.maxRetries ?? 4
    this.graceMs = options.postSubmitNotFoundGraceMs ?? 45_000
    this.allowlist = (options.resultHostAllowlist ?? ['api.fortyguard.com']).map((host) =>
      host.toLowerCase(),
    )
    this.cache = options.cache ?? new MemoryResultCache<HeatmapResult>()
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? (() => Date.now())
    this.sleep = options.sleep ?? defaultSleep
    this.random = options.random ?? Math.random
    this.logger = options.logger ?? (() => {})
    this.semaphore = new Semaphore(options.maxConcurrency ?? 2)
  }

  /**
   * Follow a redirect on a **safe** method, re-validating every hop.
   *
   * Only reachable for GET. Each `Location` goes through the same HTTPS and
   * allowlist check as the original URL, and the hop budget is small and fixed.
   */
  private async followSafely(
    from: URL,
    first: Response,
    method: 'GET' | 'POST',
    path: string,
  ): Promise<{ status: number; payload: unknown; text: string }> {
    let current = from
    let response = first

    for (let hop = 0; hop < MAX_RESULT_REDIRECTS; hop += 1) {
      const location = response.headers.get('location')
      if (!location) {
        throw new FortyGuardError(
          'BLOCKED_RESULT_HOST',
          `${method} ${path} returned HTTP ${response.status} with no Location header.`,
          { status: response.status },
        )
      }
      const next = this.assertFetchable(
        new URL(location, current).toString(),
        `Redirect ${hop + 1} from ${method} ${path}`,
      )
      this.log('info', `${method} ${path} redirected (${response.status})`, {
        hop: hop + 1,
        to: next.hostname,
      })
      current = next
      /*
       * The auth header goes to the API origin and nowhere else.
       *
       * The allowlist exists so a RESULT can be fetched from a CDN, which needs
       * no credential. Re-sending `headers()` on every hop meant a redirect from
       * the API to any allowlisted host — a bucket, a cache, a subdomain someone
       * else controls — handed that host the key. Same-origin redirects keep it,
       * because those are still the API.
       */
      const sameOrigin = current.origin === new URL(this.baseUrl).origin
      response = await this.fetchImpl(current.toString(), {
        method,
        headers: sameOrigin
          ? this.headers()
          : { Accept: 'application/json' },
        redirect: 'manual',
      })
      if (!sameOrigin) {
        this.log('info', 'Redirect left the API origin; the key was not sent', {
          to: current.hostname,
        })
      }
      if (response.status < 300 || response.status >= 400) {
        const text = await response.text()
        let payload: unknown = null
        if (text.trim().length > 0) {
          try {
            payload = JSON.parse(text)
          } catch {
            payload = { raw: redactText(text.slice(0, 2000), [this.apiKey]) }
          }
        }
        return { status: response.status, payload, text }
      }
    }

    throw new FortyGuardError(
      'BLOCKED_RESULT_HOST',
      `${method} ${path} exceeded ${MAX_RESULT_REDIRECTS} redirects. Refusing to follow further.`,
    )
  }

  /** Redact before anything leaves this class. */
  private log(level: LogEvent['level'], message: string, detail?: Record<string, unknown>): void {
    this.logger({
      level,
      message: redactText(message, [this.apiKey]),
      ...(detail ? { detail: redactValue(detail, [this.apiKey]) } : {}),
    })
  }

  private requireKey(): void {
    if (!this.apiKey) {
      throw new FortyGuardError(
        'NO_API_KEY',
        'No FortyGuard API key is configured. No request was made.',
      )
    }
  }

  private headers(): Record<string, string> {
    return {
      [this.authHeader]: this.apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    }
  }

  private backoffMs(attempt: number): number {
    const base = Math.min(30_000, 1_000 * 2 ** attempt)
    return Math.round(base * (0.5 + this.random() * 0.5))
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<{ status: number; payload: unknown; text: string }> {
    this.requireKey()
    const url = `${this.baseUrl}${path}`
    const init: RequestInit = {
      method,
      headers: this.headers(),
      // `fetch` follows redirects by default, and on a 307 or 308 it **re-sends
      // the body and the method**. That turned one submission into two POSTs, in
      // the one place in this project where a second request costs money — the
      // manual handling was on the result URL, which is not where the billing is.
      //
      // Nothing here follows a redirect. GET polling resolves hops explicitly in
      // `followSafely`; a redirected POST is refused outright, because the origin
      // may or may not have accepted the request and there is no way to tell.
      redirect: 'manual',
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }

    let response: Response
    try {
      response = await this.fetchImpl(url, init)
    } catch (cause) {
      // On a POST the request may already have reached the server and started
      // billable work. The caller must not treat that as a plain failure.
      throw new FortyGuardError(
        method === 'POST' ? 'AMBIGUOUS_SUBMISSION' : 'NETWORK',
        `Network failure calling ${method} ${path}`,
        { cause },
      )
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location') ?? '(none)'
      if (method === 'POST') {
        // 307 and 308 preserve the method and body, so following this is a second
        // submission. 302 and 303 can equally follow work the origin already
        // accepted. Neither case can be told apart from here.
        throw new FortyGuardError(
          'AMBIGUOUS_SUBMISSION',
          `POST ${path} was redirected (HTTP ${response.status} to ${location}). It was NOT ` +
            'followed: a 307 or 308 would re-send the body as a second billable submission, and a ' +
            '302 can follow a submission the origin already accepted. Reconcile against the ' +
            'FortyGuard account before submitting anything else, and check ' +
            'FORTYGUARD_API_BASE_URL.',
          { status: response.status },
        )
      }
      // Safe methods resolve their own hops, re-validating each one.
      return this.followSafely(new URL(url), response, method, path)
    }

    let text: string
    try {
      text = await response.text()
    } catch (cause) {
      throw new FortyGuardError(
        method === 'POST' ? 'AMBIGUOUS_SUBMISSION' : 'NETWORK',
        `The ${method} ${path} response body could not be read`,
        { status: response.status, cause },
      )
    }
    let payload: unknown = null
    if (text.trim().length > 0) {
      try {
        payload = JSON.parse(text)
      } catch {
        payload = { raw: redactText(text.slice(0, 2000), [this.apiKey]) }
      }
    }
    this.log('info', `${method} ${path} -> ${response.status}`, {
      headersSent: redactHeaders(this.headers()),
      bytes: text.length,
    })
    return { status: response.status, payload, text }
  }

  /**
   * POST /v1/heatmap — **exactly once, never retried**.
   *
   * Accepts any 2xx, because the beta documents 200 while FastAPI applications
   * routinely answer 201/202 for async submissions.
   *
   * ## Why there is no retry
   *
   * A submission is the billable event, and no published FortyGuard contract says
   * `/v1/heatmap` is idempotent — there is no idempotency key in the OpenAPI file
   * and no documented deduplication. So every failure mode a retry loop would
   * treat as "nothing happened" is a failure mode in which the server may already
   * have accepted the request and started work:
   *
   * - **429** can be returned *after* the job is queued;
   * - **5xx** can be a failure in the response path of a request that succeeded;
   * - a **timeout** or **dropped connection** says nothing at all about the
   *   server's state;
   * - a **2xx with no parseable activity id** means work may exist that we cannot
   *   name.
   *
   * The previous version retried the first three up to four times, so one flaky
   * gateway could buy the same tile five times. It now sends once. Transport
   * ambiguity surfaces as `AMBIGUOUS_SUBMISSION`, which the capture layer turns
   * into a hard stop for manual reconciliation rather than a resume.
   *
   * Polling GETs are a different matter and do retry — see `pollActivity`.
   */
  async submitHeatmap(
    request: HeatmapRequest,
    options: {
      /**
       * Called **before** the request is sent, so the intent to spend is durable
       * even if the process dies between the write and the response.
       */
      onSubmitIntent?: () => void
    } = {},
  ): Promise<{ activityId: string; envelope: SubmitEnvelope; status: number; raw: unknown }> {
    const parsed = HeatmapRequestSchema.safeParse(request)
    if (!parsed.success) {
      throw new FortyGuardError(
        'BAD_REQUEST',
        `Heatmap request failed local validation: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')}`,
      )
    }

    // Recorded before the socket opens. Everything after this point may have cost
    // money, including the paths that look like clean failures.
    options.onSubmitIntent?.()

    const { status, payload } = await this.request('POST', '/v1/heatmap', parsed.data)

    if (status >= 200 && status < 300) {
      const found = extractActivityId(payload)
      if (!found) {
        throw new FortyGuardError(
          'NO_ACTIVITY_ID',
          'Submission was accepted but no activity_id was found in any known envelope. Work may ' +
            'be running that this run cannot name or resume. Reconcile against the FortyGuard ' +
            'account before submitting anything else.',
          { status, detail: redactValue(payload, [this.apiKey]) },
        )
      }
      return { activityId: found.activityId, envelope: found.envelope, status, raw: payload }
    }

    const kind = kindForStatus(status)
    throw new FortyGuardError(
      kind,
      `Heatmap submission failed with HTTP ${status}. It was NOT retried: /v1/heatmap is treated ` +
        'as non-idempotent, so a retry could pay for the same tile twice.',
      { status, detail: redactValue(payload, [this.apiKey]) },
    )
  }

  /**
   * GET /v1/status/{id} until terminal.
   *
   * A 404 inside the grace window is treated as "the activity is not visible
   * yet", which the documentation explicitly lists as expected behaviour
   * immediately after submission. After the window it is a hard failure.
   */
  async pollActivity(
    activityId: string,
    startedAt = this.now(),
  ): Promise<{ payload: unknown; attempts: number; statusWord: string; elapsedMs: number }> {
    let attempts = 0
    let consecutiveRetryable = 0

    for (;;) {
      const elapsed = this.now() - startedAt
      if (elapsed > this.pollTimeoutMs) {
        throw new FortyGuardError(
          'TIMEOUT',
          `Activity ${activityId} did not reach a terminal state within ${Math.round(this.pollTimeoutMs / 1000)}s.`,
        )
      }

      attempts += 1
      const { status, payload } = await this.request(
        'GET',
        `/v1/status/${encodeURIComponent(activityId)}`,
      )

      if (status === 404) {
        if (elapsed <= this.graceMs) {
          await this.sleep(this.pollDelay(attempts))
          continue
        }
        throw new FortyGuardError('SCHEMA_MISMATCH', `Activity ${activityId} not found (HTTP 404).`, {
          status,
        })
      }

      if (status >= 200 && status < 300) {
        consecutiveRetryable = 0
        const { raw, phase } = extractStatus(payload)
        if (phase === 'completed') {
          return { payload, attempts, statusWord: raw, elapsedMs: this.now() - startedAt }
        }
        if (phase === 'failed') {
          throw new FortyGuardError('ACTIVITY_FAILED', `Activity ${activityId} reported "${raw}".`, {
            status,
            detail: redactValue(payload, [this.apiKey]),
          })
        }
        // `pending` and `unknown` both keep polling: an unrecognised status word
        // is not evidence of success, and the timeout bounds the loop.
        await this.sleep(this.pollDelay(attempts))
        continue
      }

      const kind = kindForStatus(status)
      // Safe to retry: a GET buys nothing, so a bounded backoff here cannot
      // double-spend. This is the only retry loop in the client.
      if (isRetryablePoll(kind)) {
        consecutiveRetryable += 1
        if (consecutiveRetryable > this.maxRetries) {
          throw new FortyGuardError(kind, `Polling ${activityId} failed with HTTP ${status}.`, {
            status,
            detail: redactValue(payload, [this.apiKey]),
          })
        }
        await this.sleep(this.backoffMs(consecutiveRetryable))
        continue
      }

      throw new FortyGuardError(kind, `Polling ${activityId} failed with HTTP ${status}.`, {
        status,
        detail: redactValue(payload, [this.apiKey]),
      })
    }
  }

  private pollDelay(attempt: number): number {
    return attempt <= 6 ? 5_000 : 10_000
  }

  /** Is this URL one we are willing to fetch at all? */
  private assertFetchable(url: string, label: string): URL {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch (cause) {
      throw new FortyGuardError('BLOCKED_RESULT_HOST', `${label} is not a valid URL.`, { cause })
    }
    if (parsed.protocol !== 'https:') {
      throw new FortyGuardError(
        'BLOCKED_RESULT_HOST',
        `Refusing to fetch ${label} over ${parsed.protocol}; https is required.`,
      )
    }
    const host = parsed.hostname.toLowerCase()
    const permitted = this.allowlist.some((entry) => host === entry || host.endsWith(`.${entry}`))
    if (!permitted) {
      throw new FortyGuardError(
        'BLOCKED_RESULT_HOST',
        `${label} host "${host}" is not on the allowlist (${this.allowlist.join(', ')}). Refusing to fetch.`,
      )
    }
    return parsed
  }

  /**
   * Fetch a result hosted off the API origin, checking **every** hop.
   *
   * `fetch` follows redirects itself by default, which checks the allowlist once
   * and then lets the response come from wherever the chain ends: an allowlisted
   * host that 302s to `169.254.169.254` or to an attacker's bucket would have
   * been fetched, and the guard would have reported success. Redirects are
   * therefore followed by hand with `redirect: 'manual'`, and each `Location` is
   * put through the same check as the original URL.
   *
   * The hop budget is small and fixed. A result URL that needs more than a few
   * redirects is not a result URL worth trusting.
   */
  private async fetchResultUrl(url: string): Promise<unknown> {
    const chain: string[] = []
    let current = this.assertFetchable(url, 'Result URL')

    for (let hop = 0; hop <= MAX_RESULT_REDIRECTS; hop += 1) {
      chain.push(current.toString())
      const response = await this.fetchImpl(current.toString(), {
        method: 'GET',
        redirect: 'manual',
      })

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        if (!location) {
          throw new FortyGuardError(
            'BLOCKED_RESULT_HOST',
            `Result URL returned HTTP ${response.status} with no Location header.`,
            { status: response.status },
          )
        }
        // Relative Locations are legal and resolve against the current URL.
        const next = this.assertFetchable(
          new URL(location, current).toString(),
          `Redirect ${hop + 1} from the result URL`,
        )
        this.log('info', `Result URL redirected (${response.status})`, {
          hop: hop + 1,
          to: next.hostname,
        })
        current = next
        continue
      }

      if (!response.ok) {
        throw new FortyGuardError(
          'SERVER_ERROR',
          `Result URL responded with HTTP ${response.status}.`,
          { status: response.status },
        )
      }
      return response.json()
    }

    throw new FortyGuardError(
      'BLOCKED_RESULT_HOST',
      `Result URL exceeded ${MAX_RESULT_REDIRECTS} redirects (${chain.length} hops). Refusing to follow further.`,
    )
  }

  /**
   * Full heatmap round trip: cache lookup, submit, poll, locate the
   * FeatureCollection, and record the contract that was actually observed.
   */
  async runHeatmap(
    request: HeatmapRequest,
    options: {
      resumeActivityId?: string
      bypassCache?: boolean
      /**
       * Called the instant a submission returns an activity id, before any
       * polling.
       *
       * A capture spends a credit at submission, not at completion, so the id
       * has to be durably recorded before anything else can fail. Without this
       * hook a crash during the first poll lost the record of work already paid
       * for, and the next attempt bought it again.
       */
      onActivityId?: (activityId: string) => void
      /**
       * Called immediately before the POST leaves this process.
       *
       * The journal entry it writes is what makes an ambiguous outcome
       * recoverable: without it, a crash between "decided to submit" and "got an
       * id" leaves no record that money may have been spent.
       */
      onSubmitIntent?: () => void
    } = {},
  ): Promise<HeatmapResult> {
    const cacheKey = payloadHash(request)
    if (!options.bypassCache && !options.resumeActivityId) {
      const hit = this.cache.get(cacheKey)
      if (hit) {
        this.log('info', 'Heatmap cache hit', { cacheKey })
        return { ...hit.value, fromCache: true }
      }
    }

    const release = await this.semaphore.acquire()
    try {
      const startedAt = this.now()
      const notes: string[] = []
      if (options.resumeActivityId !== undefined && options.resumeActivityId.trim() === '') {
        // Falling through to the submit branch here is how a caller that thought
        // it was resuming ends up buying the tile again.
        throw new FortyGuardError(
          'BAD_REQUEST',
          'resumeActivityId was supplied but blank. Refusing to guess whether this is a resume ' +
            'or a new submission — the two differ by the price.',
        )
      }
      let activityId = options.resumeActivityId ?? ''
      let submitStatus = 0
      let submitEnvelope: SubmitEnvelope | null = null

      if (activityId) {
        notes.push(`Resumed existing activity ${activityId} without resubmitting.`)
      } else {
        const submitted = await this.submitHeatmap(request, {
          onSubmitIntent: options.onSubmitIntent,
        })
        activityId = submitted.activityId
        submitStatus = submitted.status
        submitEnvelope = submitted.envelope
        // The credit is spent. Record the id before polling can fail.
        options.onActivityId?.(activityId)
        if (submitted.status !== 200) {
          notes.push(`Submission returned HTTP ${submitted.status}, not the documented 200.`)
        }
        if (submitted.envelope !== 'data.activity_id') {
          notes.push(
            `activity_id arrived as "${submitted.envelope}", not the documented "data.activity_id".`,
          )
        }
      }

      const polled = await this.pollActivity(activityId, startedAt)

      let statusPayload: unknown = polled.payload
      let resultFetchedFromUrl: string | null = null
      let located = findFeatureCollection(statusPayload)

      if (!located) {
        const url = findResultUrl(statusPayload)
        if (url) {
          notes.push('Result was delivered as a URL rather than inline.')
          statusPayload = await this.fetchResultUrl(url)
          resultFetchedFromUrl = url
          located = findFeatureCollection(statusPayload)
        }
      }

      if (!located) {
        throw new FortyGuardError(
          'NO_FEATURE_COLLECTION',
          'Completed activity contained no GeoJSON FeatureCollection in any known location.',
          { detail: redactValue(statusPayload, [this.apiKey]) },
        )
      }

      if (located.path !== 'data.result.map_data') {
        notes.push(`FeatureCollection found at "${located.path}", not "data.result.map_data".`)
      }
      if (located.collection.features.length === 0) {
        throw new FortyGuardError(
          'PARTIAL_COVERAGE',
          'Completed activity returned an empty FeatureCollection.',
        )
      }

      const result: HeatmapResult = {
        activityId,
        collection: located.collection,
        rawStatus: redactValue(polled.payload, [this.apiKey]),
        contract: {
          submitStatus,
          submitEnvelope,
          statusEnvelopePath: located.path,
          statusWord: polled.statusWord || null,
          pollAttempts: polled.attempts,
          elapsedMs: polled.elapsedMs,
          resultFetchedFromUrl,
          featureCount: located.collection.features.length,
          notes,
        },
        fromCache: false,
        cacheKey,
      }

      this.cache.set(cacheKey, { value: result, storedAt: this.now(), activityId })
      return result
    } finally {
      release()
    }
  }

  cacheSize(): number {
    return this.cache.size()
  }
}
