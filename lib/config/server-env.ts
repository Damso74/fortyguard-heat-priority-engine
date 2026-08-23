import { z } from 'zod'

/**
 * Server-only configuration.
 *
 * Importing this module from a client component is a runtime error rather than
 * a silent secret leak. Nothing here is prefixed `NEXT_PUBLIC_`, so Next never
 * inlines any of it into the browser bundle; the guard exists to catch an
 * accidental `'use client'` at the top of a file that imports it.
 */
if (typeof window !== 'undefined') {
  throw new Error(
    'lib/config/server-env.ts was imported from client code. It reads secrets and must stay on the server.',
  )
}

const booleanish = z
  .string()
  .trim()
  .transform((value) => value === '1' || value.toLowerCase() === 'true')

const ServerEnvSchema = z.object({
  FORTYGUARD_API_KEY: z.string().trim().default(''),
  /**
   * HTTPS only. `.url()` alone accepted `http://`, which would put the API key on
   * the wire in clear. The host is additionally checked against the capability
   * manifest's attested endpoint when the client is constructed.
   */
  FORTYGUARD_API_BASE_URL: z
    .string()
    .trim()
    .url()
    .refine((value) => value.startsWith('https://'), {
      message: 'FORTYGUARD_API_BASE_URL must be https — the API key travels on it.',
    })
    .default('https://api.fortyguard.com'),
  FORTYGUARD_AUTH_HEADER: z.string().trim().min(1).default('api-key'),
  FORTYGUARD_MAX_TILE_SQ_MI: z.coerce.number().positive().max(50).default(9),
  FORTYGUARD_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
  FORTYGUARD_POLL_TIMEOUT_SECONDS: z.coerce.number().int().min(10).max(3600).default(600),
  FORTYGUARD_RESULT_HOST_ALLOWLIST: z.string().trim().default('api.fortyguard.com'),
  RUN_LIVE_FORTYGUARD: booleanish.default(false),
  /**
   * Where the thermal layer comes from.
   *
   * - `cached_real` — serve the committed immutable snapshot. No network access,
   *   reproducible, and the only mode a public deployment should run in.
   * - `demo` — the labelled synthetic fixture.
   * - `auto` — `cached_real` when a snapshot is present, otherwise `demo`.
   *
   * There is deliberately **no** `live` value. A live capture spends credits and
   * cannot be reached from a page render at all; it happens in a local CLI that
   * refuses to run in a hosted environment and writes a snapshot the app serves.
   */
  DATA_MODE: z.enum(['auto', 'cached_real', 'demo']).default('auto'),
  PRODUCT_MODE: z
    .enum([
      'auto',
      'HEAT_EXPOSURE_AND_ANOMALY',
      'EXPOSURE_ONLY',
      'ANOMALY_ONLY',
      'NO_GO_THERMAL_PRODUCT',
    ])
    .default('auto'),
})

export type ServerEnv = z.infer<typeof ServerEnvSchema> & {
  hasApiKey: boolean
  resultHostAllowlist: string[]
}

let cached: ServerEnv | null = null

export function serverEnv(): ServerEnv {
  if (cached) return cached

  const parsed = ServerEnvSchema.safeParse({
    FORTYGUARD_API_KEY: process.env.FORTYGUARD_API_KEY,
    FORTYGUARD_API_BASE_URL: process.env.FORTYGUARD_API_BASE_URL,
    FORTYGUARD_AUTH_HEADER: process.env.FORTYGUARD_AUTH_HEADER,
    FORTYGUARD_MAX_TILE_SQ_MI: process.env.FORTYGUARD_MAX_TILE_SQ_MI,
    FORTYGUARD_MAX_CONCURRENCY: process.env.FORTYGUARD_MAX_CONCURRENCY,
    FORTYGUARD_POLL_TIMEOUT_SECONDS: process.env.FORTYGUARD_POLL_TIMEOUT_SECONDS,
    FORTYGUARD_RESULT_HOST_ALLOWLIST: process.env.FORTYGUARD_RESULT_HOST_ALLOWLIST,
    RUN_LIVE_FORTYGUARD: process.env.RUN_LIVE_FORTYGUARD,
    DATA_MODE: process.env.DATA_MODE,
    PRODUCT_MODE: process.env.PRODUCT_MODE,
  })

  if (!parsed.success) {
    // The message lists field names only — never values, which could be the key.
    const fields = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')
    throw new Error(`Invalid server environment. Check these variables: ${fields}`)
  }

  cached = {
    ...parsed.data,
    hasApiKey: parsed.data.FORTYGUARD_API_KEY.length > 0,
    resultHostAllowlist: parsed.data.FORTYGUARD_RESULT_HOST_ALLOWLIST.split(',')
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  }
  return cached
}

/** Test seam: forget the memoised value after mutating `process.env`. */
export function resetServerEnvCache(): void {
  cached = null
}

/**
 * A live call is permitted only when both conditions hold. Without a key, no
 * request is ever constructed — not even one that would fail with 401.
 *
 * Consulted **only** by the local capture CLI. Nothing the application serves
 * reads it, because nothing the application serves can reach the API: there is
 * no capture route, and `executeRun` has no client seam. The operator token this
 * once guarded is gone with the endpoint — a secret protecting code that is not
 * deployed is a false reassurance.
 */
export function liveCallsPermitted(env: ServerEnv = serverEnv()): boolean {
  return env.RUN_LIVE_FORTYGUARD && env.hasApiKey
}

