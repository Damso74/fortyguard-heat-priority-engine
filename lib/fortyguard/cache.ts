import { createHash } from 'node:crypto'

/**
 * Result cache keyed by a canonical hash of the request payload.
 *
 * Canonical means: object keys sorted recursively and numbers serialised with
 * `JSON.stringify` defaults, so two structurally identical payloads built in a
 * different key order produce the same key. Coordinates are rounded to 1e-7
 * degrees (~1 cm) before hashing so floating-point noise from tile arithmetic
 * cannot fragment the cache.
 */

export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Number(value.toFixed(7)) : null
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    const output: Record<string, unknown> = {}
    for (const [key, child] of entries) output[key] = canonicalize(child)
    return output
  }
  return value
}

export function payloadHash(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(payload))).digest('hex')
}

export interface CacheEntry<T> {
  value: T
  storedAt: number
  activityId: string | null
}

export interface ResultCache<T = unknown> {
  get(key: string): CacheEntry<T> | undefined
  set(key: string, entry: CacheEntry<T>): void
  has(key: string): boolean
  size(): number
  clear(): void
}

/**
 * Process-local cache. Bounded so a long-running server cannot grow without
 * limit; eviction is least-recently-inserted, which is adequate because entries
 * are immutable results of identical requests.
 */
export class MemoryResultCache<T = unknown> implements ResultCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>()

  constructor(private readonly maxEntries = 64) {}

  get(key: string): CacheEntry<T> | undefined {
    return this.entries.get(key)
  }

  set(key: string, entry: CacheEntry<T>): void {
    if (this.entries.has(key)) this.entries.delete(key)
    this.entries.set(key, entry)
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next()
      if (oldest.done) break
      this.entries.delete(oldest.value)
    }
  }

  has(key: string): boolean {
    return this.entries.has(key)
  }

  size(): number {
    return this.entries.size
  }

  clear(): void {
    this.entries.clear()
  }
}
