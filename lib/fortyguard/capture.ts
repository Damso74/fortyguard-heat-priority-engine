import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { AreaOfInterest, ThermalCell } from '@/lib/types'
import { planTiles, tileToPolygonAoi } from '@/lib/geo/tiles'
import { FortyGuardClient } from './client'
import { FortyGuardError, requiresManualReconciliation } from './errors'
import { normalizeFeatureCollection } from './normalize'
import { documentedUnitFor, resolveValueField } from './value-field'
import { buildThermalSnapshot, type CaptureTimestamp, type ThermalSnapshot } from './snapshot'
import { writeThermalSnapshot, type WriteOutcome } from './snapshot-store'
import { capabilityFingerprint, loadCapability, LITERAL_CELSIUS } from './capability'
import { planTransmittedTimes } from './timezone'

/**
 * Capture orchestration: the only code in this project that can spend money.
 *
 * A full capture is `tiles × snapshots` billable submissions, each of which can
 * take minutes to poll. Everything below follows from that.
 *
 * ## The budget is the primary control
 *
 * The caller must pass a positive `maxNewSubmissions`. It defaults to nothing —
 * there is no "just run it" path — and it is enforced twice: once up front, by
 * refusing to start a plan that would exceed it, and once per unit, so a **resumed**
 * run cannot spend the budget again. A run that would submit 24 tiles under a
 * budget of 6 stops before the first POST rather than after the sixth.
 *
 * ## The journal is written before the socket opens
 *
 * The ordering is: record the intent → submit → record the id → poll. The
 * previous version recorded only the id, which left one window — crash after the
 * server accepted the request but before the id came back — in which credits were
 * spent and nothing on disk said so. The intent record closes it: a unit with an
 * intent and no id is a known unknown, and a resumed run refuses to continue past
 * one until a person has reconciled it.
 *
 * ## Ambiguity stops the run
 *
 * A timeout, a dropped connection or a 2xx with no activity id means work may be
 * running that we cannot name. There is no safe automatic response, so there is
 * no automatic response: the unit is marked unresolved, the checkpoint is
 * flushed, and the run raises `CaptureReconciliationError`. It never resubmits.
 *
 * ## The lock is taken here, not by the caller
 *
 * `runCapture` acquires the exclusive lock itself, before the first network call,
 * so no caller can reach the API without one. A held lock always fails closed:
 * an automatic staleness breaker would defeat the purpose the first time a
 * capture ran longer than expected.
 */

export const CAPTURE_TOOL_VERSION = 'lib/fortyguard/capture.ts@3.0.0'

/** Resolved per call, for the same reason the snapshot directory is. */
export function checkpointDir(): string {
  return join(process.cwd(), 'data', 'generated', 'capture-checkpoints')
}

export interface CaptureSpec {
  aoiId: string
  analysisDate: string
  snapshotTimes: string[]
  /** Narrowed to what the request schema accepts, so a typo cannot reach the API. */
  analyticType: 'tcm' | 'time_of_measure' | 'exceedance' | 'persistence'
  granularityMeters: 60 | 80 | 100
  filterType: 1 | 2 | 3 | 4
  timezone: string
  maxTileSqMi: number
}

/** One tile × snapshot: the unit of billing, and therefore of resume. */
export interface CaptureUnit {
  key: string
  tileId: string
  snapshotTime: string
  /** What the timezone strategy says to transmit for this hour. */
  transmittedDate: string
  transmittedTime: string
  /**
   * When this process decided to submit. Written **before** the request leaves.
   * An intent with no `activityId` is money that may have been spent untracked.
   */
  intentRecordedAtUtc: string | null
  activityId: string | null
  submittedAtUtc: string | null
  completedAtUtc: string | null
  cells: number | null
  /** Set when a POST outcome could not be resolved. Blocks the whole request. */
  unresolved: { atUtc: string; kind: string; message: string } | null
}

export interface CaptureCheckpoint {
  kind: 'heat-priority-engine/capture-checkpoint'
  version: 2
  requestKey: string
  spec: CaptureSpec
  startedAtUtc: string
  /** Submissions this checkpoint has ever *intended*, across every resume. */
  submissionsIntended: number
  units: CaptureUnit[]
  valueField: string | null
  capabilityFingerprint: string
  notes: string[]
}

