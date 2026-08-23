import { describe, expect, it, vi } from 'vitest'
import { FortyGuardClient, type LogEvent } from '@/lib/fortyguard/client'
import { FortyGuardError } from '@/lib/fortyguard/errors'
import { MemoryResultCache } from '@/lib/fortyguard/cache'
import { planTiles, tileToPolygonAoi } from '@/lib/geo/tiles'
import { getAoi } from '@/lib/geo/aoi'
import type { HeatmapRequest } from '@/lib/fortyguard/schema'
import { normalizeFeatureCollection } from '@/lib/fortyguard/normalize'

/**
 * Integration tests against controlled fixtures.
 *
 * Everything the beta could plausibly do to us is represented here: alternative
 * envelopes, transient 404s, rate limits, server errors, timeouts, failed
 * activities, missing identifiers, missing geometry, off-host result URLs.
 * These are the tests that let the `fortyGuardContract` gate read PASS_FIXTURE
 * honestly while no key exists.
 */

const KEY = 'fg_test_1a2b3c4d5e6f7a8b9c0d'
const TILE = planTiles(getAoi('central-phoenix'), 9).tiles[0]!

const REQUEST: HeatmapRequest = {
  polygon_aoi: tileToPolygonAoi(TILE),
  date_time: { start_date: '2026-08-03', start_time: '14:00', filter_type: 1 },
  granularity: 60,
  analytic_type: 'tcm',
}

/** A minimal but structurally faithful heatmap FeatureCollection. */
function mapData(count = 4, base = 40) {
  return {
    type: 'FeatureCollection',
    features: Array.from({ length: count }, (_, index) => ({
      type: 'Feature',
      properties: { tcm: base + index * 0.5 },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-112.1 + index * 0.001, 33.45],
            [-112.099 + index * 0.001, 33.45],
            [-112.099 + index * 0.001, 33.451],
            [-112.1 + index * 0.001, 33.451],
            [-112.1 + index * 0.001, 33.45],
          ],
        ],
      },
    })),
  }
}

const SUBMIT_OK = {
  error: false,
  status_code: 200,
  message: 'Heatmap Submitted Successfully',
  data: { activity_id: 'f52d2453-6a59-4b31-afa3-8fe3bb1ac5df' },
}

function completed(result: unknown = { map_data: mapData(), stats_data: {} }) {
  return {
    error: false,
    status_code: 200,
    message: 'Completed',
    data: { activity_id: SUBMIT_OK.data.activity_id, status: 'Completed', result },
  }
}

function processing() {
  return {
    error: false,
    status_code: 200,
    message: 'Processing',
    data: { activity_id: SUBMIT_OK.data.activity_id, status: 'Processing' },
  }
}

interface Reply {
  status: number
  body?: unknown
  text?: string
  /** Extra response headers — `location` is how a redirect hop is scripted. */
  headers?: Record<string, string>
}

/** Scripted fetch: each call shifts the next reply off the queue. */
function scriptedFetch(replies: Reply[]) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = []
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    const reply = replies.shift() ?? { status: 500, body: { error: 'no scripted reply left' } }
    const text = reply.text ?? JSON.stringify(reply.body ?? {})
    return new Response(text, {
      status: reply.status,
      headers: { 'Content-Type': 'application/json', ...(reply.headers ?? {}) },
    })
  })
  return { impl: impl as unknown as typeof fetch, calls }
}

function makeClient(
  replies: Reply[],
  overrides: Partial<ConstructorParameters<typeof FortyGuardClient>[0]> = {},
) {
  const { impl, calls } = scriptedFetch(replies)
  let clock = 0
  const logs: LogEvent[] = []
  const client = new FortyGuardClient({
    apiKey: KEY,
    fetchImpl: impl,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms
    },
    random: () => 0.5,
    logger: (event) => logs.push(event),
    maxRetries: 2,
    ...overrides,
  })
  return { client, calls, logs, advance: (ms: number) => (clock += ms) }
}

/* -------------------------------------------------------------------------- */

describe('no-key mode', () => {
  it('never constructs a request without a key', async () => {
    const { impl, calls } = scriptedFetch([])
    const client = new FortyGuardClient({ apiKey: '', fetchImpl: impl })
    await expect(client.runHeatmap(REQUEST)).rejects.toMatchObject({ kind: 'NO_API_KEY' })
    expect(calls).toHaveLength(0)
  })
})

