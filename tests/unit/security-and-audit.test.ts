import { describe, expect, it } from 'vitest'
import { AuditLog, deriveRunId } from '@/lib/audit/log'
import {
  InvalidTransitionError,
  allowedTransitions,
  assertTransition,
  canTransition,
  HAPPY_PATH,
  TERMINAL_STATES,
} from '@/lib/agent/state-machine'
import { REDACTED, isSensitiveHeader, redactHeaders, redactText, redactValue } from '@/lib/fortyguard/redact'
import { escapeCsvCell, sanitizeCsvValue, toCsv, withCsvPreamble } from '@/lib/export/csv'
import { canonicalize, payloadHash, MemoryResultCache } from '@/lib/fortyguard/cache'

const SECRET = 'fg_live_9c3b8a1d2e4f5a6b7c8d9e0f'

/* -------------------------------------------------------------------------- */
/* Redaction                                                                  */
/* -------------------------------------------------------------------------- */

describe('secret redaction', () => {
  it('recognises every auth header spelling used by the API and its neighbours', () => {
    for (const name of ['api-key', 'API-KEY', 'x-api-key', 'Authorization', 'Cookie']) {
      expect(isSensitiveHeader(name), name).toBe(true)
    }
    expect(isSensitiveHeader('content-type')).toBe(false)
  })

  it('replaces header values without dropping the header name', () => {
    const redacted = redactHeaders({ 'api-key': SECRET, 'Content-Type': 'application/json' })
    expect(redacted['api-key']).toBe(REDACTED)
    expect(redacted['Content-Type']).toBe('application/json')
    expect(JSON.stringify(redacted)).not.toContain(SECRET)
  })

  it('strips the secret out of arbitrary text', () => {
    const text = `Request failed with key ${SECRET} attached`
    expect(redactText(text, [SECRET])).not.toContain(SECRET)
    expect(redactText(text, [SECRET])).toContain(REDACTED)
  })

  it('strips credentials out of query strings and bearer tokens', () => {
    expect(redactText('https://x.test/r?api_key=abcdef123456&z=1')).toContain(REDACTED)
    expect(redactText('https://x.test/r?api_key=abcdef123456&z=1')).toContain('z=1')
    expect(redactText('https://s3.test/o?X-Amz-Signature=deadbeefcafe1234')).toContain(REDACTED)
    expect(redactText('Authorization: Bearer abcdefghijklmnop')).toContain(REDACTED)
  })

  it('deep-redacts nested structures and survives cycles', () => {
    const payload: Record<string, unknown> = {
      headers: { 'api-key': SECRET },
      nested: { note: `key=${SECRET}` },
      list: [SECRET],
    }
    payload.self = payload
    const redacted = redactValue(payload, [SECRET])
    expect(JSON.stringify(redacted)).not.toContain(SECRET)
  })
})

/* -------------------------------------------------------------------------- */
/* State machine                                                              */
/* -------------------------------------------------------------------------- */

describe('run state machine', () => {
  it('walks the documented happy path', () => {
    for (let index = 0; index < HAPPY_PATH.length - 1; index += 1) {
      expect(canTransition(HAPPY_PATH[index]!, HAPPY_PATH[index + 1]!)).toBe(true)
    }
  })

  it('refuses to skip a step', () => {
    expect(canTransition('created', 'scoring')).toBe(false)
    expect(canTransition('validating', 'exported')).toBe(false)
    expect(() => assertTransition('created', 'approved')).toThrow(InvalidTransitionError)
  })

  it('refuses to move backwards', () => {
    expect(canTransition('scoring', 'tiling')).toBe(false)
    expect(canTransition('exported', 'scoring')).toBe(false)
  })

  it('allows the keyless shortcut from tiling straight to normalizing', () => {
    expect(canTransition('tiling', 'normalizing')).toBe(true)
    expect(canTransition('tiling', 'submitted')).toBe(true)
  })

  it('lets any live step fail, block or cancel', () => {
    for (const state of ['validating', 'tiling', 'submitted', 'polling', 'scoring'] as const) {
      expect(canTransition(state, 'failed')).toBe(true)
      expect(canTransition(state, 'blocked')).toBe(true)
      expect(canTransition(state, 'cancelled')).toBe(true)
    }
  })

  it('treats terminal states as terminal', () => {
    for (const state of TERMINAL_STATES) {
      expect(allowedTransitions(state)).toHaveLength(0)
    }
  })
})

/* -------------------------------------------------------------------------- */
/* Audit                                                                      */
/* -------------------------------------------------------------------------- */