/** Deterministic across processes: the same request always resumes the same file. */
/**
 * Shortest string this project will accept as a FortyGuard activity id.
 *
 * Mirrors `MIN_ACTIVITY_ID_LENGTH` in `snapshot.ts`. Anything shorter is a
 * placeholder or a blank, and a blank is actively dangerous — see the check in
 * `readCheckpoint`.
 */
const MIN_ACTIVITY_ID_CHARS = 8

export function requestKey(spec: CaptureSpec): string {
  const canonical = {
    aoiId: spec.aoiId,
    analysisDate: spec.analysisDate,
    snapshotTimes: [...spec.snapshotTimes].sort(),
    analyticType: spec.analyticType,
    granularityMeters: spec.granularityMeters,
    filterType: spec.filterType,
    timezone: spec.timezone,
    maxTileSqMi: spec.maxTileSqMi,
  }
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 24)
}

export function checkpointPath(spec: CaptureSpec): string {
  return join(checkpointDir(), `${spec.aoiId}_${spec.analysisDate}_${requestKey(spec)}.json`)
}

function lockPath(spec: CaptureSpec): string {
  return `${checkpointPath(spec)}.lock`
}

/**
 * Read a checkpoint, and prove it describes this request before trusting it.
 *
 * This used to be `JSON.parse(...) as CaptureCheckpoint` with a single check on
 * the request key — a cast, not a validation. Everything downstream then treated
 * the unit list as authoritative: which tiles to buy, which activity ids are
 * already paid for, how much budget remains. A truncated, duplicated or
 * hand-edited file could therefore buy the wrong units, or skip units it claimed
 * were paid for, and the resulting snapshot would attest to a plan that had never
 * been submitted.
 *
 * The unit set must be **exactly** `tiles × hours`, once each. Anything else is a
 * file this process did not write.
 */
