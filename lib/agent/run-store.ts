import { createHash } from 'node:crypto'
import type { RunResult } from '@/lib/types'

/**
 * Completed runs, kept so an export can freeze one rather than re-derive it.
 *
 * ## Why this exists
 *
 * The export endpoint used to call `executeRun` again and compare the resulting
 * run id against the one the browser named. That caught a *changed* run, which
 * was the point, but it made the export a second execution of the engine — and a
 * second execution produces a second audit trail, with its own timestamps, for a
 * run that had already happened. An export is a frozen representation of a
 * completed run, so the run has to still exist to be frozen.
 *
 * `/api/plans` records every run it computes. `/api/plans/export` looks one up by
 * id, appends the attestation, and writes it out. No engine call, no snapshot
 * read, no recomputed timestamp.
 *
 * ## What a miss means
 *
 * A miss is reported as "this run is no longer available; re-run the analysis",
 * with a 409. That is the honest answer and the safe one: the alternative —
 * re-deriving on demand — is the behaviour this store replaces.
 *
 * The store is per-process and in memory. On a platform that may route two
 * requests to two instances, an export can therefore miss even seconds after the
 * run. That is a real limitation, it is documented in docs/architecture.md, and
 * it fails in the direction of refusing to export rather than of exporting
 * something regenerated. Making it durable needs shared storage, which is a
 * deployment decision rather than a code one.
 *
 * ## Bounded
 *
 * A fixed-size FIFO. Runs are large (a full scenario matrix and audit), and an
 * unbounded map behind a public endpoint is a memory-exhaustion primitive.
 */

/** Runs retained per process. Small: this backs an export click, not a cache. */
const MAX_RUNS = 32

export interface StoredRun {
  run: RunResult
  /** Digest of the request that produced it, for a defence-in-depth check. */
  requestSha256: string
  storedAtUtc: string
}

const runs = new Map<string, StoredRun>()

/**
 * `cacheKey -> runId`, so an identical request is answered without re-running.
 *
 * The engine is deterministic in the request, the stop dataset, the engine
 * version and the thermal source, so those four are the key. Nothing else can
 * change the answer — and if any of them does change, the key changes with it,
 * so a stale run cannot be served. This is why the key includes a stamp of the
 * snapshot store rather than only its contents at import time: committing a
 * capture must invalidate every cached run that predates it.
 */
const byCacheKey = new Map<string, string>()

export function cacheKeyFor(parts: {
  request: unknown
  datasetSha256: string
  engineVersion: string
  snapshotStoreStamp: string
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        request: canonicalJson(parts.request),
        dataset: parts.datasetSha256,
        engine: parts.engineVersion,
        store: parts.snapshotStoreStamp,
      }),
    )
    .digest('hex')
}

export function recallByCacheKey(cacheKey: string): StoredRun | null {
  const runId = byCacheKey.get(cacheKey)
  if (!runId) return null
  const stored = runs.get(runId)
  if (!stored) {
    byCacheKey.delete(cacheKey)
    return null
  }
  return stored
}

/** Canonical digest of a run request. Key order cannot change the answer. */
export function requestDigest(request: unknown): string {
  return createHash('sha256').update(canonicalJson(request)).digest('hex')
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`).join(',')}}`
}

export function rememberRun(
  run: RunResult,
  request: unknown,
  options: { cacheKey?: string; now?: () => Date } = {},
): void {
  const now = options.now ?? (() => new Date())

  /*
   * First write wins.
   *
   * The run id is deterministic over the request, the dataset, the engine
   * version and the thermal attestation, so two runs sharing an id were produced
   * from identical inputs by a deterministic engine — they are the same run. But
   * *replacing* the stored object under an id a browser is already holding is a
   * mutation of something an open screen believes it can export, and the cost of
   * being wrong about determinism is an export that describes a plan nobody saw.
   * Keeping the original removes the question.
   */
  const held = runs.get(run.runId)
  if (held) {
    if (options.cacheKey) byCacheKey.set(options.cacheKey, run.runId)
    // Refresh eviction position without replacing the object.
    runs.delete(run.runId)
    runs.set(run.runId, held)
    return
  }

  runs.set(run.runId, {
    run,
    requestSha256: requestDigest(request),
    storedAtUtc: now().toISOString(),
  })
  if (options.cacheKey) byCacheKey.set(options.cacheKey, run.runId)
  while (runs.size > MAX_RUNS) {
    const oldest = runs.keys().next().value
    if (oldest === undefined) break
    runs.delete(oldest)
    for (const [key, id] of byCacheKey) if (id === oldest) byCacheKey.delete(key)
  }
}

export function recallRun(runId: string): StoredRun | null {
  return runs.get(runId) ?? null
}

export function storedRunCount(): number {
  return runs.size
}

/** Test seam. */
export function clearRunStore(): void {
  runs.clear()
  byCacheKey.clear()
}
