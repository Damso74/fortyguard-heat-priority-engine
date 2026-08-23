import { createHash } from 'node:crypto'
import type { DataMode, Provenance, ThermalCell } from '@/lib/types'
import {
  LITERAL_CELSIUS,
  capabilityFingerprint,
  loadCapability,
  type CapabilityConfirmation,
} from './capability'
import { TIMEZONE_STRATEGIES, type TimezoneStrategy } from './timezone'

/**
 * Immutable thermal snapshots, with two independent digests.
 *
 * ## Why two
 *
 * A single hash was doing two incompatible jobs.
 *
 * - **The surface hash** answers "are these the same numbers?". It must cover the
 *   values and where they are, and nothing else, so that two captures of the same
 *   surface agree.
 * - **The attestation hash** answers "is this the same *claim*?". A file whose
 *   values are untouched but whose `dataMode` has been flipped from
 *   `DEMO_SYNTHETIC` to `LIVE_FORTYGUARD`, or whose unit has been relabelled `°C`,
 *   or whose activity ids have been invented, is a different assertion about the
 *   world while being byte-identical on the surface.
 *
 * The attestation therefore covers the surface digest **plus** mode, provenance,
 * activity ids, value field, confirmed unit, timezone strategy and whether it was
 * applied, the requested local and transmitted timestamps, the AOI, the analysis
 * date, the requested hours, the resolution and the cell rings, the capture
 * metadata, the capability fingerprint and the schema version. Both digests are
 * recomputed on load and both must match.
 *
 * **The run id is bound to the attestation**, not to the surface. Two files whose
 * numbers agree but whose claims differ are two different runs, and an export
 * naming one of them must not verify against the other.
 *
 * ## Content-addressed, atomic, non-overwriting
 *
 * The filename carries the attestation digest, so a capture cannot silently
 * replace a different capture of the same area and date. See `snapshot-store.ts`.
 *
 * ## Provenance cannot be laundered
 *
 * `dataModeForSnapshot` is the only place a snapshot becomes `CACHED_REAL_DATA`,
 * and it requires the recorded capture mode to be `LIVE_FORTYGUARD`. Writing
 * fixture numbers to a file does not make them a measurement — and
 * `realCaptureFailures` refuses a file that says `REAL` while carrying no cells,
 * no activity ids, placeholder ids, or a capability fingerprint that no longer
 * matches the manifest.
 */

export const SNAPSHOT_KIND = 'heat-priority-engine/thermal-snapshot'
export const SNAPSHOT_VERSION = 3

/**
 * Cells a real capture must carry before it is served.
 *
 * Eight is the same floor the thermal gate needs before it will say anything
 * about discrimination (`MIN_CELLS` in `lib/gates/thermal-gate.ts`). A file below
 * it cannot support a finding, so serving it as real data buys nothing and risks
 * everything.
 */
export const MIN_REAL_CELLS = 8

/**
 * Activity ids that are obviously not from the API.
 *
 * The committed fake this check was written for carried `act-1` and `act-2`.
 * Real FortyGuard activity ids are opaque and long; anything short, sequential or
 * spelled like a placeholder is fabricated metadata, and fabricated provenance on
 * a file that claims `REAL` is the single most dangerous thing this store can
 * contain.
 */
const PLACEHOLDER_ACTIVITY_ID =
  /^(act|activity|id|test|fixture|placeholder|sample|dummy|todo|example|foo|bar|xxx)[-_]?\d*$/i
const MIN_ACTIVITY_ID_LENGTH = 8

export interface ThermalSnapshotRequest {
  aoiId: string
  analysisDate: string
  snapshotTimes: string[]
  analyticType: string
  granularityMeters: number
  filterType: number
  timezone: string
}

/** One requested hour, and what was actually transmitted for it. */
export interface CaptureTimestamp {
  requestedLocalDate: string
  requestedLocalTime: string
  requestedLocalIso: string
  transmittedDate: string
  transmittedTime: string
  transmittedIsoUtc: string
}

/**
 * What the capture run did, recorded so the claim can be audited.
 *
 * `timestamps` is the load-bearing part: a declared timezone strategy is not
 * evidence that it was applied, but a pair of requested-local and transmitted
 * values is.
 */
