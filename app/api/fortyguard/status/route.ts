import { liveCallsPermitted, serverEnv } from '@/lib/config/server-env'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Reports whether the live path is available. Returns booleans and
 * configuration names only — never the key, never a prefix of it, never its
 * length.
 */
export async function GET(): Promise<Response> {
  const env = serverEnv()
  return Response.json(
    {
      configured: env.hasApiKey,
      liveEnabled: liveCallsPermitted(env),
      runLiveFlag: env.RUN_LIVE_FORTYGUARD,
      baseUrl: env.FORTYGUARD_API_BASE_URL,
      authHeaderName: env.FORTYGUARD_AUTH_HEADER,
      maxTileSqMi: env.FORTYGUARD_MAX_TILE_SQ_MI,
      maxConcurrency: env.FORTYGUARD_MAX_CONCURRENCY,
      pollTimeoutSeconds: env.FORTYGUARD_POLL_TIMEOUT_SECONDS,
      resultHostAllowlist: env.resultHostAllowlist,
      dataMode: env.DATA_MODE,
      productMode: env.PRODUCT_MODE,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