describe('happy path', () => {
  it('submits, polls and returns the FeatureCollection', async () => {
    const { client, calls } = makeClient([
      { status: 200, body: SUBMIT_OK },
      { status: 200, body: processing() },
      { status: 200, body: completed() },
    ])
    const result = await client.runHeatmap(REQUEST)

    expect(result.activityId).toBe(SUBMIT_OK.data.activity_id)
    expect(result.collection.features).toHaveLength(4)
    expect(result.contract.submitEnvelope).toBe('data.activity_id')
    expect(result.contract.statusEnvelopePath).toBe('data.result.map_data')
    expect(result.contract.pollAttempts).toBe(2)
    expect(result.contract.notes).toEqual([])
    expect(calls[0]!.url).toContain('/v1/heatmap')
    expect(calls[1]!.url).toContain('/v1/status/')
  })

  it('sends the key in the configured header and never logs it', async () => {
    const { client, calls, logs } = makeClient([
      { status: 200, body: SUBMIT_OK },
      { status: 200, body: completed() },
    ])
    await client.runHeatmap(REQUEST)
    const headers = calls[0]!.init!.headers as Record<string, string>
    expect(headers['api-key']).toBe(KEY)
    expect(JSON.stringify(logs)).not.toContain(KEY)
    expect(JSON.stringify(logs)).toContain('[REDACTED]')
  })

  it('accepts any 2xx on submission and records the deviation', async () => {
    const { client } = makeClient([
      { status: 202, body: SUBMIT_OK },
      { status: 200, body: completed() },
    ])
    const result = await client.runHeatmap(REQUEST)
    expect(result.contract.submitStatus).toBe(202)
    expect(result.contract.notes.join(' ')).toMatch(/HTTP 202, not the documented 200/)
  })
})

describe('alternative response envelopes', () => {
  it('finds a root-level activity_id and says so', async () => {
    const { client } = makeClient([
      { status: 200, body: { activity_id: 'abc-123' } },
      { status: 200, body: completed() },
    ])
    const result = await client.runHeatmap(REQUEST)
    expect(result.activityId).toBe('abc-123')
    expect(result.contract.notes.join(' ')).toMatch(/arrived as "activity_id"/)
  })

  it('finds a camelCase activity id', async () => {
    const { client } = makeClient([
      { status: 200, body: { data: { activityId: 'camel-1' } } },
      { status: 200, body: completed() },
    ])
    const result = await client.runHeatmap(REQUEST)
    expect(result.activityId).toBe('camel-1')
  })

  it('finds a FeatureCollection nested somewhere unexpected and records the path', async () => {
    const { client } = makeClient([
      { status: 200, body: SUBMIT_OK },
      {
        status: 200,
        body: {
          status: 'Completed',
          payload: { layers: [{ heatmap: mapData(3) }] },
        },
      },
    ])
    const result = await client.runHeatmap(REQUEST)
    expect(result.collection.features).toHaveLength(3)
    expect(result.contract.statusEnvelopePath).not.toBe('data.result.map_data')
    expect(result.contract.notes.join(' ')).toMatch(/FeatureCollection found at/)
  })

  it('keeps polling through an unrecognised status word rather than assuming success', async () => {
    const { client } = makeClient([
      { status: 200, body: SUBMIT_OK },
      { status: 200, body: { data: { status: 'warming-up' } } },
      { status: 200, body: completed() },
    ])
    const result = await client.runHeatmap(REQUEST)
    expect(result.contract.pollAttempts).toBe(2)
  })
})

