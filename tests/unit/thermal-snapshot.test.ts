import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ThermalCell } from '@/lib/types'
import {
  MIN_REAL_CELLS,
  attestationHash,
  buildThermalSnapshot,
  dataModeForSnapshot,
  isRealCapture,
  realCaptureFailures,
  snapshotAnswersRequest,
  surfaceHash,
  validateThermalSnapshot,
  ThermalSnapshotError,
  type ThermalSnapshotRequest,
  type ThermalSnapshotSource,
} from '@/lib/fortyguard/snapshot'
import {
  LITERAL_CELSIUS,
  capabilityFingerprint,
  evaluateCapability,
  loadCapability,
  parseCapability,
} from '@/lib/fortyguard/capability'
import {
  AmbiguousSnapshotError,
  auditSnapshotStore,
  loadThermalSnapshot,
  snapshotFileName,
  writeThermalSnapshot,
} from '@/lib/fortyguard/snapshot-store'
import { acquireCaptureLock, CaptureLockedError, requestKey } from '@/lib/fortyguard/capture'
import { deriveRunId } from '@/lib/audit/log'
import { executeRun, finalizeRun } from '@/lib/agent/run'

/**
 * The snapshot format, the capability binding, and the credit guard.
 *
 * Several of these are regression tests for a file that was actually committed:
 * `central-phoenix_2026-08-03_cb70c3ff14e7f60c.json`, which claimed
 * `LIVE_FORTYGUARD` / `REAL`, carried `act-1` and `act-2` as activity ids and a
 * confirmed `°C` unit, and contained **zero cells**. It sat in the production
 * snapshot store and nothing went red. Every one of its four defects now has its
 * own assertion, and `npm run check:snapshots` fails CI on any of them.
 */

const REQUEST: ThermalSnapshotRequest = {
  aoiId: 'central-phoenix',
  analysisDate: '2026-08-03',
  snapshotTimes: ['11:00', '14:00'],
  analyticType: 'tcm',
  granularityMeters: 60,
  filterType: 1,
  timezone: 'America/Phoenix',
}

/** Ten cells across the two requested hours: above the real-capture floor. */
const cells = (offset = 0): ThermalCell[] =>
  REQUEST.snapshotTimes.flatMap((time, timeIndex) =>
    Array.from({ length: 5 }, (_unused, index) => {
      const lon = -112.07 + index * 0.002
      const lat = 33.45 + index * 0.002
      return {
        id: `c${timeIndex}-${index}`,
        centroidLon: lon,
        centroidLat: lat,
        ring: [
          [lon - 0.001, lat - 0.001],
          [lon + 0.001, lat - 0.001],
          [lon + 0.001, lat + 0.001],
          [lon - 0.001, lat + 0.001],
        ] as Array<[number, number]>,
        value: 41.5 + index * 0.4 + timeIndex + offset,
        snapshot: `${REQUEST.analysisDate}T${time}`,
      }
    }),
  )

const SHIPPED_CAPABILITY = loadCapability()
const FINGERPRINT = capabilityFingerprint(SHIPPED_CAPABILITY)

const timestamps = () =>
  REQUEST.snapshotTimes.map((time) => ({
    requestedLocalDate: REQUEST.analysisDate,
    requestedLocalTime: time,
    requestedLocalIso: `${REQUEST.analysisDate}T${time}:00-07:00`,
    transmittedDate: REQUEST.analysisDate,
    transmittedTime: time,
    transmittedIsoUtc: `${REQUEST.analysisDate}T${Number(time.slice(0, 2)) + 7}:00:00.000Z`,
  }))

/**
 * A snapshot that passes every real-capture rule.
 *
 * Deliberately built from the *current* capability fingerprint, so a test that
 * perturbs one field is testing that field rather than an unrelated staleness.
 */
const snapshotOf = (overrides: Partial<ThermalSnapshotSource> = {}, offset = 0) =>
  buildThermalSnapshot({
    request: REQUEST,
    source: {
      dataMode: 'LIVE_FORTYGUARD',
      provenance: 'REAL',
      // One id per billed submission: 1 tile x 2 hours = 2. The old fixture
      // claimed two submissions and named one activity, and called itself "a
      // snapshot that passes every real-capture rule" — which is exactly the
      // inconsistency the cross-check now catches.
      activityIds: [
        '9f3c1a77-2b40-4d8e-9c11-6a0f5d2e8b31',
        '2c8e5b10-77af-4d31-b0c9-1e4a6f93dd22',
      ],
      valueField: SHIPPED_CAPABILITY.valueField.name,
      unit: SHIPPED_CAPABILITY.unit.unit,
      unitConfirmed: SHIPPED_CAPABILITY.unit.confirmed,
      semanticsConfirmed: SHIPPED_CAPABILITY.semantics.confirmed,
      timezoneStrategy: 'send_local_wallclock_unconverted',
      timezoneStrategyApplied: true,
      // Must match the shipped manifest: the snapshot's recorded probe run, value
      // field, unit and strategy are now compared against it directly, not only
      // via the copied fingerprint.
      capabilityProbeRunId: SHIPPED_CAPABILITY.probeRunId,
      capabilityFingerprint: FINGERPRINT,
      capture: {
        capturedAtUtc: '2026-08-03T20:00:00.000Z',
        captureToolVersion: 'test',
        tileCount: 1,
        submissionCount: 2,
        timestamps: timestamps(),
      },
      notes: [],
      ...overrides,
    },
    cells: cells(offset),
  })

const failures = (source: Partial<ThermalSnapshotSource> = {}, offset = 0) =>
  realCaptureFailures(snapshotOf(source, offset), { capabilityFingerprint: FINGERPRINT }).join(' | ')