export interface CaptureMetadata {
  capturedAtUtc: string
  captureToolVersion: string
  /** Tiles the AOI was split into, and the billable submissions that implies. */
  tileCount: number
  submissionCount: number
  timestamps: CaptureTimestamp[]
}

export interface ThermalSnapshotSource {
  /** What produced the cells. `LIVE_FORTYGUARD` is the only real capture. */
  dataMode: Extract<DataMode, 'LIVE_FORTYGUARD' | 'DEMO_SYNTHETIC'>
  provenance: Provenance
  /** Every FortyGuard activity that contributed, in submission order. */
  activityIds: string[]
  /** Feature property the value was read from. Selecting it confirms nothing else. */
  valueField: string | null
  /** Unit, only when the probe confirmed the field, its meaning AND the unit. */
  unit: string | null
  unitConfirmed: boolean
  /** Whether the probe confirmed the field holds a temperature at all. */
  semanticsConfirmed: boolean
  /** The timezone strategy in force when the request was submitted. */
  timezoneStrategy: TimezoneStrategy
  /** Whether that strategy was the one the client executed. */
  timezoneStrategyApplied: boolean
  /** Probe run that authorised the field/unit reading, when there was one. */
  capabilityProbeRunId: string | null
  /** Digest of every capability answer in force at capture time. */
  capabilityFingerprint: string
  capture: CaptureMetadata
  notes: string[]
}

export interface ThermalSnapshot {
  kind: typeof SNAPSHOT_KIND
  version: typeof SNAPSHOT_VERSION
  request: ThermalSnapshotRequest
  source: ThermalSnapshotSource
  /**
   * Digest of the surface: the request parameters and each cell's position, time
   * and value. Deliberately excludes the capture time, the activity ids and the
   * rings, so two captures of the same surface agree.
   */
  surfaceSha256: string
  /**
   * Digest of the whole claim. Any edit to what this file asserts about itself
   * changes this value, and it is what the run id is derived from.
   */
  attestationSha256: string
  cells: ThermalCell[]
}

function canonicalRequest(request: ThermalSnapshotRequest) {
  return {
    aoiId: request.aoiId,
    analysisDate: request.analysisDate,
    snapshotTimes: [...request.snapshotTimes].sort(),
    analyticType: request.analyticType,
    granularityMeters: request.granularityMeters,
    filterType: request.filterType,
    timezone: request.timezone,
  }
}

function orderedCells(cells: readonly ThermalCell[]) {
  return [...cells].sort((a, b) =>
    a.snapshot < b.snapshot
      ? -1
      : a.snapshot > b.snapshot
        ? 1
        : a.id < b.id
          ? -1
          : a.id > b.id
            ? 1
            : 0,
  )
}