describe('error handling', () => {
  it('classifies 401 and does not retry it', async () => {
    const { client, calls } = makeClient([{ status: 401, body: { detail: 'bad key' } }])
    await expect(client.runHeatmap(REQUEST)).rejects.toMatchObject({ kind: 'UNAUTHORIZED' })
    expect(calls).toHaveLength(1)
  })

  it('classifies 403', async () => {
    const { client } = makeClient([{ status: 403, body: { detail: 'plan' } }])
    await expect(client.runHeatmap(REQUEST)).rejects.toMatchObject({ kind: 'FORBIDDEN' })
  })

  it('classifies 400 and 422 as bad requests without retrying', async () => {
    const { client } = makeClient([{ status: 422, body: { detail: [] } }])
    await expect(client.runHeatmap(REQUEST)).rejects.toMatchObject({ kind: 'BAD_REQUEST' })
  })

  it('tolerates a 404 immediately after submission, then succeeds', async () => {
    const { client } = makeClient([
      { status: 200, body: SUBMIT_OK },
      { status: 404, body: { detail: 'not found yet' } },
      { status: 404, body: { detail: 'not found yet' } },
      { status: 200, body: completed() },
    ])
    const result = await client.runHeatmap(REQUEST)
    expect(result.contract.pollAttempts).toBe(3)
  })

  it('gives up on a 404 that outlives the grace window', async () => {
    const { client } = makeClient(
      [
        { status: 200, body: SUBMIT_OK },
        { status: 404, body: {} },
        { status: 404, body: {} },
        { status: 404, body: {} },
      ],
      { postSubmitNotFoundGraceMs: 1 },
    )
    await expect(client.runHeatmap(REQUEST)).rejects.toMatchObject({ kind: 'SCHEMA_MISMATCH' })
  })

  /* ---------------------------------------------------------------------- */
  /* A submission is sent exactly once, whatever comes back                  */
  /* ---------------------------------------------------------------------- */

  // These four used to assert the opposite. The client retried a 429, a 5xx and
  // a dropped connection up to four times, which is correct for an idempotent
  // endpoint and wrong for a billable one: no FortyGuard contract says
  // /v1/heatmap deduplicates, and each of these statuses can follow a request the
  // server already accepted. One flaky gateway could buy the same tile five
  // times. The behaviour is now "send once, surface the outcome".

  it('does NOT retry a 429 — exactly one POST leaves the process', async () => {
    const { client, calls } = makeClient([
      { status: 429, body: { detail: 'slow down' } },
      { status: 200, body: SUBMIT_OK },
      { status: 200, body: completed() },
    ])
    await expect(client.runHeatmap(REQUEST)).rejects.toMatchObject({ kind: 'RATE_LIMITED' })
    // The second and third replies were never reached: one call, then the error.
    expect(calls).toHaveLength(1)
    expect(calls[0]!.init?.method).toBe('POST')
  })

  it('does NOT retry a 5xx — exactly one POST leaves the process', async () => {
    const { client, calls } = makeClient([
      { status: 503, body: {} },
      { status: 200, body: SUBMIT_OK },
      { status: 200, body: completed() },
    ])
    await expect(client.runHeatmap(REQUEST)).rejects.toMatchObject({ kind: 'SERVER_ERROR' })
    expect(calls).toHaveLength(1)
  })

  it('reports a dropped POST as AMBIGUOUS_SUBMISSION rather than a clean failure', async () => {
    // The request may have arrived and started billable work. Calling this
    // NETWORK would invite a retry; calling it a failure would invite a resume.
    const failing = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })
    const client = new FortyGuardClient({
      apiKey: KEY,
      fetchImpl: failing as unknown as typeof fetch,
    })
    await expect(client.runHeatmap(REQUEST)).rejects.toMatchObject({
      kind: 'AMBIGUOUS_SUBMISSION',
    })
    expect(failing).toHaveBeenCalledTimes(1)
  })

  /*
   * The double-POST an independent audit reproduced.
   *
   * `fetch` follows redirects by default, and on a 307 or 308 it re-sends the
   * METHOD AND BODY. The manual-redirect handling was on the result URL — where
   * nothing is billed — while the submission used the default. One 307 from a
   * proxy or a moved endpoint turned one submission into two POSTs, so
   * "exactly once" was false for exactly the case that costs money.
   */
  it('does not follow a redirected POST — the audit reproduced two POSTs here', async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      const { client, calls } = makeClient([
        { status, body: {}, headers: { location: 'https://api.fortyguard.com/v2/heatmap' } },
        { status: 200, body: SUBMIT_OK },
        { status: 200, body: completed() },
      ])
      await expect(client.runHeatmap(REQUEST, { bypassCache: true })).rejects.toMatchObject({
        kind: 'AMBIGUOUS_SUBMISSION',
      })
      // One request left the process. The redirect target was never called.
      expect(calls, `HTTP ${status}`).toHaveLength(1)
      expect(calls[0]!.init?.redirect, `HTTP ${status}`).toBe('manual')
    }
  })

  it('sets redirect:manual on the submission itself, not only on result fetches', async () => {
    const { client, calls } = makeClient([
      { status: 200, body: SUBMIT_OK },
      { status: 200, body: completed() },
    ])
    await client.runHeatmap(REQUEST)
    const post = calls.find((call) => call.init?.method === 'POST')!
    expect(post.init?.redirect).toBe('manual')
  })

  it('follows a redirected GET, re-validating each hop against the allowlist', async () => {
    const ok = makeClient([
      { status: 200, body: SUBMIT_OK },
      { status: 302, body: {}, headers: { location: 'https://api.fortyguard.com/v1/status/x' } },
      { status: 200, body: completed() },
    ])
    await expect(ok.client.runHeatmap(REQUEST)).resolves.toBeTruthy()

    const offHost = makeClient([
      { status: 200, body: SUBMIT_OK },
      { status: 302, body: {}, headers: { location: 'https://evil.example.com/status' } },
    ])
    await expect(offHost.client.runHeatmap(REQUEST, { bypassCache: true })).rejects.toMatchObject({
      kind: 'BLOCKED_RESULT_HOST',
    })
  })

  it('refuses to send the key over plaintext or to an unattested host', () => {
    expect(() => new FortyGuardClient({ apiKey: KEY, baseUrl: 'http://api.fortyguard.com' })).toThrow(
      /must be https/,
    )
    expect(
      () =>
        new FortyGuardClient({
          apiKey: KEY,
          baseUrl: 'https://staging.example.com',
          attestedHost: 'api.fortyguard.com',
        }),
    ).toThrow(/the capability manifest\s+attests to/)
    // The attested host itself is fine, and so is an unattested client.
    expect(
      () =>
        new FortyGuardClient({
          apiKey: KEY,
          baseUrl: 'https://api.fortyguard.com/',
          attestedHost: 'api.fortyguard.com',
        }),
    ).not.toThrow()
  })

  it('records the intent to submit before the socket opens', async () => {
    const order: string[] = []
    const { client } = makeClient([
      { status: 200, body: SUBMIT_OK },
      { status: 200, body: completed() },
    ])
    await client.runHeatmap(REQUEST, {
      onSubmitIntent: () => order.push('intent'),
      onActivityId: () => order.push('activityId'),
    })
    expect(order).toEqual(['intent', 'activityId'])
  })

  it('still fires the intent hook when the submission then fails', async () => {
    // The whole point: a failure after the intent is exactly the case where the
    // journal entry is load-bearing.
    const intents: number[] = []
    const { client } = makeClient([{ status: 500, body: {} }])
    await expect(
      client.runHeatmap(REQUEST, { onSubmitIntent: () => intents.push(1) }),
    ).rejects.toThrow()
    expect(intents).toHaveLength(1)
  })

  it('treats a 2xx with no activity id as needing reconciliation, not as a failure', async () => {
    const { client } = makeClient([
      { status: 200, body: { data: {} } },
      { status: 200, body: { data: {} } },
    ])
    await expect(client.runHeatmap(REQUEST)).rejects.toMatchObject({ kind: 'NO_ACTIVITY_ID' })
    await expect(client.runHeatmap(REQUEST, { bypassCache: true })).rejects.toThrow(
      /Reconcile against the FortyGuard account/,
    )
  })

  it('times out a task that never finishes', async () => {
    const replies: Reply[] = [{ status: 200, body: SUBMIT_OK }]
    for (let index = 0; index < 200; index += 1) replies.push({ status: 200, body: processing() })
    const { client } = makeClient(replies, { pollTimeoutMs: 30_000 })
    await expect(client.runHeatmap(REQUEST)).rejects.toMatchObject({ kind: 'TIMEOUT' })
  })

  it('stops on a failed activity', async () => {
    const { client } = makeClient([
      { status: 200, body: SUBMIT_OK },
      { status: 200, body: { data: { status: 'Failed', activity_id: 'x' } } },
    ])
    await expect(client.runHeatmap(REQUEST)).rejects.toMatchObject({ kind: 'ACTIVITY_FAILED' })
  })

  it('fails when no activity id can be found in any envelope', async () => {
    const { client } = makeClient([{ status: 200, body: { message: 'ok' } }])
    await expect(client.runHeatmap(REQUEST)).rejects.toMatchObject({ kind: 'NO_ACTIVITY_ID' })
  })

  it('fails when the completed response carries no FeatureCollection', async () => {
    const { client } = makeClient([
      { status: 200, body: SUBMIT_OK },
      { status: 200, body: completed({ stats_data: { Temperature_stats: {} } }) },
    ])
    await expect(client.runHeatmap(REQUEST)).rejects.toMatchObject({
      kind: 'NO_FEATURE_COLLECTION',
    })
  })

  it('fails on an empty FeatureCollection rather than reporting a silent zero', async () => {
    const { client } = makeClient([
      { status: 200, body: SUBMIT_OK },
      { status: 200, body: completed({ map_data: { type: 'FeatureCollection', features: [] } }) },
    ])
    await expect(client.runHeatmap(REQUEST)).rejects.toMatchObject({ kind: 'PARTIAL_COVERAGE' })
  })

  it('rejects a request that fails local validation before any network call', async () => {
    const { client, calls } = makeClient([])
    await expect(
      client.runHeatmap({
        ...REQUEST,
        date_time: { ...REQUEST.date_time, start_date: '03-08-2026' },
      } as HeatmapRequest),
    ).rejects.toMatchObject({ kind: 'BAD_REQUEST' })
    expect(calls).toHaveLength(0)
  })

  it('redacts the key out of an error detail', async () => {
    const { client } = makeClient([{ status: 400, text: `bad key ${KEY}` }])
    try {
      await client.runHeatmap(REQUEST)
      throw new Error('should have thrown')
    } catch (error) {
      expect(JSON.stringify((error as FortyGuardError).detail)).not.toContain(KEY)
    }
  })
})