/** Run a body inside a throwaway cwd, so each store test gets its own tree. */
function inTemporaryTree(body: () => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'hpe-store-'))
  const previous = process.cwd()
  try {
    process.chdir(directory)
    mkdirSync(join(directory, 'data', 'generated', 'thermal-snapshots'), { recursive: true })
    body()
  } finally {
    process.chdir(previous)
    rmSync(directory, { recursive: true, force: true })
  }
}

/* ========================================================================== */
/* Surface vs attestation                                                     */
/* ========================================================================== */

describe('snapshots carry two independent digests', () => {
  it('hashes the surface from the values and positions only', () => {
    const a = snapshotOf()
    const b = snapshotOf({
      capture: { ...a.source.capture, capturedAtUtc: '2027-01-01T00:00:00.000Z' },
      activityIds: ['other-activity-id-000001'],
    })
    // Two captures of the same surface agree on what the numbers are.
    expect(b.surfaceSha256).toBe(a.surfaceSha256)
    // …and disagree on what the capture was.
    expect(b.attestationSha256).not.toBe(a.attestationSha256)

    expect(snapshotOf({}, 0.5).surfaceSha256).not.toBe(a.surfaceSha256)
  })

  it('covers every provenance, capability and capture field in the attestation', () => {
    const base = snapshotOf()
    const perturbations: Array<[string, Partial<ThermalSnapshotSource>]> = [
      ['provenance', { provenance: 'SYNTHETIC' }],
      ['dataMode', { dataMode: 'DEMO_SYNTHETIC' }],
      ['activityIds', { activityIds: ['forged-activity-id-1', 'forged-activity-id-2'] }],
      ['valueField', { valueField: 'temp' }],
      ['unit', { unit: 'K' }],
      ['unitConfirmed', { unitConfirmed: !base.source.unitConfirmed }],
      ['semanticsConfirmed', { semanticsConfirmed: !base.source.semanticsConfirmed }],
      ['timezoneStrategy', { timezoneStrategy: 'convert_to_utc' }],
      ['timezoneStrategyApplied', { timezoneStrategyApplied: false }],
      ['capabilityProbeRunId', { capabilityProbeRunId: 'probe-2' }],
      ['capabilityFingerprint', { capabilityFingerprint: 'a'.repeat(64) }],
      [
        'capture.capturedAtUtc',
        { capture: { ...base.source.capture, capturedAtUtc: '2030-01-01T00:00:00.000Z' } },
      ],
      [
        'capture.submissionCount',
        { capture: { ...base.source.capture, submissionCount: 99 } },
      ],
      [
        'capture.timestamps',
        {
          capture: {
            ...base.source.capture,
            timestamps: timestamps().map((entry) => ({ ...entry, transmittedTime: '23:00' })),
          },
        },
      ],
      ['notes', { notes: ['added'] }],
    ]
    for (const [label, patch] of perturbations) {
      const altered = snapshotOf(patch)
      // The numbers are untouched…
      expect(altered.surfaceSha256, label).toBe(base.surfaceSha256)
      // …but the claim is different, and the attestation says so.
      expect(altered.attestationSha256, label).not.toBe(base.attestationSha256)
    }
  })

  it('covers the rings, so a footprint cannot be edited silently', () => {
    const base = snapshotOf()
    const movedRing = JSON.parse(JSON.stringify(base)) as typeof base
    movedRing.cells[0]!.ring = [
      [-113, 34],
      [-113, 34.001],
      [-112.999, 34.001],
    ]
    // Centroid and value unchanged, so the surface hash still matches.
    expect(surfaceHash(movedRing.request, movedRing.cells)).toBe(base.surfaceSha256)
    // The attestation does not.
    expect(
      attestationHash({
        request: movedRing.request,
        source: movedRing.source,
        surfaceSha256: base.surfaceSha256,
        cells: movedRing.cells,
      }),
    ).not.toBe(base.attestationSha256)
  })

  it('refuses a file whose values were edited', () => {
    const tampered = JSON.parse(JSON.stringify(snapshotOf()))
    tampered.cells[0].value = 99
    expect(() => validateThermalSnapshot(tampered)).toThrow(/SURFACE hash mismatch/)
  })

  it('refuses a file whose provenance was edited while its values were left alone', () => {
    // This is the laundering attempt the single-hash design missed.
    const laundered = JSON.parse(JSON.stringify(snapshotOf({ dataMode: 'DEMO_SYNTHETIC' })))
    laundered.source.dataMode = 'LIVE_FORTYGUARD'
    laundered.source.provenance = 'REAL'
    expect(() => validateThermalSnapshot(laundered)).toThrow(/ATTESTATION hash mismatch/)
    expect(() => validateThermalSnapshot(laundered)).toThrow(/provenance, mode/)
  })

  it('rejects a snapshot of the wrong kind, version or shape', () => {
    expect(() => validateThermalSnapshot(null)).toThrow(ThermalSnapshotError)
    expect(() => validateThermalSnapshot({ ...snapshotOf(), kind: 'other' })).toThrow(/kind/)
    expect(() => validateThermalSnapshot({ ...snapshotOf(), version: 99 })).toThrow(/version/)
    expect(() => validateThermalSnapshot({ ...snapshotOf(), cells: [] })).toThrow(/no cells/)
  })

  it('rejects a snapshot with no capability fingerprint or no capture metadata', () => {
    const noFingerprint = JSON.parse(JSON.stringify(snapshotOf()))
    delete noFingerprint.source.capabilityFingerprint
    expect(() => validateThermalSnapshot(noFingerprint)).toThrow(/no capability fingerprint/)

    const noCapture = JSON.parse(JSON.stringify(snapshotOf()))
    delete noCapture.source.capture
    expect(() => validateThermalSnapshot(noCapture)).toThrow(/capture metadata/)
  })
})