describe('audit log', () => {
  const clock = () => new Date('2026-08-04T12:00:00.000Z')

  it('records a creation event and increments a sequence', () => {
    const log = new AuditLog('run_test', clock)
    log.transition({
      step: 'validating',
      inputSummary: 'in',
      outputSummary: 'out',
      decision: 'ok',
      source: 'test',
    })
    expect(log.records).toHaveLength(2)
    expect(log.records.map((event) => event.sequence)).toEqual([0, 1])
    expect(log.state).toBe('validating')
  })

  it('hashes the payload it was given so a tampered export is detectable', () => {
    const log = new AuditLog('run_test', clock)
    const event = log.transition({
      step: 'validating',
      inputSummary: 'in',
      outputSummary: 'out',
      decision: 'ok',
      source: 'test',
      payloadForHash: { a: 1 },
    })
    expect(event.hash).toMatch(/^[a-f0-9]{32}$/)

    const other = new AuditLog('run_test', clock)
    const changed = other.transition({
      step: 'validating',
      inputSummary: 'in',
      outputSummary: 'out',
      decision: 'ok',
      source: 'test',
      payloadForHash: { a: 2 },
    })
    expect(changed.hash).not.toBe(event.hash)
  })

  it('redacts secrets on the way in, not on the way out', () => {
    const log = new AuditLog('run_test', clock, [SECRET])
    const event = log.transition({
      step: 'validating',
      inputSummary: `submitted with ${SECRET}`,
      outputSummary: 'ok',
      decision: 'ok',
      source: 'test',
      error: `failed using ${SECRET}`,
    })
    expect(event.inputSummary).not.toContain(SECRET)
    expect(event.error).not.toContain(SECRET)
    expect(JSON.stringify(log.toJSON())).not.toContain(SECRET)
  })

  it('rejects an illegal transition rather than recording it', () => {
    const log = new AuditLog('run_test', clock)
    expect(() =>
      log.transition({
        step: 'exported',
        inputSummary: '',
        outputSummary: '',
        decision: '',
        source: 'test',
      }),
    ).toThrow(InvalidTransitionError)
    expect(log.records).toHaveLength(1)
  })

  it('derives a stable run id from inputs only, never from the clock', () => {
    const parts = {
      request: { a: 1 },
      datasetSha256: 'abc',
      engineVersion: '1.0.0',
      thermalSha256: 'thermal-1',
    }
    expect(deriveRunId(parts)).toBe(deriveRunId(parts))
    expect(deriveRunId({ ...parts, datasetSha256: 'def' })).not.toBe(deriveRunId(parts))
    expect(deriveRunId(parts)).toMatch(/^run_[a-f0-9]{16}$/)
  })

  it('covers the thermal surface, so two surfaces cannot share a run id', () => {
    // Without this, the same request against a fixture and against a real
    // capture produced the same id, and an export could not be checked against
    // the numbers it was built from.
    const parts = {
      request: { a: 1 },
      datasetSha256: 'abc',
      engineVersion: '1.0.0',
      thermalSha256: 'thermal-1',
    }
    expect(deriveRunId({ ...parts, thermalSha256: 'thermal-2' })).not.toBe(deriveRunId(parts))
  })
})

/* -------------------------------------------------------------------------- */
/* CSV export safety                                                          */
/* -------------------------------------------------------------------------- */

describe('CSV export', () => {
  it('neutralises formula injection', () => {
    expect(sanitizeCsvValue('=cmd|"/c calc"!A1')).toBe("'=cmd|\"/c calc\"!A1")
    expect(sanitizeCsvValue('+1+1')).toBe("'+1+1")
    expect(sanitizeCsvValue('@SUM(A1)')).toBe("'@SUM(A1)")
    expect(sanitizeCsvValue('-cmd')).toBe("'-cmd")
  })

  it('leaves genuine negative numbers numeric', () => {
    expect(sanitizeCsvValue('-3.5')).toBe('-3.5')
    expect(sanitizeCsvValue(-42)).toBe('-42')
  })

  it('strips control characters that would break row structure', () => {
    expect(sanitizeCsvValue('a bc')).toBe('abc')
  })

  it('quotes and escapes per RFC 4180', () => {
    expect(escapeCsvCell('plain')).toBe('plain')
    expect(escapeCsvCell('has,comma')).toBe('"has,comma"')
    expect(escapeCsvCell('has "quote"')).toBe('"has ""quote"""')
    expect(escapeCsvCell('line\nbreak')).toBe('"line\nbreak"')
  })

  it('writes a header row and CRLF line endings', () => {
    const csv = toCsv([{ a: 1, b: 'x' }], ['a', 'b'])
    expect(csv).toBe('a,b\r\n1,x\r\n')
  })

  it('keeps a preamble on one line per key', () => {
    const csv = withCsvPreamble('a\r\n1\r\n', { note: 'multi\nline\nvalue' })
    expect(csv.split('\r\n')[0]).toBe('# note: multi line value')
  })

  it('never emits a raw null or undefined', () => {
    expect(toCsv([{ a: null, b: undefined }], ['a', 'b'])).toBe('a,b\r\n,\r\n')
  })
})

/* -------------------------------------------------------------------------- */
/* Cache keying                                                               */
/* -------------------------------------------------------------------------- */

describe('payload cache keys', () => {
  it('is insensitive to key order', () => {
    expect(payloadHash({ a: 1, b: 2 })).toBe(payloadHash({ b: 2, a: 1 }))
  })

  it('is sensitive to values', () => {
    expect(payloadHash({ a: 1 })).not.toBe(payloadHash({ a: 2 }))
  })

  it('rounds coordinates so tile arithmetic noise does not fragment the cache', () => {
    expect(canonicalize(-112.030000000001)).toBe(-112.03)
    expect(payloadHash({ lon: -112.03 })).toBe(payloadHash({ lon: -112.030000000001 }))
  })

  it('drops undefined rather than serialising it', () => {
    expect(canonicalize({ a: 1, b: undefined })).toEqual({ a: 1 })
  })

  it('evicts oldest entries past the bound', () => {
    const cache = new MemoryResultCache<number>(2)
    cache.set('a', { value: 1, storedAt: 0, activityId: null })
    cache.set('b', { value: 2, storedAt: 0, activityId: null })
    cache.set('c', { value: 3, storedAt: 0, activityId: null })
    expect(cache.size()).toBe(2)
    expect(cache.has('a')).toBe(false)
    expect(cache.has('c')).toBe(true)
  })
})