describe('remote result URLs (SSRF guard)', () => {
  it('follows a result URL on an allowlisted host', async () => {
    const { client } = makeClient(
      [
        { status: 200, body: SUBMIT_OK },
        { status: 200, body: completed({ download_link: 'https://api.fortyguard.com/results/1' }) },
        { status: 200, body: { map_data: mapData(2) } },
      ],
      { resultHostAllowlist: ['api.fortyguard.com'] },
    )
    const result = await client.runHeatmap(REQUEST)
    expect(result.collection.features).toHaveLength(2)
    expect(result.contract.resultFetchedFromUrl).toBe('https://api.fortyguard.com/results/1')
  })

  it('refuses a result URL on an unlisted host', async () => {
    const { client } = makeClient(
      [
        { status: 200, body: SUBMIT_OK },
        { status: 200, body: completed({ download_link: 'https://evil.example.com/x' }) },
      ],
      { resultHostAllowlist: ['api.fortyguard.com'] },
    )
    await expect(client.runHeatmap(REQUEST)).rejects.toMatchObject({
      kind: 'BLOCKED_RESULT_HOST',
    })
  })

  it('refuses a plaintext result URL', async () => {
    const { client } = makeClient([
      { status: 200, body: SUBMIT_OK },
      { status: 200, body: completed({ download_link: 'http://api.fortyguard.com/x' }) },
    ])
    await expect(client.runHeatmap(REQUEST)).rejects.toMatchObject({
      kind: 'BLOCKED_RESULT_HOST',
    })
  })

  it('accepts a subdomain of an allowlisted host but not a lookalike', async () => {
    const listed = makeClient(
      [
        { status: 200, body: SUBMIT_OK },
        { status: 200, body: completed({ result_url: 'https://cdn.fortyguard.com/x' }) },
        { status: 200, body: { map_data: mapData(1) } },
      ],
      { resultHostAllowlist: ['fortyguard.com'] },
    )
    await expect(listed.client.runHeatmap(REQUEST)).resolves.toBeTruthy()

    const lookalike = makeClient(
      [
        { status: 200, body: SUBMIT_OK },
        { status: 200, body: completed({ result_url: 'https://notfortyguard.com/x' }) },
      ],
      { resultHostAllowlist: ['fortyguard.com'] },
    )
    await expect(lookalike.client.runHeatmap(REQUEST)).rejects.toMatchObject({
      kind: 'BLOCKED_RESULT_HOST',
    })
  })

  /* ---------------------------------------------------------------------- */
  /* Every hop is checked, not only the first                               */
  /* ---------------------------------------------------------------------- */

  // `fetch` follows redirects itself by default, which checks the allowlist once
  // and then accepts whatever the chain ends at. An allowlisted host that 302s
  // to a metadata endpoint or an attacker's bucket would have been fetched and
  // reported as success. Redirects are followed by hand and re-validated.

  it('refuses a redirect from an allowlisted host to an unlisted one', async () => {
    const { client, calls } = makeClient([
      { status: 200, body: SUBMIT_OK },
      { status: 200, body: completed({ result_url: 'https://api.fortyguard.com/r/1' }) },
      { status: 302, body: {}, headers: { location: 'https://evil.example.com/steal' } },
    ])
    await expect(client.runHeatmap(REQUEST)).rejects.toMatchObject({
      kind: 'BLOCKED_RESULT_HOST',
    })
    // The redirect target was never fetched.
    expect(calls.some((call) => call.url.includes('evil.example.com'))).toBe(false)
  })

  it('refuses a redirect that downgrades to plaintext', async () => {
    const { client } = makeClient([
      { status: 200, body: SUBMIT_OK },
      { status: 200, body: completed({ result_url: 'https://api.fortyguard.com/r/2' }) },
      { status: 307, body: {}, headers: { location: 'http://api.fortyguard.com/r/2' } },
    ])
    await expect(client.runHeatmap(REQUEST)).rejects.toMatchObject({
      kind: 'BLOCKED_RESULT_HOST',
    })
  })

  it('refuses a redirect to a link-local address even from an allowlisted host', async () => {
    const { client } = makeClient([
      { status: 200, body: SUBMIT_OK },
      { status: 200, body: completed({ result_url: 'https://api.fortyguard.com/r/3' }) },
      { status: 302, body: {}, headers: { location: 'https://169.254.169.254/latest/meta-data/' } },
    ])
    await expect(client.runHeatmap(REQUEST)).rejects.toMatchObject({
      kind: 'BLOCKED_RESULT_HOST',
    })
  })

  it('follows an allowlisted redirect, and stops after the hop budget', async () => {
    const { client } = makeClient([
      { status: 200, body: SUBMIT_OK },
      { status: 200, body: completed({ result_url: 'https://api.fortyguard.com/r/4' }) },
      { status: 302, body: {}, headers: { location: 'https://api.fortyguard.com/r/4b' } },
      { status: 200, body: { map_data: mapData(2) } },
    ])
    await expect(client.runHeatmap(REQUEST)).resolves.toBeTruthy()

    const looping = makeClient([
      { status: 200, body: SUBMIT_OK },
      { status: 200, body: completed({ result_url: 'https://api.fortyguard.com/loop' }) },
      ...Array.from({ length: 8 }, () => ({
        status: 302,
        body: {},
        headers: { location: 'https://api.fortyguard.com/loop' },
      })),
    ])
    await expect(looping.client.runHeatmap(REQUEST)).rejects.toThrow(/redirects/)
  })

  it('refuses a redirect with no Location header rather than treating it as a body', async () => {
    const { client } = makeClient([
      { status: 200, body: SUBMIT_OK },
      { status: 200, body: completed({ result_url: 'https://api.fortyguard.com/r/5' }) },
      { status: 302, body: {} },
    ])
    await expect(client.runHeatmap(REQUEST)).rejects.toThrow(/no Location header/)
  })
})