/* ========================================================================== */
/* What may be served as real data                                            */
/* ========================================================================== */

describe('a snapshot may be served as real only when every rule holds', () => {
  it('accepts a genuine capture', () => {
    expect(failures()).toBe('')
    expect(isRealCapture(snapshotOf(), { capabilityFingerprint: FINGERPRINT })).toBe(true)
    expect(dataModeForSnapshot(snapshotOf())).toBe('CACHED_REAL_DATA')
  })

  it('rejects an empty REAL snapshot', () => {
    // The committed fake carried zero cells. Structural validation catches the
    // literal empty array; the cell floor catches the near-empty file that would
    // pass it and still support nothing.
    expect(() => validateThermalSnapshot({ ...snapshotOf(), cells: [] })).toThrow(/no cells/)

    const thin = buildThermalSnapshot({
      request: REQUEST,
      source: snapshotOf().source,
      cells: cells().slice(0, 2),
    })
    expect(
      realCaptureFailures(thin, { capabilityFingerprint: FINGERPRINT }).join(' '),
    ).toMatch(new RegExp(`${MIN_REAL_CELLS} are the minimum`))
  })

  it('rejects a synthetic snapshot relabelled as real', () => {
    expect(failures({ dataMode: 'DEMO_SYNTHETIC' })).toMatch(/not a live capture/)
    expect(failures({ provenance: 'SYNTHETIC' })).toMatch(/not REAL/)
    expect(dataModeForSnapshot(snapshotOf({ dataMode: 'DEMO_SYNTHETIC' }))).toBe('DEMO_SYNTHETIC')
  })

  it('rejects placeholder and fabricated activity metadata', () => {
    expect(failures({ activityIds: [] })).toMatch(/no FortyGuard activity ids/)
    // The exact ids from the committed fake.
    expect(failures({ activityIds: ['act-1', 'act-2'] })).toMatch(/placeholder activity ids/)
    expect(failures({ activityIds: ['test'] })).toMatch(/placeholder activity ids/)
    expect(failures({ activityIds: ['abc'] })).toMatch(/placeholder activity ids/)
  })

  it('rejects a Celsius claim the capability manifest does not support', () => {
    // The committed fake said unitConfirmed: true, unit: °C, while the manifest
    // confirmed nothing at all.
    expect(failures({ unitConfirmed: true, unit: 'K' })).toMatch(/not literally °C/)
    expect(failures({ unitConfirmed: true, unit: LITERAL_CELSIUS, semanticsConfirmed: false })).toMatch(
      /not confirmed to hold a temperature/,
    )
    expect(
      failures({ unitConfirmed: true, unit: LITERAL_CELSIUS, semanticsConfirmed: true, valueField: null }),
    ).toMatch(/without naming the field/)
  })

  it('rejects a capability fingerprint that no longer matches the manifest', () => {
    expect(failures({ capabilityFingerprint: 'b'.repeat(64) })).toMatch(
      /Re-capture; do not relabel/,
    )
  })

  it('compares the recorded answers against the manifest, not only the fingerprint', () => {
    /*
     * The fingerprint is a **copied string**. A hand-written file can carry a
     * matching one beside fields that contradict it — and because the attestation
     * hash is computed from the file's own contents, regenerating it after such an
     * edit is trivial. So the fingerprint is necessary and not sufficient, and
     * each load-bearing field is compared against the manifest directly.
     *
     * Every case below keeps the fingerprint intact and is still rejected.
     */
    expect(failures({ capabilityProbeRunId: 'probe-that-never-ran' })).toMatch(
      /names probe run probe-that-never-ran while the manifest names phoenix-three-hour-pilot-2026-08-18/,
    )
    expect(failures({ timezoneStrategy: 'convert_to_utc' })).toMatch(
      /transmitted under the convert_to_utc strategy while the manifest declares/,
    )
    expect(failures({ valueField: 'tcm' })).toMatch(
      /manifest confirms "average_temperature"/,
    )
  })

  it('requires the timezone strategy to have been applied, not merely declared', () => {
    // Previously only checked when the file claimed `true`, so a file claiming
    // `false` passed — leaving the relationship between the hours requested and
    // the hours transmitted entirely unaccounted for.
    expect(failures({ timezoneStrategyApplied: false })).toMatch(
      /nothing accounts for the relationship between the hours requested and the hours transmitted/,
    )
  })

  it('rejects a capture record inconsistent with its own request', () => {
    const base = snapshotOf().source.capture
    expect(failures({ capture: { ...base, timestamps: [base.timestamps[0]!] } })).toMatch(
      /1 transmitted timestamp\(s\) for 2 requested hour\(s\)/,
    )
    expect(failures({ capture: { ...base, submissionCount: 0 } })).toMatch(/bills at least one/)
    expect(
      failures({
        capture: {
          ...base,
          timestamps: base.timestamps.map((entry) => ({ ...entry, requestedLocalTime: '03:00' })),
        },
      }),
    ).toMatch(/records requested local hours/)
  })

  it('rejects a claimed-but-unapplied timezone strategy', () => {
    // Says it converted to UTC, transmitted the local wall clock anyway.
    expect(
      failures({
        timezoneStrategy: 'convert_to_utc',
        timezoneStrategyApplied: true,
      }),
    ).toMatch(/do not match what that strategy produces/)
  })

  it('rejects cells for hours the request never asked for', () => {
    const stray = buildThermalSnapshot({
      request: REQUEST,
      source: snapshotOf().source,
      cells: [
        ...cells(),
        { ...cells()[0]!, id: 'stray', snapshot: `${REQUEST.analysisDate}T17:00` },
      ],
    })
    expect(realCaptureFailures(stray, { capabilityFingerprint: FINGERPRINT }).join(' ')).toMatch(
      /17:00/,
    )
  })

  it('answers only the complete request, not a prefix of it', () => {
    const snapshot = snapshotOf()
    expect(snapshotAnswersRequest(snapshot, REQUEST).matches).toBe(true)
    expect(snapshotAnswersRequest(snapshot, { ...REQUEST, analysisDate: '2026-08-04' }).reason).toMatch(
      /2026-08-03/,
    )
    // Matching on area and date alone let a 100 m capture answer a 60 m request.
    expect(snapshotAnswersRequest(snapshot, { ...REQUEST, granularityMeters: 100 }).reason).toMatch(
      /granularity/,
    )
    expect(snapshotAnswersRequest(snapshot, { ...REQUEST, filterType: 2 }).reason).toMatch(
      /filter type/,
    )
    expect(snapshotAnswersRequest(snapshot, { ...REQUEST, analyticType: 'exceedance' }).reason).toMatch(
      /analytic type/,
    )
    expect(snapshotAnswersRequest(snapshot, { ...REQUEST, timezone: 'UTC' }).reason).toMatch(
      /timezone/,
    )
    expect(
      snapshotAnswersRequest(snapshot, { ...REQUEST, snapshotTimes: ['11:00', '17:00'] }).reason,
    ).toMatch(/17:00/)
  })

  it('feeds the run id from the ATTESTATION, so two claims cannot share one', () => {
    const base = { request: { a: 1 }, datasetSha256: 'd', engineVersion: '2.0.0' }
    const real = snapshotOf()
    // Identical numbers, different claim: a different run.
    const relabelled = snapshotOf({ dataMode: 'DEMO_SYNTHETIC', provenance: 'SYNTHETIC' })
    expect(relabelled.surfaceSha256).toBe(real.surfaceSha256)
    expect(deriveRunId({ ...base, thermalSha256: real.attestationSha256 })).not.toBe(
      deriveRunId({ ...base, thermalSha256: relabelled.attestationSha256 }),
    )
  })
})