export function readCheckpoint(spec: CaptureSpec, expectedKeys?: readonly string[]): CaptureCheckpoint | null {
  const path = checkpointPath(spec)
  if (!existsSync(path)) return null

  let parsed: CaptureCheckpoint
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8')) as CaptureCheckpoint
  } catch (cause) {
    throw new FortyGuardError(
      'BAD_REQUEST',
      `Checkpoint at ${path} is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
  }

  const reject = (why: string): never => {
    throw new FortyGuardError('BAD_REQUEST', `Checkpoint at ${path} ${why} Refusing to resume it.`)
  }

  if (parsed.kind !== 'heat-priority-engine/capture-checkpoint' || parsed.version !== 2) {
    reject(`has kind "${String(parsed.kind)}" version ${String(parsed.version)}, which this tool does not write.`)
  }
  if (parsed.requestKey !== requestKey(spec)) {
    reject('belongs to a different request.')
  }
  /*
   * The embedded spec has to MATCH, not merely hash to the same key.
   *
   * `requestKey` covers the fields that define the request, but `parsed.spec` was
   * then used verbatim — including by `writeCheckpoint`, which derived its output
   * path from it. So an edited spec could send this run's pre-POST intent journal
   * into a different file, leaving the original checkpoint untouched and still
   * resumable: the intent record, whose entire job is to make a spent credit
   * visible, would have been written where nobody looks.
   *
   * Compared field by field against the spec the caller passed, which is the one
   * the plan and the budget were computed from.
   */
  const mismatched = (
    ['aoiId', 'analysisDate', 'analyticType', 'granularityMeters', 'filterType', 'timezone', 'maxTileSqMi'] as const
  ).filter((field) => parsed.spec?.[field] !== spec[field])
  const hoursDiffer =
    !Array.isArray(parsed.spec?.snapshotTimes) ||
    [...parsed.spec.snapshotTimes].sort().join(',') !== [...spec.snapshotTimes].sort().join(',')
  if (mismatched.length > 0 || hoursDiffer) {
    reject(
      `embeds a spec that differs from this request (${[...mismatched, ...(hoursDiffer ? ['snapshotTimes'] : [])].join(', ')}). ` +
        'That spec is used to locate the file this run journals its intent into, so a mismatch ' +
        'could hide a spent credit in another file.',
    )
  }
  if (!Array.isArray(parsed.units)) {
    reject('has no unit list.')
  }
  for (const unit of parsed.units) {
    if (
      !unit ||
      typeof unit.key !== 'string' ||
      typeof unit.tileId !== 'string' ||
      typeof unit.snapshotTime !== 'string' ||
      typeof unit.transmittedDate !== 'string' ||
      typeof unit.transmittedTime !== 'string' ||
      (unit.activityId !== null && typeof unit.activityId !== 'string') ||
      (unit.intentRecordedAtUtc !== null && typeof unit.intentRecordedAtUtc !== 'string')
    ) {
      reject(`contains a malformed unit (${JSON.stringify(unit)?.slice(0, 120)}).`)
    }
    /*
     * An activity id is a real id or it is `null`. Never `""`.
     *
     * A blank string is the worst possible value here, because the two sides of
     * this system disagree about it: `unit.activityId !== null` reads it as
     * "already paid for", so the unit is excluded from the budget — while the
     * client's `if (activityId)` reads it as falsy and submits. Fifty blanked
     * units therefore bought fifty submissions under a budget of one. The unit
     * key is checked here too, before anything is submitted, so a hand-edited
     * file cannot point a paid unit at a different tile or hour.
     */
    if (typeof unit.activityId === 'string' && unit.activityId.trim().length < MIN_ACTIVITY_ID_CHARS) {
      reject(
        `records activityId ${JSON.stringify(unit.activityId)} for unit ${unit.key}, which is ` +
          'neither null nor a plausible id. A blank id reads as "already paid for" to the budget ' +
          'and as "not submitted" to the client, which is how one budget buys many submissions.',
      )
    }
    if (unit.key !== `${unit.tileId}@${unit.snapshotTime}`) {
      reject(
        `has unit key ${JSON.stringify(unit.key)} for tile ${unit.tileId} at ${unit.snapshotTime}. ` +
          'The key must name the tile and hour it bought.',
      )
    }
  }

  if (expectedKeys) {
    const seen = parsed.units.map((unit) => unit.key)
    const duplicates = seen.filter((key, index) => seen.indexOf(key) !== index)
    if (duplicates.length > 0) {
      reject(`lists unit(s) ${[...new Set(duplicates)].join(', ')} more than once.`)
    }
    const expected = [...expectedKeys].sort().join('|')
    if ([...seen].sort().join('|') !== expected) {
      reject(
        `describes ${seen.length} unit(s) where this request has ${expectedKeys.length} ` +
          '(tiles × hours). It was not written for this plan.',
      )
    }
  }

  return parsed
}

/** Atomic: a crash mid-write must not destroy the record of spent credits. */
export function writeCheckpoint(checkpoint: CaptureCheckpoint, spec?: CaptureSpec): void {
  mkdirSync(checkpointDir(), { recursive: true })
  // The caller's spec when there is one, never the file's own. `checkpoint.spec`
  // arrives from disk, and a path derived from untrusted data is a path an
  // attacker chooses.
  const path = checkpointPath(spec ?? checkpoint.spec)
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(checkpoint, null, 2)}\n`, 'utf-8')
  renameSync(temporary, path)
}

export class CaptureLockedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CaptureLockedError'
  }
}

export class CaptureBudgetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CaptureBudgetError'
  }
}

/**
 * A POST whose outcome is unknown. The run stops; a person reconciles.
 *
 * Deliberately a distinct type from every other capture failure, because the
 * correct response is different: not "try again", but "look at the account".
 */
export class CaptureReconciliationError extends Error {
  readonly unitKey: string
  readonly checkpoint: string
  constructor(message: string, unitKey: string, checkpoint: string) {
    super(message)
    this.name = 'CaptureReconciliationError'
    this.unitKey = unitKey
    this.checkpoint = checkpoint
  }
}

/**
 * Exclusive lock for one request.
 *
 * `wx` is `O_CREAT | O_EXCL`: the existence test and the creation are one atomic
 * syscall, so two processes racing cannot both believe they hold it. A separate
 * `existsSync` followed by a write would be exactly the race this prevents.
 *
 * A held lock **always** fails closed, however old it looks. Automatic staleness
 * breaking is the failure mode: the first capture that legitimately runs longer
 * than the threshold gets its tiles bought a second time by the process that
 * "helpfully" cleared the lock.
 */