describe('caching and resume', () => {
  it('serves an identical payload from cache without a second call', async () => {
    const cache = new MemoryResultCache<never>()
    const { client, calls } = makeClient(
      [
        { status: 200, body: SUBMIT_OK },
        { status: 200, body: completed() },
      ],
      { cache: cache as never },
    )
    const first = await client.runHeatmap(REQUEST)
    const second = await client.runHeatmap(REQUEST)
    expect(first.fromCache).toBe(false)
    expect(second.fromCache).toBe(true)
    expect(second.cacheKey).toBe(first.cacheKey)
    expect(calls).toHaveLength(2)
  })

  it('misses the cache when the payload differs', async () => {
    const { client, calls } = makeClient([
      { status: 200, body: SUBMIT_OK },
      { status: 200, body: completed() },
      { status: 200, body: SUBMIT_OK },
      { status: 200, body: completed() },
    ])
    await client.runHeatmap(REQUEST)
    await client.runHeatmap({
      ...REQUEST,
      date_time: { ...REQUEST.date_time, start_time: '17:00' },
    })
    expect(calls).toHaveLength(4)
  })

  it('resumes an existing activity without resubmitting', async () => {
    const { client, calls } = makeClient([{ status: 200, body: completed() }])
    const result = await client.runHeatmap(REQUEST, { resumeActivityId: 'existing-activity' })
    expect(result.activityId).toBe('existing-activity')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toContain('/v1/status/existing-activity')
    expect(result.contract.notes.join(' ')).toMatch(/Resumed existing activity/)
  })

  it('bypasses the cache on request', async () => {
    const { client, calls } = makeClient([
      { status: 200, body: SUBMIT_OK },
      { status: 200, body: completed() },
      { status: 200, body: SUBMIT_OK },
      { status: 200, body: completed() },
    ])
    await client.runHeatmap(REQUEST)
    await client.runHeatmap(REQUEST, { bypassCache: true })
    expect(calls).toHaveLength(4)
  })
})