/* ========================================================================== */
/* The committed fakes, kept as fixtures                                      */
/* ========================================================================== */

describe('the files that were found in the production store', () => {
  const fixtureDir = join(process.cwd(), 'tests', 'fixtures', 'thermal-snapshots')

  it('no longer sit in the production snapshot store', () => {
    expect(auditSnapshotStore()).toEqual([])
  })

  it('are still rejected on their substance, not only on their version', () => {
    const fabricated = JSON.parse(
      readFileSync(join(fixtureDir, 'INVALID_fabricated-real-empty.json'), 'utf-8'),
    )
    expect(fabricated.source.dataMode).toBe('LIVE_FORTYGUARD')
    expect(fabricated.source.provenance).toBe('REAL')
    expect(fabricated.cells).toHaveLength(0)
    expect(fabricated.source.activityIds).toEqual(['act-1', 'act-2'])
    expect(fabricated.source.unitConfirmed).toBe(true)
    expect(() => validateThermalSnapshot(fabricated)).toThrow(ThermalSnapshotError)

    const synthetic = JSON.parse(
      readFileSync(join(fixtureDir, 'INVALID_synthetic-in-production-store.json'), 'utf-8'),
    )
    expect(synthetic.source.dataMode).toBe('DEMO_SYNTHETIC')
    expect(() => validateThermalSnapshot(synthetic)).toThrow(ThermalSnapshotError)
  })
})

/* ========================================================================== */
/* The capability gate                                                        */
/* ========================================================================== */

