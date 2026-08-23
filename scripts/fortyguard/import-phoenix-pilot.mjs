#!/usr/bin/env node
/**
 * Import the three already-paid Phoenix captures into the immutable snapshot store.
 *
 * This script never touches the network and cannot spend credits. It accepts the
 * original capture directory explicitly so a reviewer can reproduce the committed
 * snapshot from the raw API envelopes without copying credentials into this repo.
 *
 * Usage:
 *   npm run fortyguard:import-pilot -- --input-dir /path/to/data/snapshots
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const { FORTYGUARD_PILOT_REQUEST } = await import('../../lib/geo/aoi.ts')
const { ANALYSIS_TIMEZONE } = await import('../../lib/agent/request.ts')
const { loadCapability, capabilityFingerprint } = await import('../../lib/fortyguard/capability.ts')
const { normalizeFeatureCollection } = await import('../../lib/fortyguard/normalize.ts')
const { applyTimezoneStrategy } = await import('../../lib/fortyguard/timezone.ts')
const { buildThermalSnapshot } = await import('../../lib/fortyguard/snapshot.ts')
const { writeThermalSnapshot } = await import('../../lib/fortyguard/snapshot-store.ts')

const FILES_BY_TIME = new Map([
  ['08:00', 'phoenix_2024_0800.json'],
  ['14:00', 'phoenix_2024_smoke.json'],
  ['20:00', 'phoenix_2024_2000.json'],
])
const EXPECTED_BBOX = [-112.081, 33.442, -112.067, 33.455]
const EXPECTED_RETURNED_BBOX = [
  -112.07774530714039,
  33.44165867544603,
  -112.06699188721771,
  33.45504579568956,
]
const VALUE_FIELD = 'average_temperature'
const IMPORTER_VERSION = 'scripts/fortyguard/import-phoenix-pilot.mjs@1.1.0'

function fail(message) {
  throw new Error(`Pilot import refused: ${message}`)
}

function parseArgs(argv) {
  let inputDir = null
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--input-dir') inputDir = argv[++index]
    else if (token === '--help' || token === '-h') return { help: true, inputDir: null }
    else fail(`unknown argument ${token}`)
  }
  return { help: false, inputDir }
}

function sha256(body) {
  return createHash('sha256').update(body).digest('hex')
}

function bboxOfFeatureCollection(collection) {
  const points = collection?.features?.[0]?.geometry?.coordinates?.[0]
  if (!Array.isArray(points) || points.length < 4) fail('request AOI is not the expected polygon')
  const lons = points.map((point) => Number(point?.[0]))
  const lats = points.map((point) => Number(point?.[1]))
  return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)]
}

function sameNumbers(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function bboxOfReturnedFeatures(collection) {
  const points = collection.features.flatMap((feature) => feature.geometry?.coordinates?.[0] ?? [])
  if (points.length === 0) fail('response contains no polygon coordinates')
  const lons = points.map((point) => Number(point?.[0]))
  const lats = points.map((point) => Number(point?.[1]))
  return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)]
}

const args = parseArgs(process.argv.slice(2))
if (args.help || !args.inputDir) {
  process.stdout.write(
    'Usage: npm run fortyguard:import-pilot -- --input-dir <raw-capture-directory>\n' +
      'Reads three existing JSON captures. Performs no network requests.\n',
  )
  process.exit(args.help ? 0 : 64)
}

const capability = loadCapability()
if (
  !capability.valueField.confirmed ||
  capability.valueField.name !== VALUE_FIELD ||
  !capability.unit.confirmed ||
  !capability.semantics.confirmed
) {
  fail('the reviewed capability manifest does not confirm the imported field, semantics and unit')
}

const cells = []
const activityIds = []
const timestamps = []
const evidence = []
const capturedAt = []
const seen = new Set()

for (const time of FORTYGUARD_PILOT_REQUEST.snapshotTimes) {
  const filename = FILES_BY_TIME.get(time)
  if (!filename) fail(`no source file is declared for ${time}`)
  const path = resolve(args.inputDir, filename)
  const body = readFileSync(path, 'utf8')
  const envelope = JSON.parse(body)
  const request = envelope.request_payload
  const completed = envelope.completed_response?.data
  const collection = completed?.result?.map_data
  const activityId = completed?.activity_id

  if (completed?.status !== 'Completed') fail(`${filename} is not Completed`)
  if (typeof activityId !== 'string' || activityId.length < 8) fail(`${filename} has no real activity id`)
  // FortyGuard defaults an omitted analytic_type to tcm. The original smoke
  // request exercised that documented default and its local validator recorded
  // the resolved analytic, so require one of those two explicit pieces of proof.
  if ((request?.analytic_type ?? envelope.validation?.analytic_type) !== 'tcm') {
    fail(`${filename} is not a tcm capture`)
  }
  if (request?.granularity !== 100) fail(`${filename} is not a 100 m capture`)
  if (request?.date_time?.filter_type !== 1) fail(`${filename} is not a single-hour capture`)
  if (request?.date_time?.start_date !== FORTYGUARD_PILOT_REQUEST.analysisDate) {
    fail(`${filename} has the wrong analysis date`)
  }
  if (request?.date_time?.start_time !== time) fail(`${filename} has the wrong hour`)
  if (!sameNumbers(bboxOfFeatureCollection(request?.polygon_aoi), EXPECTED_BBOX)) {
    fail(`${filename} does not cover the reviewed pilot AOI`)
  }
  if (collection?.type !== 'FeatureCollection' || collection.features?.length !== 150) {
    fail(`${filename} does not contain the reviewed 150-cell FeatureCollection`)
  }
  if (!sameNumbers(bboxOfReturnedFeatures(collection), EXPECTED_RETURNED_BBOX)) {
    fail(`${filename} returned a different footprint from the reviewed pilot`)
  }

  const normalized = normalizeFeatureCollection(collection, {
    valueField: VALUE_FIELD,
    snapshot: `${FORTYGUARD_PILOT_REQUEST.analysisDate}T${time}`,
    seen,
  })
  if (normalized.cells.length !== 150 || normalized.skipped !== 0) {
    fail(`${filename} normalized to ${normalized.cells.length} cells with ${normalized.skipped} skipped`)
  }

  cells.push(...normalized.cells)
  activityIds.push(activityId)
  capturedAt.push(envelope.captured_at_utc)
  evidence.push(`${filename} sha256:${sha256(body)}`)

  const transmitted = applyTimezoneStrategy({
    strategy: capability.timezone.strategy,
    timezone: ANALYSIS_TIMEZONE,
    analysisDate: FORTYGUARD_PILOT_REQUEST.analysisDate,
    localTime: time,
  })
  timestamps.push({
    requestedLocalDate: transmitted.requestedLocalDate,
    requestedLocalTime: transmitted.requestedLocalTime,
    requestedLocalIso: transmitted.requestedLocalIso,
    transmittedDate: request.date_time.start_date,
    transmittedTime: request.date_time.start_time,
    transmittedIsoUtc: transmitted.transmittedIsoUtc,
  })
}

const fingerprint = capabilityFingerprint(capability)
const snapshot = buildThermalSnapshot({
  request: {
    aoiId: FORTYGUARD_PILOT_REQUEST.aoiId,
    analysisDate: FORTYGUARD_PILOT_REQUEST.analysisDate,
    snapshotTimes: [...FORTYGUARD_PILOT_REQUEST.snapshotTimes],
    analyticType: 'tcm',
    granularityMeters: 100,
    filterType: 1,
    timezone: ANALYSIS_TIMEZONE,
  },
  source: {
    dataMode: 'LIVE_FORTYGUARD',
    provenance: 'REAL',
    activityIds,
    valueField: VALUE_FIELD,
    unit: capability.unit.unit,
    unitConfirmed: capability.unit.confirmed,
    semanticsConfirmed: capability.semantics.confirmed,
    timezoneStrategy: capability.timezone.strategy,
    timezoneStrategyApplied: true,
    capabilityProbeRunId: capability.probeRunId,
    capabilityFingerprint: fingerprint,
    capture: {
      capturedAtUtc: [...capturedAt].sort().at(-1),
      captureToolVersion: IMPORTER_VERSION,
      tileCount: 1,
      submissionCount: activityIds.length,
      timestamps,
    },
    notes: [
      'Imported from three completed, already-paid FortyGuard API activities; the importer performs no network request.',
      'The API response omits timezone metadata. AOI-local interpretation is supported by a three-point baseline comparison but remains unconfirmed.',
      'The submitted rectangle was larger than the returned 150-cell footprint. The app AOI is deliberately clipped to the identical footprint returned at all three hours.',
      'This snapshot covers only the Downtown Phoenix pilot footprint; it must not be represented as Central or Full Phoenix coverage.',
      ...evidence,
    ],
  },
  cells,
})

const outcome = writeThermalSnapshot(snapshot, { capabilityFingerprint: fingerprint })
process.stdout.write(
  `${outcome.alreadyPresent ? 'Verified existing' : 'Wrote'} ${outcome.path}\n` +
    `${snapshot.cells.length} cells · ${activityIds.length} activities · ` +
    `surface ${snapshot.surfaceSha256.slice(0, 16)}… · attestation ${snapshot.attestationSha256.slice(0, 16)}…\n`,
)