/** The numbers and where they are. Nothing about how they were obtained. */
export function surfaceHash(
  request: ThermalSnapshotRequest,
  cells: readonly ThermalCell[],
): string {
  const payload = {
    request: canonicalRequest(request),
    cells: orderedCells(cells).map((cell) => ({
      i: cell.id,
      s: cell.snapshot,
      x: Number(cell.centroidLon.toFixed(7)),
      y: Number(cell.centroidLat.toFixed(7)),
      v: Number(cell.value.toFixed(6)),
    })),
  }
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

/**
 * Everything the file asserts about itself, including the geometry.
 *
 * Rings are here rather than in the surface hash because they are a claim about
 * the sensor's footprint, not about the values: two captures at different
 * granularities can share a value at a centroid while covering different ground,
 * and a reader deciding whether a stop is inside a cell needs to know the
 * footprint was not edited.
 */
export function attestationHash(snapshot: {
  request: ThermalSnapshotRequest
  source: ThermalSnapshotSource
  surfaceSha256: string
  cells: readonly ThermalCell[]
}): string {
  const payload = {
    kind: SNAPSHOT_KIND,
    version: SNAPSHOT_VERSION,
    surface: snapshot.surfaceSha256,
    request: canonicalRequest(snapshot.request),
    source: {
      dataMode: snapshot.source.dataMode,
      provenance: snapshot.source.provenance,
      activityIds: [...snapshot.source.activityIds],
      valueField: snapshot.source.valueField,
      unit: snapshot.source.unit,
      unitConfirmed: snapshot.source.unitConfirmed,
      semanticsConfirmed: snapshot.source.semanticsConfirmed,
      timezoneStrategy: snapshot.source.timezoneStrategy,
      timezoneStrategyApplied: snapshot.source.timezoneStrategyApplied,
      capabilityProbeRunId: snapshot.source.capabilityProbeRunId,
      capabilityFingerprint: snapshot.source.capabilityFingerprint,
      capture: {
        capturedAtUtc: snapshot.source.capture.capturedAtUtc,
        captureToolVersion: snapshot.source.capture.captureToolVersion,
        tileCount: snapshot.source.capture.tileCount,
        submissionCount: snapshot.source.capture.submissionCount,
        timestamps: snapshot.source.capture.timestamps.map((entry) => [
          entry.requestedLocalDate,
          entry.requestedLocalTime,
          entry.requestedLocalIso,
          entry.transmittedDate,
          entry.transmittedTime,
          entry.transmittedIsoUtc,
        ]),
      },
      notes: [...snapshot.source.notes],
    },
    rings: orderedCells(snapshot.cells).map((cell) => [
      cell.id,
      cell.ring.map(([lon, lat]) => [Number(lon.toFixed(7)), Number(lat.toFixed(7))]),
    ]),
  }
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

export function buildThermalSnapshot(input: {
  request: ThermalSnapshotRequest
  source: ThermalSnapshotSource
  cells: readonly ThermalCell[]
}): ThermalSnapshot {
  const cells = orderedCells(input.cells)
  const surfaceSha256 = surfaceHash(input.request, cells)
  return {
    kind: SNAPSHOT_KIND,
    version: SNAPSHOT_VERSION,
    request: input.request,
    source: input.source,
    surfaceSha256,
    attestationSha256: attestationHash({
      request: input.request,
      source: input.source,
      surfaceSha256,
      cells,
    }),
    cells,
  }
}

export class ThermalSnapshotError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ThermalSnapshotError'
  }
}

function isCaptureMetadata(value: unknown): value is CaptureMetadata {
  if (!value || typeof value !== 'object') return false
  const metadata = value as Partial<CaptureMetadata>
  return (
    typeof metadata.capturedAtUtc === 'string' &&
    typeof metadata.captureToolVersion === 'string' &&
    typeof metadata.tileCount === 'number' &&
    typeof metadata.submissionCount === 'number' &&
    Array.isArray(metadata.timestamps) &&
    metadata.timestamps.every(
      (entry) =>
        entry !== null &&
        typeof entry === 'object' &&
        typeof entry.requestedLocalDate === 'string' &&
        typeof entry.requestedLocalTime === 'string' &&
        typeof entry.requestedLocalIso === 'string' &&
        typeof entry.transmittedDate === 'string' &&
        typeof entry.transmittedTime === 'string' &&
        typeof entry.transmittedIsoUtc === 'string',
    )
  )
}

/**
 * Validate a snapshot read from disk.
 *
 * Both digests are **recomputed**, never trusted. A file whose surface hash
 * matches but whose attestation hash does not has had its provenance edited while
 * its numbers were left alone — which is the edit worth catching, and the one a
 * single hash missed.
 *
 * This is the structural pass, applied to every snapshot. The additional rules a
 * file must satisfy before it may be served as **real data** are in
 * `realCaptureFailures`, because they depend on the current capability manifest
 * and on the request being answered.
 */