describe('the capability probe gates the Celsius reading and the A+B product', () => {
  const base = parseCapability({
    ...SHIPPED_CAPABILITY,
    probeRunId: null,
    probedAtUtc: null,
    valueField: { ...SHIPPED_CAPABILITY.valueField, confirmed: false, name: null },
    unit: { ...SHIPPED_CAPABILITY.unit, confirmed: false, unit: null },
    semantics: { ...SHIPPED_CAPABILITY.semantics, confirmed: false, meaning: null },
    timezone: {
      ...SHIPPED_CAPABILITY.timezone,
      confirmed: false,
      interpretedAs: null,
      applied: false,
    },
  })

  it('blocks everything until field, meaning, literal unit and applied timezone are confirmed', () => {
    const unconfirmed = evaluateCapability(base)
    expect(unconfirmed.celsiusPermitted).toBe(false)
    expect(unconfirmed.realProductPermitted).toBe(false)
    expect(unconfirmed.missing).toHaveLength(4)
    expect(unconfirmed.statement).toMatch(/NOT expressed in °C/)
  })

  it('treats selecting a field, knowing what it means, and knowing its unit as three questions', () => {
    const confirmedField = { ...base.valueField, confirmed: true, name: 'tcm' }
    // A named field alone permits nothing: --temperature-field selects a
    // property, it does not establish that the property is a temperature.
    expect(
      evaluateCapability({ ...base, valueField: confirmedField } as never).celsiusPermitted,
    ).toBe(false)
    expect(
      evaluateCapability({
        ...base,
        valueField: confirmedField,
        semantics: { ...base.semantics, confirmed: true, meaning: 'surface temperature' },
      } as never).celsiusPermitted,
    ).toBe(false)
    expect(
      evaluateCapability({
        ...base,
        valueField: confirmedField,
        semantics: { ...base.semantics, confirmed: true, meaning: 'surface temperature' },
        unit: { ...base.unit, confirmed: true, unit: LITERAL_CELSIUS },
      } as never).celsiusPermitted,
    ).toBe(true)
  })

  it('requires every one of the four, never a subset', () => {
    const confirmedField = { ...base.valueField, confirmed: true, name: 'tcm' }
    const confirmedMeaning = {
      ...base.semantics,
      confirmed: true,
      meaning: 'surface temperature at the cell',
    }
    const confirmedUnit = { ...base.unit, confirmed: true, unit: LITERAL_CELSIUS }
    const confirmedZone = {
      ...base.timezone,
      confirmed: true,
      interpretedAs: 'America/Phoenix',
      applied: true,
    }

    for (const partial of [
      { valueField: confirmedField },
      { unit: confirmedUnit },
      { semantics: confirmedMeaning },
      { timezone: confirmedZone },
      { valueField: confirmedField, semantics: confirmedMeaning, unit: confirmedUnit },
    ]) {
      expect(
        evaluateCapability({ ...base, ...partial } as never).realProductPermitted,
        JSON.stringify(Object.keys(partial)),
      ).toBe(false)
    }

    // A confirmed timezone the client does NOT apply is not a confirmation that
    // helps: the product would still be sending the wrong wall clock.
    expect(
      evaluateCapability({
        ...base,
        valueField: confirmedField,
        semantics: confirmedMeaning,
        unit: confirmedUnit,
        timezone: { ...confirmedZone, applied: false },
      } as never).realProductPermitted,
    ).toBe(false)

    expect(
      evaluateCapability({
        ...base,
        valueField: confirmedField,
        semantics: confirmedMeaning,
        unit: confirmedUnit,
        timezone: confirmedZone,
      } as never).realProductPermitted,
    ).toBe(true)
  })

  it('rejects a manifest with an unknown or misspelt key rather than defaulting it', () => {
    const misspelt = JSON.parse(JSON.stringify(base))
    misspelt.valueField.confrimed = true
    expect(() => parseCapability(misspelt)).toThrow(/invalid/)

    const stringBoolean = JSON.parse(JSON.stringify(base))
    stringBoolean.unit.confirmed = 'false'
    expect(() => parseCapability(stringBoolean)).toThrow(/invalid/)
  })

  it('moves the fingerprint when any answer or endpoint identity changes', () => {
    const current = capabilityFingerprint(base)
    for (const patch of [
      { capabilityVersion: base.capabilityVersion + 1 },
      { valueField: { ...base.valueField, confirmed: true, name: 'tcm' } },
      { unit: { ...base.unit, confirmed: true, unit: LITERAL_CELSIUS } },
      { semantics: { ...base.semantics, confirmed: true, meaning: 'x' } },
      { timezone: { ...base.timezone, strategy: 'convert_to_utc' as const } },
      { endpoint: { ...base.endpoint, host: 'staging.fortyguard.com' } },
      { endpoint: { ...base.endpoint, openApiSha256: 'c'.repeat(64) } },
    ]) {
      expect(capabilityFingerprint({ ...base, ...patch } as never)).not.toBe(current)
    }
    // Rewording the prose behind a confirmation is not a change to the answer.
    expect(
      capabilityFingerprint({
        ...base,
        valueField: { ...base.valueField, evidence: 'reworded' },
      } as never),
    ).toBe(current)
  })

  it('keeps the synthetic fixture explicitly synthetic even with a confirmed API capability', async () => {
    const run = await executeRun(
      { aoiId: 'central-phoenix', capacity: 5, analysisDate: '2026-08-03' },
      { now: () => new Date('2026-08-04T12:00:00Z') },
    )
    expect(run.methodology.exposure.celsiusReadingPermitted).toBe(false)
    // The fixture keeps its own explicitly-synthetic label…
    expect(run.methodology.exposure.thermalUnitLabel).toBe('°C (synthetic)')
    // …and every derived unit string is built from it rather than hardcoded.
    expect(run.methodology.exposure.unit).toContain('°C (synthetic)')
    expect(run.methodology.exposure.loadUnitShort).toBe('°C (synthetic)·rider-min')
  }, 120_000)
})

/* ========================================================================== */
/* Credit safety                                                              */
/* ========================================================================== */