describe('normalisation of returned cells', () => {
  it('de-duplicates cells shared by overlapping tiles', () => {
    const seen = new Set<string>()
    const first = normalizeFeatureCollection(mapData(4) as never, {
      valueField: 'tcm',
      snapshot: 's1',
      seen,
    })
    const second = normalizeFeatureCollection(mapData(4) as never, {
      valueField: 'tcm',
      snapshot: 's1',
      seen,
    })
    expect(first.cells).toHaveLength(4)
    expect(second.cells).toHaveLength(0)
    expect(second.duplicates).toBe(4)
  })

  it('keeps the same cell in different snapshots', () => {
    const seen = new Set<string>()
    const a = normalizeFeatureCollection(mapData(2) as never, {
      valueField: 'tcm',
      snapshot: 's1',
      seen,
    })
    const b = normalizeFeatureCollection(mapData(2) as never, {
      valueField: 'tcm',
      snapshot: 's2',
      seen,
    })
    expect(a.cells).toHaveLength(2)
    expect(b.cells).toHaveLength(2)
  })

  it('skips features with no geometry or no numeric value rather than defaulting them', () => {
    const broken = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: { tcm: 40 }, geometry: null },
        { type: 'Feature', properties: { tcm: 'hot' }, geometry: mapData(1).features[0]!.geometry },
        { type: 'Feature', properties: {}, geometry: mapData(1).features[0]!.geometry },
      ],
    }
    const outcome = normalizeFeatureCollection(broken as never, {
      valueField: 'tcm',
      snapshot: 's1',
    })
    expect(outcome.cells).toHaveLength(0)
    expect(outcome.skipped).toBe(3)
  })

  it('produces a deterministic order', () => {
    const forward = normalizeFeatureCollection(mapData(5) as never, {
      valueField: 'tcm',
      snapshot: 's1',
    })
    const shuffled = { ...mapData(5), features: [...mapData(5).features].reverse() }
    const reversed = normalizeFeatureCollection(shuffled as never, {
      valueField: 'tcm',
      snapshot: 's1',
    })
    expect(reversed.cells.map((cell) => cell.id)).toEqual(forward.cells.map((cell) => cell.id))
  })
})

describe('concurrency limit', () => {
  it('never runs more submissions at once than the configured limit', async () => {
    let inFlight = 0
    let peak = 0
    const impl = vi.fn(async (url: string | URL) => {
      const target = String(url)
      if (target.includes('/v1/heatmap')) {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 5))
        inFlight -= 1
        return new Response(JSON.stringify(SUBMIT_OK), { status: 200 })
      }
      return new Response(JSON.stringify(completed()), { status: 200 })
    })

    const client = new FortyGuardClient({
      apiKey: KEY,
      fetchImpl: impl as unknown as typeof fetch,
      maxConcurrency: 2,
      sleep: async () => {},
    })

    await Promise.all(
      [0, 1, 2, 3, 4, 5].map((index) =>
        client.runHeatmap({
          ...REQUEST,
          date_time: { ...REQUEST.date_time, start_time: `0${index}:00` },
        }),
      ),
    )
    expect(peak).toBeLessThanOrEqual(2)
  })
})
