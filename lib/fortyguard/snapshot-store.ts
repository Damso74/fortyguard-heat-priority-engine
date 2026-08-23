import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { capabilityFingerprint } from './capability'
import {
  realCaptureFailures,
  snapshotAnswersRequest,
  validateThermalSnapshot,
  type ThermalSnapshot,
  type ThermalSnapshotRequest,
  ThermalSnapshotError,
} from './snapshot'

/**
 * Where committed thermal snapshots live, and how they are read and written.
 *
 * The store is a **committed directory**, not a runtime cache. A public
 * deployment is read-only and its filesystem is ephemeral, so anything the demo
 * must serve reproducibly has to be in the repository, reviewed in a diff, and
 * hash-checked on load.
 *
 * ## The store holds real captures only
 *
 * Nothing synthetic belongs here. The synthetic layer is *generated* by
 * `demo-fixture.ts` on demand — deterministically, from code that says what it is
 * — so a synthetic file in this directory buys nothing and creates the exact
 * ambiguity this module exists to prevent. A committed
 * `LIVE_FORTYGUARD` / `REAL` file with zero cells and `act-1` for an activity id
 * is what prompted the rule; the check now runs in CI (`npm run check:snapshots`)
 * and on every load. Invalid examples worth keeping live under
 * `tests/fixtures/thermal-snapshots/`, which nothing at runtime reads.
 *
 * ## Lookup matches the whole request, and ambiguity fails closed
 *
 * The previous lookup listed candidates for an area and date, sorted the
 * filenames, and took the first one that parsed. Two things were wrong with that.
 * Filename order is not evidence about anything — renaming a file could change
 * which measurement the product served — and matching on area and date alone let
 * a 100 m capture answer a 60 m request. Lookup now compares every request
 * parameter, and if **more than one** file still matches it refuses to choose.
 * Picking arbitrarily between two candidate measurements is how a run ends up
 * reporting numbers nobody can trace.
 *
 * ## Content-addressed, atomic, non-overwriting
 *
 * A filename carries the attestation digest, so two captures of the same area and
 * date are two files rather than one silently replacing the other. Writing
 * identical content to an existing path is a no-op; writing *different* content
 * there is refused. Writes go to a temporary file in the same directory and are
 * renamed into place, so a crash mid-write leaves either the old file or the new
 * one, never a truncated file for the loader to reject.
 */

/**
 * Resolved per call rather than captured at import.
 *
 * A module-level constant freezes `process.cwd()` at first import, which is wrong
 * for anything that changes directory — including the tests, which each work in
 * their own temporary tree and would otherwise silently share the first one's
 * files.
 */
export function snapshotDir(): string {
  return join(process.cwd(), 'data', 'generated', 'thermal-snapshots')
}

const safe = (value: string) => value.replace(/[^a-zA-Z0-9-]/g, '-')

/** `<aoi>_<date>_<attestation prefix>.json` — readable and content-addressed. */
export function snapshotFileName(
  aoiId: string,
  analysisDate: string,
  attestationSha256: string,
): string {
  return `${safe(aoiId)}_${safe(analysisDate)}_${attestationSha256.slice(0, 16)}.json`
}

/** Every committed snapshot file, in directory order. Order is never load-bearing. */
export function snapshotFiles(): string[] {
  const directory = snapshotDir()
  if (!existsSync(directory)) return []
  return readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .map((name) => join(directory, name))
}

/**
 * A cheap fingerprint of the store's current contents.
 *
 * Used as part of the run cache key. Committing a capture, or removing one, must
 * invalidate every cached run that predates it — and reading the file listing is
 * a great deal cheaper than re-deriving a plan to find out nothing changed.
 */
export function snapshotStoreStamp(): string {
  return snapshotFiles()
    .map((path) => {
      try {
        const stats = statSync(path)
        return `${path}:${stats.size}:${stats.mtimeMs}`
      } catch {
        return `${path}:missing`
      }
    })
    .sort()
    .join('|')
}

export class AmbiguousSnapshotError extends Error {
  readonly paths: string[]
  constructor(message: string, paths: string[]) {
    super(message)
    this.name = 'AmbiguousSnapshotError'
    this.paths = paths
  }
}

export interface StoreEntry {
  path: string
  snapshot: ThermalSnapshot
}