describe('live credits cannot be spent by the application', () => {
  it('ships no capture route', async () => {
    // The endpoint was deleted rather than gated: the safest credit-spending
    // endpoint is the one that is not deployed.
    const { existsSync } = await import('node:fs')
    expect(existsSync(join(process.cwd(), 'app', 'api', 'thermal'))).toBe(false)
  })

  it('offers no client seam on the run entry point', () => {
    expect(executeRun.length).toBeLessThanOrEqual(2)
  })

  it('refuses concurrent captures of the same request', () => {
    const directory = mkdtempSync(join(tmpdir(), 'hpe-capture-'))
    const previous = process.cwd()
    try {
      process.chdir(directory)
      const spec = {
        aoiId: 'central-phoenix',
        analysisDate: '2026-08-03',
        snapshotTimes: ['11:00'],
        analyticType: 'tcm' as const,
        granularityMeters: 60 as const,
        filterType: 1 as const,
        timezone: 'America/Phoenix',
        maxTileSqMi: 9,
      }
      const release = acquireCaptureLock(spec)
      // A second process would submit the same tiles and pay for them twice.
      expect(() => acquireCaptureLock(spec)).toThrow(CaptureLockedError)
      expect(() => acquireCaptureLock(spec)).toThrow(/never broken automatically/)
      release()
      // Once released, a legitimate resume can proceed.
      acquireCaptureLock(spec)()
    } finally {
      process.chdir(previous)
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('keys the checkpoint on the request, so a different request cannot resume it', () => {
    const spec = {
      aoiId: 'central-phoenix',
      analysisDate: '2026-08-03',
      snapshotTimes: ['11:00', '14:00'],
      analyticType: 'tcm' as const,
      granularityMeters: 60 as const,
      filterType: 1 as const,
      timezone: 'America/Phoenix',
      maxTileSqMi: 9,
    }
    expect(requestKey(spec)).toBe(requestKey({ ...spec, snapshotTimes: ['14:00', '11:00'] }))
    expect(requestKey(spec)).not.toBe(requestKey({ ...spec, analysisDate: '2026-08-04' }))
    expect(requestKey(spec)).not.toBe(requestKey({ ...spec, granularityMeters: 100 }))
  })

  it('refuses to run the capture CLI in a hosted environment', () => {
    const source = readFileSync(join(process.cwd(), 'scripts', 'fortyguard', 'capture.mjs'), 'utf-8')
    for (const marker of ['VERCEL', 'AWS_LAMBDA_FUNCTION_NAME', 'GITHUB_ACTIONS', 'CI']) {
      expect(source).toContain(marker)
    }
    expect(source).toMatch(/Refusing to run/)
  })

  it('spends nothing by default: the CLI dry-runs unless all three opt-ins are present', () => {
    // The CLI is the only path that will ever spend a credit, and no other check
    // executes it: verify cannot (the CLI refuses hosted environments, including
    // the CI that runs verify), so a broken loader or import would only surface
    // the day a key arrives. This spawns the real thing with the hosted markers
    // stripped, exactly as an operator would run it — and with no key, no
    // RUN_LIVE_FORTYGUARD and no budget.
    const environment = { ...process.env }
    for (const marker of [
      'VERCEL',
      'VERCEL_ENV',
      'AWS_LAMBDA_FUNCTION_NAME',
      'AWS_EXECUTION_ENV',
      'NETLIFY',
      'CF_PAGES',
      'GITHUB_ACTIONS',
      'CI',
      'FORTYGUARD_API_KEY',
      'RUN_LIVE_FORTYGUARD',
    ]) {
      delete environment[marker]
    }
    const tsxCli = createRequire(import.meta.url).resolve('tsx/cli')
    const outcome = spawnSync(
      process.execPath,
      [
        tsxCli,
        'scripts/fortyguard/capture.mjs',
        '--aoi',
        'central-phoenix',
        '--date',
        '2026-08-03',
      ],
      { cwd: process.cwd(), env: environment, encoding: 'utf-8', timeout: 120_000 },
    )
    expect(outcome.error).toBeUndefined()
    expect(outcome.stderr ?? '').toBe('')
    expect(outcome.status).toBe(0)
    expect(outcome.stdout).toContain('coverage complete')
    // The plan is printed in full: tiles, the exact bill, and the request plan.
    expect(outcome.stdout).toMatch(/submissions {3}\d+ total/)
    expect(outcome.stdout).toContain('budget        0 new submission(s) authorised')
    expect(outcome.stdout).toContain('request plan (local hour -> transmitted)')
    expect(outcome.stdout).toContain('DRY RUN - nothing was submitted')
    expect(outcome.stdout).toContain('FORTYGUARD_API_KEY is not set')
    expect(outcome.stdout).toContain('RUN_LIVE_FORTYGUARD is not 1')
    expect(outcome.stdout).toContain('--confirm-spend was not passed')
    expect(outcome.stdout).toContain('--max-new-submissions was not a positive integer')
  }, 120_000)

  it('honours --dry-run even when every opt-in is present', () => {
    /*
     * The case the previous test did not cover, and the flag did not handle.
     *
     * `--dry-run` was parsed into `args.dryRun` and then read by nothing. The
     * reasoning was that a dry run happens anyway unless every opt-in is present
     * — which is exactly backwards for a flag whose purpose is to prevent
     * spending, because the case that matters is the one where the opt-ins ARE
     * present: a line recalled from shell history, or a real capture command with
     * `--dry-run` appended to check it first. There the flag did nothing and the
     * run spent money.
     *
     * A fake key and a fake base URL are used deliberately. If the flag were
     * still ignored the run would attempt a request, and this test would fail —
     * loudly, and without reaching FortyGuard.
     */
    const environment = { ...process.env }
    for (const marker of [
      'VERCEL',
      'VERCEL_ENV',
      'AWS_LAMBDA_FUNCTION_NAME',
      'AWS_EXECUTION_ENV',
      'NETLIFY',
      'CF_PAGES',
      'GITHUB_ACTIONS',
      'CI',
    ]) {
      delete environment[marker]
    }
    // `your_` prefix deliberately: `scripts/scan-secrets.mjs` treats it as a
    // placeholder, and it is right to flag any other 12-plus-character value
    // assigned to this name. Using its documented convention keeps the rule
    // intact rather than allowlisting this file out of the scan.
    environment.FORTYGUARD_API_KEY = 'your_key_placeholder_never_sent'
    environment.RUN_LIVE_FORTYGUARD = '1'
    environment.FORTYGUARD_API_BASE_URL = 'https://127.0.0.1:1'

    const tsxCli = createRequire(import.meta.url).resolve('tsx/cli')
    const outcome = spawnSync(
      process.execPath,
      [
        tsxCli,
        'scripts/fortyguard/capture.mjs',
        '--aoi',
        'central-phoenix',
        '--date',
        '2026-08-03',
        '--confirm-spend',
        '--max-new-submissions',
        '99',
        '--dry-run',
      ],
      { cwd: process.cwd(), env: environment, encoding: 'utf-8', timeout: 120_000 },
    )
    expect(outcome.error).toBeUndefined()
    expect(outcome.status).toBe(0)
    expect(outcome.stdout).toContain('--dry-run: nothing was submitted')
    // It must not have reached the opt-in evaluation, and certainly not a socket.
    expect(outcome.stdout).not.toContain('submit ')
    expect(outcome.stderr ?? '').toBe('')
  }, 120_000)

  it('keeps the Python probe out of the submission business entirely', () => {
    const probe = readFileSync(
      join(process.cwd(), 'scripts', 'fortyguard', 'run_fortyguard_probe.py'),
      'utf-8',
    )
    // No independent POST implementation may survive here: one submission path,
    // and it is the local capture CLI.
    expect(probe).not.toMatch(/"POST"/)
    expect(probe).not.toMatch(/urlopen|urllib\.request\.Request|http\.client|requests\.post/)
    expect(probe).toContain('performs no submission')
  })
})

/* ========================================================================== */
/* Snapshot store: atomic, non-overwriting, content-addressed, unambiguous     */
/* ========================================================================== */

describe('the snapshot store', () => {
  it('names files by their attestation digest', () => {
    const snapshot = snapshotOf()
    const name = snapshotFileName(
      snapshot.request.aoiId,
      snapshot.request.analysisDate,
      snapshot.attestationSha256,
    )
    expect(name).toContain(snapshot.attestationSha256.slice(0, 16))
    // Two captures of the same area and date are two files, not one clobbering
    // the other.
    expect(name).not.toBe(
      snapshotFileName(
        snapshot.request.aoiId,
        snapshot.request.analysisDate,
        snapshotOf({}, 1).attestationSha256,
      ),
    )
  })

  it('refuses to overwrite a different capture, and is a no-op for an identical one', () => {
    inTemporaryTree(() => {
      const snapshot = snapshotOf()
      const first = writeThermalSnapshot(snapshot, { capabilityFingerprint: FINGERPRINT })
      expect(first.alreadyPresent).toBe(false)

      // Writing the same content again changes nothing.
      expect(
        writeThermalSnapshot(snapshot, { capabilityFingerprint: FINGERPRINT }).alreadyPresent,
      ).toBe(true)

      // Corrupt the file under its own name: the store must refuse to replace it.
      writeFileSync(first.path, `${JSON.stringify({ ...snapshot, cells: [] }, null, 2)}\n`, 'utf-8')
      expect(() => writeThermalSnapshot(snapshot, { capabilityFingerprint: FINGERPRINT })).toThrow(
        /Refusing to overwrite/,
      )

      // And a corrupt file is refused on load rather than served.
      expect(() => loadThermalSnapshot(REQUEST, { capabilityFingerprint: FINGERPRINT })).toThrow()
    })
  })

  it('will not write anything but a real capture into the production store', () => {
    inTemporaryTree(() => {
      const synthetic = snapshotOf({ dataMode: 'DEMO_SYNTHETIC', provenance: 'SYNTHETIC' })
      expect(() => writeThermalSnapshot(synthetic, { capabilityFingerprint: FINGERPRINT })).toThrow(
        /real captures only/,
      )
    })
  })

  it('does not serve a synthetic or fabricated file, and says why', () => {
    inTemporaryTree(() => {
      const store = join(process.cwd(), 'data', 'generated', 'thermal-snapshots')
      const fabricated = snapshotOf({ activityIds: ['act-1', 'act-2'] })
      writeFileSync(
        join(store, snapshotFileName('central-phoenix', '2026-08-03', fabricated.attestationSha256)),
        `${JSON.stringify(fabricated, null, 2)}\n`,
        'utf-8',
      )

      const lookup = loadThermalSnapshot(REQUEST, { capabilityFingerprint: FINGERPRINT })
      expect(lookup.snapshot).toBeNull()
      expect(lookup.rejected).toHaveLength(1)
      expect(lookup.rejected[0]!.reasons.join(' ')).toMatch(/placeholder activity ids/)
    })
  })

  it('does not depend on filename order, and refuses an ambiguous match', () => {
    inTemporaryTree(() => {
      const store = join(process.cwd(), 'data', 'generated', 'thermal-snapshots')
      // Two valid real captures of the same request, differing only in their
      // numbers. Sorting filenames and taking the first would make the served
      // measurement a function of a hex digest.
      const a = snapshotOf({}, 0)
      const b = snapshotOf({}, 3)
      for (const snapshot of [a, b]) {
        writeFileSync(
          join(
            store,
            snapshotFileName('central-phoenix', '2026-08-03', snapshot.attestationSha256),
          ),
          `${JSON.stringify(snapshot, null, 2)}\n`,
          'utf-8',
        )
      }

      expect(() => loadThermalSnapshot(REQUEST, { capabilityFingerprint: FINGERPRINT })).toThrow(
        AmbiguousSnapshotError,
      )
      expect(() => loadThermalSnapshot(REQUEST, { capabilityFingerprint: FINGERPRINT })).toThrow(
        /Refusing to choose between two/,
      )

      // Both files are individually valid, so a per-file audit would pass them.
      // Ambiguity is a property of the store, and CI has to catch it there
      // rather than at request time.
      const problems = auditSnapshotStore({ capabilityFingerprint: FINGERPRINT })
      expect(problems).toHaveLength(2)
      expect(problems[0]!.reasons.join(' ')).toMatch(/A request for any shared/)
    })
  })

  it('catches an overlapping hour set, not only an identical request', () => {
    /*
     * A lookup matches a snapshot covering a SUPERSET of the requested hours, so
     * grouping the CI audit on the whole request — hours included — missed the
     * case that actually collides: a file for [11:00, 14:00, 17:00] and a file
     * for [11:00, 14:00] are different requests by that grouping, and both answer
     * a request for [11:00, 14:00]. The store check is about overlap.
     */
    inTemporaryTree(() => {
      const store = join(process.cwd(), 'data', 'generated', 'thermal-snapshots')
      const twoHours = snapshotOf()
      const threeHours = buildThermalSnapshot({
        request: { ...REQUEST, snapshotTimes: ['11:00', '14:00', '17:00'] },
        source: {
          ...snapshotOf().source,
          // Three hours means three billed submissions and three ids: the counts
          // are cross-checked, so an inconsistent fixture would be rejected
          // before the overlap check ever saw it.
          activityIds: [
            '9f3c1a77-2b40-4d8e-9c11-6a0f5d2e8b31',
            '2c8e5b10-77af-4d31-b0c9-1e4a6f93dd22',
            '7b1d0e44-93c2-4a05-8de6-33f0b7c1a9e8',
          ],
          capture: {
            ...snapshotOf().source.capture,
            submissionCount: 3,
            timestamps: ['11:00', '14:00', '17:00'].map((time) => ({
              requestedLocalDate: REQUEST.analysisDate,
              requestedLocalTime: time,
              requestedLocalIso: `${REQUEST.analysisDate}T${time}:00-07:00`,
              transmittedDate: REQUEST.analysisDate,
              transmittedTime: time,
              transmittedIsoUtc: `${REQUEST.analysisDate}T${Number(time.slice(0, 2)) + 7}:00:00.000Z`,
            })),
          },
        },
        cells: [
          ...cells(),
          ...cells().slice(0, 5).map((cell) => ({
            ...cell,
            id: `${cell.id}-17`,
            snapshot: `${REQUEST.analysisDate}T17:00`,
          })),
        ],
      })

      for (const snapshot of [twoHours, threeHours]) {
        writeFileSync(
          join(
            store,
            snapshotFileName('central-phoenix', '2026-08-03', snapshot.attestationSha256),
          ),
          `${JSON.stringify(snapshot, null, 2)}\n`,
          'utf-8',
        )
      }

      const problems = auditSnapshotStore({ capabilityFingerprint: FINGERPRINT })
      expect(problems).toHaveLength(2)
      expect(problems[0]!.reasons.join(' ')).toMatch(/A request for any shared\s+hour/)

      // …and the lookup that would have had to choose refuses, as before.
      expect(() => loadThermalSnapshot(REQUEST, { capabilityFingerprint: FINGERPRINT })).toThrow(
        AmbiguousSnapshotError,
      )
    })
  })

  it('serves the one file that answers the request, whatever else is committed', () => {
    inTemporaryTree(() => {
      const store = join(process.cwd(), 'data', 'generated', 'thermal-snapshots')
      const wanted = snapshotOf()
      const other = buildThermalSnapshot({
        request: { ...REQUEST, analysisDate: '2026-08-04' },
        source: {
          ...snapshotOf().source,
          capture: {
            ...snapshotOf().source.capture,
            timestamps: timestamps().map((entry) => ({
              ...entry,
              requestedLocalDate: '2026-08-04',
              transmittedDate: '2026-08-04',
            })),
          },
        },
        cells: cells().map((cell) => ({
          ...cell,
          snapshot: cell.snapshot.replace('2026-08-03', '2026-08-04'),
        })),
      })
      for (const snapshot of [wanted, other]) {
        writeFileSync(
          join(
            store,
            snapshotFileName(
              snapshot.request.aoiId,
              snapshot.request.analysisDate,
              snapshot.attestationSha256,
            ),
          ),
          `${JSON.stringify(snapshot, null, 2)}\n`,
          'utf-8',
        )
      }

      const lookup = loadThermalSnapshot(REQUEST, { capabilityFingerprint: FINGERPRINT })
      expect(lookup.snapshot?.attestationSha256).toBe(wanted.attestationSha256)
    })
  })

  it('reports every invalid file in the store rather than skipping it', () => {
    inTemporaryTree(() => {
      const store = join(process.cwd(), 'data', 'generated', 'thermal-snapshots')
      const synthetic = snapshotOf({ dataMode: 'DEMO_SYNTHETIC', provenance: 'SYNTHETIC' })
      writeFileSync(
        join(store, 'central-phoenix_2026-08-03_synthetic.json'),
        `${JSON.stringify(synthetic, null, 2)}\n`,
        'utf-8',
      )
      writeFileSync(join(store, 'broken.json'), '{ not json', 'utf-8')

      const problems = auditSnapshotStore({ capabilityFingerprint: FINGERPRINT })
      expect(problems).toHaveLength(2)
      expect(problems.flatMap((problem) => problem.reasons).join(' ')).toMatch(/not valid JSON/)
      expect(problems.flatMap((problem) => problem.reasons).join(' ')).toMatch(/not a live capture/)
    })
  })
})

/* ========================================================================== */
/* Export binding                                                             */
/* ========================================================================== */

describe('export is bound to the run it attests to', () => {
  it('records a named self-attestation, never an approval', async () => {
    const run = await executeRun(
      { aoiId: 'central-phoenix', capacity: 5, analysisDate: '2026-08-03' },
      { now: () => new Date('2026-08-04T12:00:00Z') },
    )
    const finalized = finalizeRun(run, { attestedBy: 'A Reviewer' })

    expect(finalized.attestation?.kind).toBe('named_self_attestation')
    expect(finalized.attestation?.attestedBy).toBe('A Reviewer')
    // Bound to the exact run.
    expect(finalized.attestation?.runId).toBe(run.runId)
    expect(finalized.attestation?.caveat).toMatch(/no authentication/i)

    const approved = finalized.audit.find((event) => event.step === 'approved')!
    expect(approved.outputSummary).toMatch(/Self-attested/)
    expect(approved.decision).toMatch(/NAMED SELF-ATTESTATION/)
    expect(approved.decision).toMatch(/not an authenticated approval/)
    expect(approved.decision).toContain(run.runId)
  }, 120_000)
})