export function validateThermalSnapshot(value: unknown): ThermalSnapshot {
  if (!value || typeof value !== 'object') {
    throw new ThermalSnapshotError('Thermal snapshot is not an object.')
  }
  const snapshot = value as Partial<ThermalSnapshot>

  if (snapshot.kind !== SNAPSHOT_KIND) {
    throw new ThermalSnapshotError(`Thermal snapshot has kind "${String(snapshot.kind)}".`)
  }
  if (snapshot.version !== SNAPSHOT_VERSION) {
    throw new ThermalSnapshotError(
      `Thermal snapshot version ${String(snapshot.version)} is not supported (expected ${SNAPSHOT_VERSION}).`,
    )
  }
  if (!snapshot.request || !snapshot.source || !Array.isArray(snapshot.cells)) {
    throw new ThermalSnapshotError('Thermal snapshot is missing request, source or cells.')
  }
  if (snapshot.cells.length === 0) {
    throw new ThermalSnapshotError('Thermal snapshot contains no cells.')
  }
  if (
    snapshot.source.dataMode !== 'LIVE_FORTYGUARD' &&
    snapshot.source.dataMode !== 'DEMO_SYNTHETIC'
  ) {
    throw new ThermalSnapshotError(
      `Thermal snapshot dataMode "${String(snapshot.source.dataMode)}" is not a capture mode.`,
    )
  }
  if (!TIMEZONE_STRATEGIES.includes(snapshot.source.timezoneStrategy)) {
    throw new ThermalSnapshotError(
      `Thermal snapshot timezone strategy "${String(snapshot.source.timezoneStrategy)}" is not one this product applies.`,
    )
  }
  /*
   * Types, before anything downstream coerces them.
   *
   * Both digests are recomputed from the file's own contents, so a hand-written
   * snapshot can always make them agree. The only defence is refusing values of
   * the wrong shape — and the later checks were written assuming strings and
   * booleans. `activityIds: [12345678]` survived a regex test and a `.length`
   * comparison against `undefined`; `timezoneStrategyApplied: "false"` is a
   * non-empty string and therefore truthy, so the file asserted the opposite of
   * what it said.
   */
  const source = snapshot.source
  const typeProblems: string[] = []
  if (!Array.isArray(source.activityIds) || source.activityIds.some((id) => typeof id !== 'string')) {
    typeProblems.push('activityIds must be an array of strings')
  }
  for (const flag of ['unitConfirmed', 'semanticsConfirmed', 'timezoneStrategyApplied'] as const) {
    if (typeof source[flag] !== 'boolean') typeProblems.push(`${flag} must be a boolean`)
  }
  if (source.valueField !== null && typeof source.valueField !== 'string') {
    typeProblems.push('valueField must be a string or null')
  }
  if (source.unit !== null && typeof source.unit !== 'string') {
    typeProblems.push('unit must be a string or null')
  }
  if (source.capabilityProbeRunId !== null && typeof source.capabilityProbeRunId !== 'string') {
    typeProblems.push('capabilityProbeRunId must be a string or null')
  }
  if (typeof source.provenance !== 'string') typeProblems.push('provenance must be a string')
  if (!Array.isArray(source.notes) || source.notes.some((note) => typeof note !== 'string')) {
    typeProblems.push('notes must be an array of strings')
  }
  if (typeProblems.length > 0) {
    throw new ThermalSnapshotError(
      `Thermal snapshot has malformed source fields: ${typeProblems.join('; ')}. Both digests are ` +
        'computed from the file, so they cannot catch this — only the types can.',
    )
  }

  if (typeof snapshot.source.capabilityFingerprint !== 'string') {
    throw new ThermalSnapshotError(
      'Thermal snapshot records no capability fingerprint, so nothing binds its numbers to the ' +
        'answers they were read under.',
    )
  }
  if (!isCaptureMetadata(snapshot.source.capture)) {
    throw new ThermalSnapshotError(
      'Thermal snapshot is missing or has malformed capture metadata (capturedAtUtc, tool ' +
        'version, tile and submission counts, and the requested/transmitted timestamps).',
    )
  }

  const surface = surfaceHash(snapshot.request, snapshot.cells)
  if (surface !== snapshot.surfaceSha256) {
    throw new ThermalSnapshotError(
      `Thermal snapshot SURFACE hash mismatch: recomputed ${surface}, recorded ${String(snapshot.surfaceSha256)}. ` +
        'The values or their positions have been edited since capture.',
    )
  }

  const attestation = attestationHash({
    request: snapshot.request,
    source: snapshot.source,
    surfaceSha256: surface,
    cells: snapshot.cells,
  })
  if (attestation !== snapshot.attestationSha256) {
    throw new ThermalSnapshotError(
      `Thermal snapshot ATTESTATION hash mismatch: recomputed ${attestation}, recorded ${String(snapshot.attestationSha256)}. ` +
        'The values are unchanged but what the file claims about them — its provenance, mode, ' +
        'activity ids, field, unit, timezone, capability fingerprint, capture metadata or rings — ' +
        'has been edited.',
    )
  }

  return snapshot as ThermalSnapshot
}