export function acquireCaptureLock(spec: CaptureSpec, now: () => Date = () => new Date()): () => void {
  mkdirSync(checkpointDir(), { recursive: true })
  const path = lockPath(spec)
  try {
    writeFileSync(path, JSON.stringify({ pid: process.pid, at: now().toISOString() }), {
      encoding: 'utf-8',
      flag: 'wx',
    })
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'EEXIST') {
      let holder = '(unreadable)'
      try {
        holder = readFileSync(path, 'utf-8')
      } catch {
        // The holder record is advisory; its absence does not release the lock.
        // An unreadable lock is *more* reason to stop, not less.
      }
      throw new CaptureLockedError(
        `A capture for this request is already running, or ended without releasing: ${holder}. ` +
          'Refusing to submit the same tiles twice. This lock is never broken automatically — ' +
          'confirm the other process is dead, reconcile the checkpoint against the FortyGuard ' +
          `account, then delete ${path} deliberately.`,
      )
    }
    throw cause
  }
  return () => {
    try {
      if (existsSync(path)) unlinkSync(path)
    } catch {
      // A leftover lock is safer than a crash while releasing one.
    }
  }
}

export interface CapturePlan {
  tileCount: number
  snapshotCount: number
  totalUnits: number
  alreadyPaidFor: number
  newSubmissions: number
  unresolvedUnits: CaptureUnit[]
  timestamps: CaptureTimestamp[]
  coversAoi: boolean
  checkpointPath: string
  capabilityFingerprint: string
}

/**
 * Everything a run would do, computed without touching the network.
 *
 * This is what `--dry-run` prints and what the budget is checked against, so the
 * number an operator approves is the number the run can spend.
 */
export function planCapture(aoi: AreaOfInterest, spec: CaptureSpec): CapturePlan {
  const capability = loadCapability()
  const tilePlan = planTiles(aoi, spec.maxTileSqMi)
  const existing = readCheckpoint(spec)
  const transmitted = planTransmittedTimes({
    strategy: capability.timezone.strategy,
    timezone: spec.timezone,
    analysisDate: spec.analysisDate,
    localTimes: spec.snapshotTimes,
  })

  const totalUnits = tilePlan.tiles.length * spec.snapshotTimes.length
  const alreadyPaidFor = existing?.units.filter((unit) => unit.activityId !== null).length ?? 0
  const unresolvedUnits =
    existing?.units.filter(
      (unit) => unit.unresolved !== null || (unit.intentRecordedAtUtc !== null && !unit.activityId),
    ) ?? []

  return {
    tileCount: tilePlan.tiles.length,
    snapshotCount: spec.snapshotTimes.length,
    totalUnits,
    alreadyPaidFor,
    newSubmissions: totalUnits - alreadyPaidFor,
    unresolvedUnits,
    timestamps: transmitted.map((entry) => ({
      requestedLocalDate: entry.requestedLocalDate,
      requestedLocalTime: entry.requestedLocalTime,
      requestedLocalIso: entry.requestedLocalIso,
      transmittedDate: entry.transmittedDate,
      transmittedTime: entry.transmittedTime,
      transmittedIsoUtc: entry.transmittedIsoUtc,
    })),
    coversAoi: tilePlan.coversAoi,
    checkpointPath: checkpointPath(spec),
    capabilityFingerprint: capabilityFingerprint(capability),
  }
}

export interface CaptureOptions {
  aoi: AreaOfInterest
  spec: CaptureSpec
  client: FortyGuardClient
  /**
   * Hard ceiling on submissions this invocation may pay for. Must be positive.
   *
   * There is no default. A capture that runs without an explicit number is a
   * capture nobody sized.
   */
  maxNewSubmissions: number
  now?: () => Date
  log?: (message: string) => void
}

export interface CaptureResult {
  write: WriteOutcome
  snapshot: ThermalSnapshot
  surfaceSha256: string
  attestationSha256: string
  cells: number
  activityIds: string[]
  resumedUnits: number
  submittedUnits: number
}

/**
 * Run a capture to completion, resuming anything already paid for.
 *
 * Never called by the application. The only caller is the local CLI, and the only
 * thing that can reach the API at all is this function.
 */
