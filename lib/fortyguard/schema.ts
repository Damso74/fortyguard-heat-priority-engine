import { z } from 'zod'

/**
 * Runtime contracts for the FortyGuard beta API.
 *
 * These schemas are deliberately *looser* than the published OpenAPI document.
 * The OpenAPI file declares the successful responses of every endpoint as an
 * empty schema (`{}`), and the documentation site shows response shapes only as
 * illustrative JSON. Nothing in either source is a guarantee, so the client
 * accepts several plausible envelopes, records which one it actually observed,
 * and never assumes the marketing description of a field.
 *
 * What is treated as documented fact (docs-api.fortyguard.com, read 2026-08-04):
 *  - auth is a single `api-key` request header;
 *  - submissions return an `activity_id`;
 *  - results are retrieved from `GET /v1/status/{activity_id}`;
 *  - heatmap results carry `map_data` (GeoJSON FeatureCollection) and
 *    `stats_data`;
 *  - `tcm` values are °C per tile.
 *
 * What is treated as unverified until the capability probe runs:
 *  - the property name carrying the temperature inside `map_data` features;
 *  - the timezone `start_time` is interpreted in;
 *  - whether `filter_type: 4` is accepted (the limitations page lists 1–3, the
 *    endpoint page and the OpenAPI schema list 1–4).
 */

/* -------------------------------------------------------------------------- */
/* Requests                                                                   */
/* -------------------------------------------------------------------------- */

export const PolygonAoiSchema = z.object({
  type: z.literal('FeatureCollection'),
  features: z
    .array(
      z.object({
        type: z.literal('Feature'),
        properties: z.record(z.string(), z.unknown()),
        geometry: z.object({
          type: z.literal('Polygon'),
          coordinates: z.array(z.array(z.tuple([z.number(), z.number()]))),
        }),
      }),
    )
    .min(1),
})

export const HeatmapRequestSchema = z.object({
  polygon_aoi: PolygonAoiSchema,
  date_time: z.object({
    start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'start_date must be YYYY-MM-DD'),
    end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    start_time: z.string().regex(/^\d{2}:\d{2}$/, 'start_time must be HH:MM').optional(),
    end_time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    // Only 1–3 are listed on every source. 4 appears on two of three, so it is
    // permitted here but flagged by the capability probe rather than assumed.
    filter_type: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  }),
  granularity: z.union([z.literal(60), z.literal(80), z.literal(100)]),
  analytic_type: z
    .enum(['tcm', 'time_of_measure', 'exceedance', 'persistence'])
    .optional(),
  threshold: z.number().optional(),
  direction: z.enum(['above', 'below']).optional(),
})

export type HeatmapRequest = z.infer<typeof HeatmapRequestSchema>

/* -------------------------------------------------------------------------- */
/* Responses                                                                  */
/* -------------------------------------------------------------------------- */

const ActivityIdSchema = z.string().trim().min(1).max(200)

/** Every envelope shape in which an `activity_id` has plausibly been seen. */
export const SubmitResponseSchema = z.union([
  z.object({ data: z.object({ activity_id: ActivityIdSchema }).loose() }).loose(),
  z.object({ activity_id: ActivityIdSchema }).loose(),
  z.object({ result: z.object({ activity_id: ActivityIdSchema }).loose() }).loose(),
  z.object({ data: z.object({ activityId: ActivityIdSchema }).loose() }).loose(),
  z.object({ activityId: ActivityIdSchema }).loose(),
])

export type SubmitEnvelope = 'data.activity_id' | 'activity_id' | 'result.activity_id' | 'data.activityId' | 'activityId'

export function extractActivityId(
  payload: unknown,
): { activityId: string; envelope: SubmitEnvelope } | null {
  if (!payload || typeof payload !== 'object') return null
  const root = payload as Record<string, unknown>
  const data = (root.data ?? null) as Record<string, unknown> | null
  const result = (root.result ?? null) as Record<string, unknown> | null

  const candidates: Array<[SubmitEnvelope, unknown]> = [
    ['data.activity_id', data && typeof data === 'object' ? data.activity_id : undefined],
    ['activity_id', root.activity_id],
    ['result.activity_id', result && typeof result === 'object' ? result.activity_id : undefined],
    ['data.activityId', data && typeof data === 'object' ? data.activityId : undefined],
    ['activityId', root.activityId],
  ]

  for (const [envelope, value] of candidates) {
    const parsed = ActivityIdSchema.safeParse(value)
    if (parsed.success) return { activityId: parsed.data, envelope }
  }
  return null
}