/** Read and structurally validate every committed file. A bad file throws. */
export function readSnapshotStore(): StoreEntry[] {
  return snapshotFiles().map((path) => {
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(path, 'utf-8'))
    } catch (cause) {
      throw new ThermalSnapshotError(
        `Thermal snapshot at ${path} is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
      )
    }
    try {
      return { path, snapshot: validateThermalSnapshot(parsed) }
    } catch (cause) {
      throw new ThermalSnapshotError(
        `Thermal snapshot at ${path} failed validation: ${cause instanceof Error ? cause.message : String(cause)}`,
      )
    }
  })
}

export interface StoreProblem {
  path: string
  reasons: string[]
}

/**
 * Audit the whole production store.
 *
 * Used by `scripts/check-snapshot-store.mjs` in CI and by the run path before a
 * lookup, so an invalid file is a loud failure rather than a file that is simply
 * never chosen. Every file must parse, validate structurally, and satisfy every
 * real-capture rule against the **current** capability manifest.
 */
export function auditSnapshotStore(
  options: { capabilityFingerprint?: string } = {},
): StoreProblem[] {
  const fingerprint = options.capabilityFingerprint ?? capabilityFingerprint()
  const problems: StoreProblem[] = []
  const valid: StoreEntry[] = []

  for (const path of snapshotFiles()) {
    let entry: StoreEntry
    try {
      let parsed: unknown
      try {
        parsed = JSON.parse(readFileSync(path, 'utf-8'))
      } catch (cause) {
        problems.push({
          path,
          reasons: [`is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`],
        })
        continue
      }
      entry = { path, snapshot: validateThermalSnapshot(parsed) }
    } catch (cause) {
      problems.push({
        path,
        reasons: [cause instanceof Error ? cause.message : String(cause)],
      })
      continue
    }

    const reasons = realCaptureFailures(entry.snapshot, { capabilityFingerprint: fingerprint })
    if (reasons.length > 0) problems.push({ path, reasons })
    else valid.push(entry)
  }

  /* ---- ambiguity is a property of the store, not of any one file --------- */
  //
  // Each file here is individually fine; the store is not. A lookup would throw
  // rather than choose, so this must be caught in CI and not at request time.
  //
  // Grouping on the *whole* request, hours included, was too narrow: a lookup
  // matches a snapshot that covers a SUPERSET of the requested hours, so a file
  // for [11:00, 14:00, 17:00] and a file for [11:00, 14:00] are two different
  // requests by that grouping and both answer a request for [11:00, 14:00].
  // Overlap is what makes a lookup ambiguous, so overlap is what is checked.
  const byShape = new Map<string, StoreEntry[]>()
  for (const entry of valid) {
    const { snapshotTimes: _hours, ...shape } = entry.snapshot.request
    void _hours
    const key = JSON.stringify(shape)
    byShape.set(key, [...(byShape.get(key) ?? []), entry])
  }

  for (const group of byShape.values()) {
    if (group.length < 2) continue
    for (const entry of group) {
      const mine = new Set(entry.snapshot.request.snapshotTimes)
      const clashes = group.filter(
        (other) =>
          other.path !== entry.path &&
          other.snapshot.request.snapshotTimes.some((time) => mine.has(time)),
      )
      if (clashes.length === 0) continue
      problems.push({
        path: entry.path,
        reasons: [
          `covers hour(s) [${[...mine].sort().join(', ')}] for the same area, date, analytic ` +
            `type, granularity, filter type and timezone as ` +
            `${clashes.map((other) => other.path).sort().join(', ')}. A request for any shared ` +
            'hour would match more than one file, and a lookup refuses to choose between two ' +
            'measurements rather than picking by filename order.',
        ],
      })
    }
  }

  return problems
}

export interface SnapshotLookup {
  snapshot: ThermalSnapshot | null
  /** Why no snapshot was served. Null when one was. */
  reason: string | null
  path: string | null
  /** Every file rejected, and why. Reported so a failure is diagnosable. */
  rejected: StoreProblem[]
}

/**
 * Load the one committed snapshot that answers this request, if there is one.
 *
 * Returns a reason rather than throwing when nothing matches — not every
 * supported AOI/date/hour combination has a committed capture, so "no matching
 * snapshot exists" is an expected, reportable state. Two failures *do* throw:
 * a file that exists but does not
 * validate (corruption or tampering; falling back silently to the fixture would
 * replace real numbers with synthetic ones without saying so), and an ambiguous
 * match (two files answer the same request, and choosing between them arbitrarily
 * would make the served measurement a function of directory order).
 */
export function loadThermalSnapshot(
  request: ThermalSnapshotRequest,
  options: { capabilityFingerprint?: string } = {},
): SnapshotLookup {
  const fingerprint = options.capabilityFingerprint ?? capabilityFingerprint()
  const entries = readSnapshotStore()

  if (entries.length === 0) {
    return {
      snapshot: null,
      reason: `No committed thermal snapshot for ${request.aoiId} on ${request.analysisDate}.`,
      path: null,
      rejected: [],
    }
  }

  const rejected: StoreProblem[] = []
  const matches: StoreEntry[] = []

  for (const entry of entries) {
    const answers = snapshotAnswersRequest(entry.snapshot, request)
    if (!answers.matches) {
      rejected.push({ path: entry.path, reasons: [answers.reason ?? 'does not answer the request'] })
      continue
    }
    const failures = realCaptureFailures(entry.snapshot, { capabilityFingerprint: fingerprint })
    if (failures.length > 0) {
      rejected.push({ path: entry.path, reasons: failures })
      continue
    }
    matches.push(entry)
  }

  if (matches.length > 1) {
    const paths = matches.map((entry) => entry.path).sort()
    throw new AmbiguousSnapshotError(
      `${matches.length} committed snapshots answer the same request for ${request.aoiId} on ` +
        `${request.analysisDate}: ${paths.join(', ')}. Refusing to choose between two ` +
        'measurements. Remove the one that should not be served, deliberately and in a diff.',
      paths,
    )
  }

  const chosen = matches[0]
  if (!chosen) {
    return {
      snapshot: null,
      reason:
        rejected.length > 0
          ? `No committed snapshot can be served as real data for ${request.aoiId} on ` +
            `${request.analysisDate}. ${rejected.length} file(s) were rejected.`
          : `No committed thermal snapshot for ${request.aoiId} on ${request.analysisDate}.`,
      path: null,
      rejected,
    }
  }

  return { snapshot: chosen.snapshot, reason: null, path: chosen.path, rejected }
}

export interface WriteOutcome {
  path: string
  /** True when an identical file was already present and nothing was written. */
  alreadyPresent: boolean
}

/**
 * Write a captured snapshot atomically, refusing to overwrite a different one.
 *
 * Used by the local capture CLI only. Nothing served by the application writes
 * here, and nothing but a validated real capture may be written at all.
 */
export function writeThermalSnapshot(
  snapshot: ThermalSnapshot,
  options: { capabilityFingerprint?: string } = {},
): WriteOutcome {
  const fingerprint = options.capabilityFingerprint ?? capabilityFingerprint()
  const failures = realCaptureFailures(snapshot, { capabilityFingerprint: fingerprint })
  if (failures.length > 0) {
    throw new ThermalSnapshotError(
      'Refusing to write this snapshot into the production store, which holds real captures ' +
        `only. It ${failures.join(' It ')}`,
    )
  }

  const directory = snapshotDir()
  mkdirSync(directory, { recursive: true })
  const path = join(
    directory,
    snapshotFileName(
      snapshot.request.aoiId,
      snapshot.request.analysisDate,
      snapshot.attestationSha256,
    ),
  )
  const body = `${JSON.stringify(snapshot, null, 2)}\n`

  if (existsSync(path)) {
    const existing = readFileSync(path, 'utf-8')
    if (existing === body) return { path, alreadyPresent: true }
    // Same attestation digest, different bytes: either a hash collision or a
    // corrupted file. Neither is something to resolve by overwriting.
    throw new ThermalSnapshotError(
      `Refusing to overwrite ${path}: it exists with different content under the same ` +
        'attestation digest. Move or delete it deliberately if that is what you intend.',
    )
  }

  const temporary = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(temporary, body, 'utf-8')
    renameSync(temporary, path)
  } catch (cause) {
    try {
      if (existsSync(temporary)) unlinkSync(temporary)
    } catch {
      // The rename failed; a leftover temp file is not worth masking the cause.
    }
    throw cause
  }
  return { path, alreadyPresent: false }
}

/** True when exactly one servable real capture is committed for this request. */
export function hasRealSnapshot(request: ThermalSnapshotRequest): boolean {
  try {
    return loadThermalSnapshot(request).snapshot !== null
  } catch {
    return false
  }
}