/**
 * The data mode a run gets from serving this snapshot.
 *
 * The single place a stored snapshot can become `CACHED_REAL_DATA`, and it
 * requires the recorded capture mode to be a real one. A snapshot of the fixture
 * stays `DEMO_SYNTHETIC` for ever.
 */
export function dataModeForSnapshot(snapshot: ThermalSnapshot): DataMode {
  return snapshot.source.dataMode === 'LIVE_FORTYGUARD' ? 'CACHED_REAL_DATA' : 'DEMO_SYNTHETIC'
}

/**
 * Every reason this snapshot may not be served as real data.
 *
 * Returns a list rather than a boolean so the caller can say *why* — a silent
 * false here is how a repository ends up with a rejected file nobody notices and
 * an operator convinced the capture worked.
 *
 * Empty means the file is a genuine capture, internally consistent, complete
 * enough to support a finding, and read under exactly the capability answers
 * currently in force.
 */
export function realCaptureFailures(
  snapshot: ThermalSnapshot,
  options: { capability?: CapabilityConfirmation; capabilityFingerprint?: string } = {},
): string[] {
  const capability = options.capability ?? loadCapability()
  const fingerprint = options.capabilityFingerprint ?? capabilityFingerprint(capability)
  const failures: string[] = []
  const { source, request, cells } = snapshot

  if (source.dataMode !== 'LIVE_FORTYGUARD') {
    failures.push(
      `records dataMode ${source.dataMode}, which is not a live capture. Persisting synthetic ` +
        'numbers does not make them a measurement.',
    )
  }
  if (source.provenance !== 'REAL') {
    failures.push(`records provenance ${source.provenance}, not REAL.`)
  }

  if (source.activityIds.length === 0) {
    failures.push('carries no FortyGuard activity ids, so no submission can be traced to it.')
  } else {
    const suspicious = source.activityIds.filter(
      (id) => PLACEHOLDER_ACTIVITY_ID.test(id) || id.length < MIN_ACTIVITY_ID_LENGTH,
    )
    if (suspicious.length > 0) {
      failures.push(
        `carries placeholder activity ids (${suspicious.join(', ')}). Fabricated provenance on a ` +
          'file claiming REAL is worse than no file.',
      )
    }
  }

  if (cells.length < MIN_REAL_CELLS) {
    failures.push(
      `contains ${cells.length} cell(s); ${MIN_REAL_CELLS} are the minimum the thermal gate needs ` +
        'before it can say anything about discrimination.',
    )
  }

  /* ---- coverage: every requested hour must actually have arrived ---------- */
  const timesPresent = new Set(cells.map((cell) => cell.snapshot.split('T')[1] ?? ''))
  const missingTimes = request.snapshotTimes.filter((time) => !timesPresent.has(time))
  if (missingTimes.length > 0) {
    failures.push(`has no cells for requested hour(s) ${missingTimes.join(', ')}.`)
  }
  const extraTimes = [...timesPresent].filter((time) => !request.snapshotTimes.includes(time))
  if (extraTimes.length > 0) {
    failures.push(
      `contains cells for hour(s) ${extraTimes.join(', ')} that its own request does not list.`,
    )
  }

  /* ---- internal consistency of the capture record ------------------------ */
  const capture = source.capture
  if (capture.timestamps.length !== request.snapshotTimes.length) {
    failures.push(
      `records ${capture.timestamps.length} transmitted timestamp(s) for ` +
        `${request.snapshotTimes.length} requested hour(s).`,
    )
  }
  const recordedLocalTimes = capture.timestamps.map((entry) => entry.requestedLocalTime).sort()
  const requestedTimes = [...request.snapshotTimes].sort()
  if (recordedLocalTimes.join(',') !== requestedTimes.join(',')) {
    failures.push(
      `records requested local hours [${recordedLocalTimes.join(', ')}] against a request for ` +
        `[${requestedTimes.join(', ')}].`,
    )
  }
  for (const entry of capture.timestamps) {
    if (entry.requestedLocalDate !== request.analysisDate) {
      failures.push(
        `records a requested local date ${entry.requestedLocalDate} against an analysis date of ` +
          `${request.analysisDate}.`,
      )
    }
    if (!Number.isFinite(Date.parse(entry.transmittedIsoUtc))) {
      failures.push(`records an unparseable transmitted instant "${entry.transmittedIsoUtc}".`)
    }
  }
  if (
    !Number.isInteger(capture.submissionCount) ||
    !Number.isInteger(capture.tileCount) ||
    capture.submissionCount <= 0 ||
    capture.tileCount <= 0
  ) {
    failures.push(
      `records ${capture.submissionCount} submission(s) across ${capture.tileCount} tile(s); a ` +
        'real capture bills at least one whole submission per whole tile.',
    )
  }
  /*
   * The counts have to agree with each other and with the activity ids.
   *
   * A capture bills one submission per tile per hour, and each returns one
   * activity id, so these three numbers are the same fact recorded three ways.
   * They were validated independently, so a file could claim two submissions
   * while naming one activity — and the fixture this project called "a snapshot
   * that passes every real-capture rule" did exactly that.
   */
  const expectedSubmissions = capture.tileCount * request.snapshotTimes.length
  if (Number.isInteger(capture.submissionCount) && capture.submissionCount !== expectedSubmissions) {
    failures.push(
      `records ${capture.submissionCount} submission(s) for ${capture.tileCount} tile(s) across ` +
        `${request.snapshotTimes.length} hour(s), which bills ${expectedSubmissions}.`,
    )
  }
  if (source.activityIds.length !== capture.submissionCount) {
    failures.push(
      `names ${source.activityIds.length} activity id(s) for ${capture.submissionCount} ` +
        'submission(s). Every billed submission returns exactly one id.',
    )
  }
  if (new Set(source.activityIds).size !== source.activityIds.length) {
    failures.push('repeats an activity id. Two submissions cannot share one.')
  }
  if (!Number.isFinite(Date.parse(capture.capturedAtUtc))) {
    failures.push(`records an unparseable capture instant "${capture.capturedAtUtc}".`)
  }

  /* ---- the strategy must have been executed, not merely declared --------- */
  // Required, not merely checked-when-claimed. `runCapture` sets it because it
  // executes the strategy; a file that says false was produced by something else,
  // and its timestamps are then unexplained rather than merely unverified.
  if (!source.timezoneStrategyApplied) {
    failures.push(
      'records timezoneStrategyApplied=false, so nothing accounts for the relationship between ' +
        'the hours requested and the hours transmitted.',
    )
  }
  if (source.timezoneStrategyApplied) {
    const inconsistent = capture.timestamps.filter((entry) =>
      source.timezoneStrategy === 'send_local_wallclock_unconverted'
        ? entry.transmittedTime !== entry.requestedLocalTime ||
          entry.transmittedDate !== entry.requestedLocalDate
        : entry.transmittedIsoUtc.slice(0, 10) !== entry.transmittedDate ||
          entry.transmittedIsoUtc.slice(11, 16) !== entry.transmittedTime,
    )
    if (inconsistent.length > 0) {
      failures.push(
        `claims the ${source.timezoneStrategy} strategy was applied, but ${inconsistent.length} ` +
          'transmitted timestamp(s) do not match what that strategy produces.',
      )
    }
  }

  /* ---- unit claims must be backed --------------------------------------- */
  if (source.unitConfirmed && source.unit !== LITERAL_CELSIUS) {
    failures.push(
      `claims a confirmed unit of "${String(source.unit)}", which is not literally ${LITERAL_CELSIUS}.`,
    )
  }
  if (source.unitConfirmed && !source.semanticsConfirmed) {
    failures.push(
      'claims a confirmed Celsius unit while the field is not confirmed to hold a temperature.',
    )
  }
  if (source.unitConfirmed && source.valueField === null) {
    failures.push('claims a confirmed unit without naming the field it belongs to.')
  }

  /* ---- capability binding ------------------------------------------------ */
  //
  // The fingerprint alone is a **copied string**. A hand-written file can carry a
  // matching one beside fields that contradict it, and because the attestation
  // hash is computed from the file's own contents, regenerating it after such an
  // edit is trivial. The fingerprint is necessary and not sufficient, so each
  // load-bearing field is also compared against the manifest directly.
  if (source.capabilityFingerprint !== fingerprint) {
    failures.push(
      `was captured under capability fingerprint ${source.capabilityFingerprint.slice(0, 12)}…, ` +
        `and the manifest now reads ${fingerprint.slice(0, 12)}…. The field, unit, semantics, ` +
        'timezone strategy or endpoint identity has changed since capture. Re-capture; do not ' +
        'relabel.',
    )
  }
  if (source.capabilityProbeRunId !== capability.probeRunId) {
    failures.push(
      `names probe run ${String(source.capabilityProbeRunId)} while the manifest names ` +
        `${String(capability.probeRunId)}.`,
    )
  }
  if (source.timezoneStrategy !== capability.timezone.strategy) {
    failures.push(
      `transmitted under the ${source.timezoneStrategy} strategy while the manifest declares ` +
        `${capability.timezone.strategy}.`,
    )
  }
  if (capability.valueField.confirmed && source.valueField !== capability.valueField.name) {
    failures.push(
      `read the field "${String(source.valueField)}" while the manifest confirms ` +
        `"${String(capability.valueField.name)}".`,
    )
  }
  if (source.unitConfirmed && !(capability.unit.confirmed && capability.unit.unit === LITERAL_CELSIUS)) {
    failures.push(
      'claims a confirmed unit while the manifest does not confirm one. A snapshot cannot ' +
        'establish its own unit.',
    )
  }
  if (source.semanticsConfirmed && !capability.semantics.confirmed) {
    failures.push(
      'claims the field was confirmed to hold a temperature while the manifest does not confirm it.',
    )
  }

  return failures
}