export const GeoJsonPolygonSchema = z.object({
  type: z.enum(['Polygon', 'MultiPolygon']),
  coordinates: z.unknown(),
})

export const FeatureCollectionSchema = z.object({
  type: z.literal('FeatureCollection'),
  features: z.array(
    z.object({
      type: z.literal('Feature').optional(),
      properties: z.record(z.string(), z.unknown()).nullable().optional(),
      geometry: GeoJsonPolygonSchema.nullable().optional(),
    }),
  ),
})

export type FortyGuardFeatureCollection = z.infer<typeof FeatureCollectionSchema>

/** Terminal and non-terminal status words, lower-cased before comparison. */
export const COMPLETED_STATUSES = new Set([
  'completed',
  'complete',
  'succeeded',
  'success',
  'done',
  'finished',
])

export const FAILED_STATUSES = new Set([
  'failed',
  'failure',
  'error',
  'errored',
  'cancelled',
  'canceled',
  'aborted',
  'rejected',
])

export const PENDING_STATUSES = new Set([
  'processing',
  'pending',
  'queued',
  'running',
  'in_progress',
  'in progress',
  'started',
  'submitted',
  'accepted',
])

export type ActivityPhase = 'completed' | 'failed' | 'pending' | 'unknown'

export function extractStatus(payload: unknown): { raw: string; phase: ActivityPhase } {
  const candidates: unknown[] = []
  if (payload && typeof payload === 'object') {
    const root = payload as Record<string, unknown>
    const data = root.data as Record<string, unknown> | undefined
    candidates.push(
      data && typeof data === 'object' ? data.status : undefined,
      root.status,
      root.state,
      data && typeof data === 'object' ? data.state : undefined,
      root.message,
    )
  }
  const raw = candidates.find((value) => typeof value === 'string' && value.trim().length > 0)
  const text = typeof raw === 'string' ? raw.trim() : ''
  const lowered = text.toLowerCase()
  if (COMPLETED_STATUSES.has(lowered)) return { raw: text, phase: 'completed' }
  if (FAILED_STATUSES.has(lowered)) return { raw: text, phase: 'failed' }
  if (PENDING_STATUSES.has(lowered)) return { raw: text, phase: 'pending' }
  return { raw: text, phase: 'unknown' }
}

/**
 * Depth-limited search for the heatmap FeatureCollection.
 *
 * `map_data` is checked first because it is the documented location; the
 * generic walk is a fallback for envelope drift, and the path that was actually
 * used is reported so the capability report can record the real contract.
 */
export function findFeatureCollection(
  payload: unknown,
  maxDepth = 8,
): { collection: FortyGuardFeatureCollection; path: string } | null {
  const documented = (payload as { data?: { result?: { map_data?: unknown } } })?.data?.result
    ?.map_data
  const direct = FeatureCollectionSchema.safeParse(documented)
  if (direct.success) return { collection: direct.data, path: 'data.result.map_data' }

  const queue: Array<{ node: unknown; path: string; depth: number }> = [
    { node: payload, path: '$', depth: 0 },
  ]
  while (queue.length) {
    const entry = queue.shift()
    if (!entry || entry.depth > maxDepth) continue
    const { node, path, depth } = entry
    const parsed = FeatureCollectionSchema.safeParse(node)
    if (parsed.success) return { collection: parsed.data, path }
    if (Array.isArray(node)) {
      node.forEach((child, index) =>
        queue.push({ node: child, path: `${path}[${index}]`, depth: depth + 1 }),
      )
    } else if (node && typeof node === 'object') {
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        queue.push({ node: child, path: `${path}.${key}`, depth: depth + 1 })
      }
    }
  }
  return null
}

/**
 * A completed activity may point at a result hosted elsewhere. The URL is
 * returned rather than fetched; the client decides using its host allowlist.
 */
export function findResultUrl(payload: unknown): string | null {
  const keys = ['download_link', 'result_url', 'resultUrl', 'url', 'href', 'location']
  const queue: unknown[] = [payload]
  let visited = 0
  while (queue.length && visited < 5000) {
    const node = queue.shift()
    visited += 1
    if (Array.isArray(node)) {
      queue.push(...node)
    } else if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (keys.includes(key) && typeof value === 'string' && /^https?:\/\//i.test(value)) {
          return value
        }
        queue.push(value)
      }
    }
  }
  return null
}
