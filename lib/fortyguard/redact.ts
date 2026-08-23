/**
 * Secret redaction for logs, audit records and error messages.
 *
 * The rule this enforces: an API key must never reach a log line, an audit
 * event, a serialised error, or an export. Redaction is applied at the point
 * where data leaves the client, not at the point where it is written, so a new
 * call site cannot forget it.
 */

const SENSITIVE_HEADER_NAMES = new Set([
  'api-key',
  'apikey',
  'x-api-key',
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
])

export const REDACTED = '[REDACTED]'

export function isSensitiveHeader(name: string): boolean {
  return SENSITIVE_HEADER_NAMES.has(name.trim().toLowerCase())
}

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const output: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    output[name] = isSensitiveHeader(name) ? REDACTED : value
  }
  return output
}

/**
 * Remove any occurrence of the live secret from arbitrary text.
 *
 * Also strips query-string credentials and bearer tokens, because a signed
 * result URL echoed back in an error body would otherwise be logged verbatim.
 */
export function redactText(text: string, secrets: readonly string[] = []): string {
  let output = text
  for (const secret of secrets) {
    if (secret && secret.length >= 8) {
      output = output.split(secret).join(REDACTED)
    }
  }
  return output
    .replace(/([?&](?:api[_-]?key|key|token|signature|sig|x-amz-signature)=)[^&\s"']+/gi, `$1${REDACTED}`)
    .replace(/(bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi, `$1${REDACTED}`)
}

/** Deep-redact a JSON-serialisable value before it is logged or persisted. */
export function redactValue<T>(value: T, secrets: readonly string[] = []): T {
  const seen = new WeakSet<object>()

  const walk = (input: unknown): unknown => {
    if (typeof input === 'string') return redactText(input, secrets)
    if (Array.isArray(input)) return input.map(walk)
    if (input && typeof input === 'object') {
      if (seen.has(input as object)) return '[CIRCULAR]'
      seen.add(input as object)
      const output: Record<string, unknown> = {}
      for (const [key, child] of Object.entries(input as Record<string, unknown>)) {
        output[key] = isSensitiveHeader(key) ? REDACTED : walk(child)
      }
      return output
    }
    return input
  }

  return walk(value) as T
}