/** True only for a snapshot that passes every real-capture rule. */
export function isRealCapture(
  snapshot: ThermalSnapshot,
  options: { capability?: CapabilityConfirmation; capabilityFingerprint?: string } = {},
): boolean {
  return realCaptureFailures(snapshot, options).length === 0
}

/**
 * Does this snapshot answer the request being made?
 *
 * The **complete** request, not a prefix of it. Matching on area and date alone
 * let a 100 m capture answer a 60 m request, and a `filter_type: 2` range answer
 * a single-hour question — different measurements, served interchangeably.
 */
export function snapshotAnswersRequest(
  snapshot: ThermalSnapshot,
  request: ThermalSnapshotRequest,
): { matches: boolean; reason: string | null } {
  const mismatch = (field: string, mine: unknown, theirs: unknown) => ({
    matches: false as const,
    reason: `snapshot ${field} is ${String(mine)}, request asks for ${String(theirs)}`,
  })

  if (snapshot.request.aoiId !== request.aoiId) {
    return mismatch('area', snapshot.request.aoiId, request.aoiId)
  }
  if (snapshot.request.analysisDate !== request.analysisDate) {
    return mismatch('date', snapshot.request.analysisDate, request.analysisDate)
  }
  if (snapshot.request.analyticType !== request.analyticType) {
    return mismatch('analytic type', snapshot.request.analyticType, request.analyticType)
  }
  if (snapshot.request.granularityMeters !== request.granularityMeters) {
    return mismatch('granularity', snapshot.request.granularityMeters, request.granularityMeters)
  }
  if (snapshot.request.filterType !== request.filterType) {
    return mismatch('filter type', snapshot.request.filterType, request.filterType)
  }
  if (snapshot.request.timezone !== request.timezone) {
    return mismatch('timezone', snapshot.request.timezone, request.timezone)
  }
  const have = new Set(snapshot.request.snapshotTimes)
  const missing = request.snapshotTimes.filter((time) => !have.has(time))
  if (missing.length > 0) {
    return { matches: false, reason: `snapshot has no cells for ${missing.join(', ')}` }
  }
  return { matches: true, reason: null }
}