export async function runCapture(options: CaptureOptions): Promise<CaptureResult> {
  const { aoi, spec, client, maxNewSubmissions } = options
  const now = options.now ?? (() => new Date())
  const log = options.log ?? (() => {})

  if (!Number.isInteger(maxNewSubmissions) || maxNewSubmissions <= 0) {
    throw new CaptureBudgetError(
      `maxNewSubmissions must be a positive integer; got ${String(maxNewSubmissions)}. A capture ` +
        'with no explicit budget is a capture nobody sized.',
    )
  }

  const capability = loadCapability()
  const fingerprint = capabilityFingerprint(capability)
  const tilePlan = planTiles(aoi, spec.maxTileSqMi)
  if (!tilePlan.coversAoi) {
    throw new FortyGuardError('BAD_REQUEST', 'Tile plan does not cover the area of interest.')
  }

  const transmitted = new Map(
    planTransmittedTimes({
      strategy: capability.timezone.strategy,
      timezone: spec.timezone,
      analysisDate: spec.analysisDate,
      localTimes: spec.snapshotTimes,
    }).map((entry) => [entry.requestedLocalTime, entry]),
  )

  const expectedKeys = spec.snapshotTimes.flatMap((snapshotTime) =>
    tilePlan.tiles.map((tile) => `${tile.id}@${snapshotTime}`),
  )
  const existing = readCheckpoint(spec, expectedKeys)
  if (existing && existing.capabilityFingerprint !== fingerprint) {
    throw new FortyGuardError(
      'SCHEMA_MISMATCH',
      `The checkpoint at ${checkpointPath(spec)} was started under capability fingerprint ` +
        `${existing.capabilityFingerprint.slice(0, 12)}… and the manifest now reads ` +
        `${fingerprint.slice(0, 12)}…. Resuming would mix tiles read under two different sets of ` +
        'answers into one snapshot. Start a new capture.',
    )
  }

  const units: CaptureUnit[] =
    existing?.units ??
    spec.snapshotTimes.flatMap((snapshotTime) => {
      const plan = transmitted.get(snapshotTime)
      if (!plan) {
        throw new FortyGuardError(
          'BAD_REQUEST',
          `No transmitted timestamp was planned for ${snapshotTime}.`,
        )
      }
      return tilePlan.tiles.map((tile) => ({
        key: `${tile.id}@${snapshotTime}`,
        tileId: tile.id,
        snapshotTime,
        transmittedDate: plan.transmittedDate,
        transmittedTime: plan.transmittedTime,
        intentRecordedAtUtc: null,
        activityId: null,
        submittedAtUtc: null,
        completedAtUtc: null,
        cells: null,
        unresolved: null,
      }))
    })

  const checkpoint: CaptureCheckpoint = existing ?? {
    kind: 'heat-priority-engine/capture-checkpoint',
    version: 2,
    requestKey: requestKey(spec),
    spec,
    startedAtUtc: now().toISOString(),
    submissionsIntended: 0,
    units,
    valueField: null,
    capabilityFingerprint: fingerprint,
    notes: [],
  }
  checkpoint.units = units

  /* ---- refuse to move past an unresolved submission ----------------------- */
  const stranded = checkpoint.units.find(
    (unit) => unit.unresolved !== null || (unit.intentRecordedAtUtc !== null && !unit.activityId),
  )
  if (stranded) {
    throw new CaptureReconciliationError(
      `Unit ${stranded.key} has a recorded submission intent but no activity id` +
        (stranded.unresolved ? ` (${stranded.unresolved.kind}: ${stranded.unresolved.message})` : '') +
        '. FortyGuard may be running work this checkpoint cannot name. Reconcile against the ' +
        'account, then either record the activity id in the checkpoint or clear the intent — ' +
        'deliberately. Nothing is resubmitted automatically.',
      stranded.key,
      checkpointPath(spec),
    )
  }

  /* ---- budget, computed and enforced before the first socket -------------- */
  const pending = checkpoint.units.filter((unit) => unit.activityId === null)
  if (pending.length > maxNewSubmissions) {
    throw new CaptureBudgetError(
      `This run needs ${pending.length} new submission(s) and the budget is ${maxNewSubmissions}. ` +
        'Nothing was submitted. Raise --max-new-submissions deliberately, or narrow the request.',
    )
  }

  /* ---- the lock, before any network call --------------------------------- */
  const releaseLock = acquireCaptureLock(spec, now)

  const tileById = new Map(tilePlan.tiles.map((tile) => [tile.id, tile]))
  const cells: ThermalCell[] = []
  const seen = new Set<string>()
  let resumedUnits = 0
  let submittedUnits = 0
  let unitConfirmed = false

  try {
    for (const unit of checkpoint.units) {
      const tile = tileById.get(unit.tileId)
      if (!tile) {
        throw new FortyGuardError(
          'BAD_REQUEST',
          `Checkpoint references tile ${unit.tileId}, which this tile plan does not contain.`,
        )
      }
      const snapshot = `${spec.analysisDate}T${unit.snapshotTime}`
      // Having an id, not merely a non-null field. `''` is neither.
      const resuming = typeof unit.activityId === 'string' && unit.activityId.length > 0

      if (resuming) {
        resumedUnits += 1
      } else {
        // Enforced per unit as well as up front, so a resumed run cannot spend
        // the same budget a second time.
        if (submittedUnits >= maxNewSubmissions) {
          throw new CaptureBudgetError(
            `Budget of ${maxNewSubmissions} new submission(s) is exhausted at unit ${unit.key}. ` +
              `${submittedUnits} were submitted this run. Re-run with --resume and a new budget ` +
              'to continue; nothing already paid for will be bought again.',
          )
        }
        submittedUnits += 1
      }

      log(
        `${resuming ? 'resume' : 'submit'} ${unit.key}` +
          (resuming
            ? ` (activity ${unit.activityId})`
            : ` [${submittedUnits}/${maxNewSubmissions} of budget]`),
      )

      let result
      try {
        result = await client.runHeatmap(
          {
            polygon_aoi: tileToPolygonAoi(tile),
            date_time: {
              start_date: unit.transmittedDate,
              start_time: unit.transmittedTime,
              filter_type: spec.filterType,
            },
            granularity: spec.granularityMeters,
            analytic_type: spec.analyticType,
          },
          {
            resumeActivityId: unit.activityId ?? undefined,
            // Durable BEFORE the socket opens.
            onSubmitIntent: () => {
              unit.intentRecordedAtUtc = now().toISOString()
              checkpoint.submissionsIntended += 1
              writeCheckpoint(checkpoint, spec)
            },
            // The id is recorded the instant it exists, before anything is polled.
            onActivityId: (activityId) => {
              unit.activityId = activityId
              unit.submittedAtUtc = now().toISOString()
              writeCheckpoint(checkpoint, spec)
            },
          },
        )
      } catch (cause) {
        if (cause instanceof FortyGuardError && requiresManualReconciliation(cause.kind)) {
          unit.unresolved = {
            atUtc: now().toISOString(),
            kind: cause.kind,
            message: cause.message,
          }
          writeCheckpoint(checkpoint, spec)
          throw new CaptureReconciliationError(
            `Unit ${unit.key} returned an ambiguous submission outcome (${cause.kind}): ` +
              `${cause.message} The request may have been accepted and may be billing. It was ` +
              'NOT retried and the run has stopped. Reconcile against the FortyGuard account ' +
              `before running anything else; the checkpoint is at ${checkpointPath(spec)}.`,
            unit.key,
            checkpointPath(spec),
          )
        }
        writeCheckpoint(checkpoint, spec)
        throw cause
      }

      if (!unit.activityId) {
        unit.activityId = result.activityId
        unit.submittedAtUtc = now().toISOString()
      }

      const resolution = resolveValueField(result.collection, {
        analyticType: spec.analyticType,
        override: capability.valueField.confirmed
          ? (capability.valueField.name ?? undefined)
          : undefined,
      })
      if (checkpoint.valueField && checkpoint.valueField !== resolution.field) {
        throw new FortyGuardError(
          'SCHEMA_MISMATCH',
          `Value field changed between tiles: "${checkpoint.valueField}" then "${resolution.field}".`,
        )
      }
      checkpoint.valueField = resolution.field
      // A unit is documented only when the probe confirmed the field, that the
      // field holds a temperature, AND that the temperature is literally Celsius.
      // Selecting a property with --temperature-field confirms none of those.
      if (
        resolution.resolvedBy === 'override' &&
        capability.semantics.confirmed &&
        capability.unit.confirmed &&
        capability.unit.unit === LITERAL_CELSIUS
      ) {
        unitConfirmed = true
      }

      const normalized = normalizeFeatureCollection(result.collection, {
        valueField: resolution.field,
        snapshot,
        seen,
      })
      cells.push(...normalized.cells)
      checkpoint.notes.push(...result.contract.notes)
      unit.completedAtUtc = now().toISOString()
      unit.cells = normalized.cells.length
      writeCheckpoint(checkpoint, spec)
    }
  } finally {
    releaseLock()
  }

  const activityIds = checkpoint.units
    .map((unit) => unit.activityId)
    .filter((id): id is string => id !== null)

  /*
   * The attested timestamps are read off the units that were actually sent, not
   * recomputed from the plan.
   *
   * Recomputing produces what the strategy *would* have transmitted, which is the
   * same thing only when nothing intervened — and a resumed run carries units
   * written by an earlier process, possibly under an earlier plan. An attestation
   * that describes the intended traffic rather than the real traffic is the
   * failure this whole record exists to prevent, so the units are the source and
   * a disagreement with the plan is a hard error rather than a silent overwrite.
   */
  const timestamps: CaptureTimestamp[] = spec.snapshotTimes.map((time) => {
    const plan = transmitted.get(time)
    if (!plan) {
      throw new FortyGuardError('BAD_REQUEST', `No transmitted timestamp recorded for ${time}.`)
    }
    const sent = checkpoint.units.filter((unit) => unit.snapshotTime === time)
    if (sent.length === 0) {
      throw new FortyGuardError('BAD_REQUEST', `No unit was submitted for ${time}.`)
    }
    const dates = new Set(sent.map((unit) => unit.transmittedDate))
    const times = new Set(sent.map((unit) => unit.transmittedTime))
    if (dates.size !== 1 || times.size !== 1) {
      throw new FortyGuardError(
        'SCHEMA_MISMATCH',
        `Units for ${time} were transmitted under more than one timestamp ` +
          `(${[...dates].join(', ')} / ${[...times].join(', ')}). Refusing to attest to one of them.`,
      )
    }
    const transmittedDate = sent[0]!.transmittedDate
    const transmittedTime = sent[0]!.transmittedTime
    if (transmittedDate !== plan.transmittedDate || transmittedTime !== plan.transmittedTime) {
      throw new FortyGuardError(
        'SCHEMA_MISMATCH',
        `Units for ${time} were transmitted as ${transmittedDate} ${transmittedTime}, but the ` +
          `current ${capability.timezone.strategy} strategy produces ${plan.transmittedDate} ` +
          `${plan.transmittedTime}. The checkpoint predates a strategy change; start a new capture.`,
      )
    }
    return {
      requestedLocalDate: plan.requestedLocalDate,
      requestedLocalTime: plan.requestedLocalTime,
      requestedLocalIso: plan.requestedLocalIso,
      transmittedDate,
      transmittedTime,
      transmittedIsoUtc: plan.transmittedIsoUtc,
    }
  })

  const snapshot = buildThermalSnapshot({
    request: {
      aoiId: spec.aoiId,
      analysisDate: spec.analysisDate,
      snapshotTimes: [...spec.snapshotTimes],
      analyticType: spec.analyticType,
      granularityMeters: spec.granularityMeters,
      filterType: spec.filterType,
      timezone: spec.timezone,
    },
    source: {
      dataMode: 'LIVE_FORTYGUARD',
      provenance: 'REAL',
      activityIds,
      valueField: checkpoint.valueField,
      unit: unitConfirmed ? documentedUnitFor(spec.analyticType) : null,
      unitConfirmed,
      semanticsConfirmed: capability.semantics.confirmed,
      timezoneStrategy: capability.timezone.strategy,
      // Recorded as applied because this run executed it, via planTransmittedTimes,
      // and the transmitted values above are the evidence.
      timezoneStrategyApplied: true,
      capabilityProbeRunId: capability.probeRunId,
      capabilityFingerprint: fingerprint,
      capture: {
        capturedAtUtc: now().toISOString(),
        captureToolVersion: CAPTURE_TOOL_VERSION,
        tileCount: tilePlan.tiles.length,
        submissionCount: checkpoint.units.filter((unit) => unit.activityId !== null).length,
        timestamps,
      },
      notes: [...new Set(checkpoint.notes)],
    },
    cells,
  })

  return {
    write: writeThermalSnapshot(snapshot, { capabilityFingerprint: fingerprint }),
    snapshot,
    surfaceSha256: snapshot.surfaceSha256,
    attestationSha256: snapshot.attestationSha256,
    cells: snapshot.cells.length,
    activityIds,
    resumedUnits,
    submittedUnits,
  }
}
