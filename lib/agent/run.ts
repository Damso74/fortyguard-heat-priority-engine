import type {
  ConfidenceBand,
  RunRequest,
  RunResult,
  StopResult,
  ThermalCell,
  ThermalLayer,
  TransitStop,
} from '@/lib/types'
import { RIDERSHIP_CATEGORY_FOR_DAY_TYPE } from '@/lib/types'
import { AuditLog, appendAuditEvent, auditHash, deriveRunId } from '@/lib/audit/log'
import { getAoi } from '@/lib/geo/aoi'
import { planTiles } from '@/lib/geo/tiles'
import { bboxContains } from '@/lib/geo/measure'
import { buildDemoThermalLayer, buildDemoThermalSnapshot } from '@/lib/fortyguard/demo-fixture'
import {
  attestationHash,
  dataModeForSnapshot,
  surfaceHash,
  type ThermalSnapshotRequest,
} from '@/lib/fortyguard/snapshot'
import { loadThermalSnapshot } from '@/lib/fortyguard/snapshot-store'
import {
  LITERAL_CELSIUS,
  capabilityFingerprint,
  capabilityStatement,
  evaluateCapability,
  loadCapability,
} from '@/lib/fortyguard/capability'
import { evaluateThermalGate } from '@/lib/gates/thermal-gate'
import { buildProductManifest } from '@/lib/gates/product-mode'
import {
  DEFAULT_ANOMALY_PARAMETERS,
  MIN_SNAPSHOTS_FOR_STOP_ANOMALY,
  attachAnomaliesToStops,
  computeSnapshotAnomalies,
  validateAnomalies,
  type CellAnomaly,
} from '@/lib/metrics/anomaly'
import {
  BASE_SCENARIO,
  DRIFT_QUARTERS,
  precedingDayType,
  REFERENCE_TEMPERATURES_C,
  SCENARIO_DIMENSIONS,
  buildStopScenarioTable,
  computeStopExposure,
  enumerateScenarios,
  exposureForScenario,
  scenarioEnvelope,
  scenariosAvailableFor,
  type StopScenarioTable,
} from '@/lib/metrics/exposure'
import { DEMAND_PROFILES } from '@/lib/metrics/demand'
import { ROUTE_CHOICE_MODELS, WAIT_CAP_RULE, WAIT_CAP_SCENARIOS } from '@/lib/metrics/waiting'
import { DEFAULT_MIN_SEPARATION_METERS, selectUnderCapacity } from '@/lib/metrics/selection'
import { round } from '@/lib/metrics/stats'
import { loadDatasetManifest, loadStopDataset, stopLayerAgeDays } from '@/lib/data/stops'
import { serverEnv, type ServerEnv } from '@/lib/config/server-env'
import {
  ANALYSIS_TIMEZONE,
  RunRequestSchema,
  TIMEZONE_ASSUMPTION,
  checkAnalysisWindow,
  dayTypeForDate,
  precedingDayTypeForDate,
  previousCivilDate,
} from './request'

/**
 * The orchestration entry point.
 *
 * Deterministic by construction: the same request, dataset and thermal source
 * return the same ranking and the same run id. No language model participates
 * anywhere; the "agent" is this pipeline.
 *
 * The product's thesis, and what this function computes:
 *
 *   Find where Phoenix transit riders would accumulate the greatest estimated
 *   heat exposure — and where FortyGuard reveals heat that is unusually severe
 *   for the surrounding area.
 *
 * Those are two questions, so they get two metrics, reported separately and
 * never blended into a weighted score.
 */

export const ENGINE_VERSION = '2.0.0'

export interface ExecuteOptions {
  now?: () => Date
  env?: ServerEnv
  /**
   * Supply the thermal layer directly, bypassing snapshot lookup.
   *
   * A test seam only. There is no client option any more: `executeRun` cannot
   * reach the FortyGuard API by any path, so no caller can cause a page render
   * to spend a credit.
   */
  thermalLayer?: ThermalLayer
}

const EXPOSURE_ASSUMPTIONS = [
  {
    id: 'A1',
    text:
      'Daily ridership is allocated across the 24 clock hours by a profile that sums to 1 and is ' +
      'zero wherever no service runs, so Σ riders(h) equals the published daily total exactly. ' +
      'The shape of that profile is unobserved and is a scenario dimension.',
    falsifiedBy: 'Automatic passenger counter data by hour.',
    scenarioDimension: 'demandProfile',
  },
  {
    id: 'A2',
    text: 'The published ridership figure counts riders who wait at the stop.',
    falsifiedBy:
      'A data dictionary. If the figure includes alightings, every exposure value is an over-estimate. ' +
      'This assumption is NOT in the scenario envelope — it cannot be bracketed without the answer.',
    scenarioDimension: null,
  },
  {
    id: 'A3',
    text:
      'Passengers arrive uniformly over the analysed hour, so expected wait is the mean of the ' +
      'time-to-next-departure over that hour — not mean-headway/2. Each scheduled gap is clipped ' +
      'to the hour before it is weighted, because only the part of a gap inside the hour can be ' +
      'arrived in; the closed form Σgap²/(2·Σgap) is recovered only when the gaps tile the hour.',
    falsifiedBy: 'Observed passenger arrival distributions, or real-time rather than scheduled gaps.',
    scenarioDimension: null,
  },
  {
    id: 'A4',
    text:
      'Which departures a rider will board is unobserved. The envelope brackets it: routes ' +
      'interchangeable (union timetable) at one end, committed to the least frequent route at the ' +
      'other. A frequency-share weighting is offered as a scenario and is labelled unsourced ' +
      'wherever it appears; it is never presented as observed.',
    falsifiedBy: 'Route-level boarding counts at the stop.',
    scenarioDimension: 'routeChoice',
  },
  {
    id: 'A5',
    text:
      'A cap models riders timing their arrival for infrequent service, and is applied as a ' +
      'truncation of EACH rider’s own wait before averaging — E[min(W, c)], not min(E[W], c). ' +
      'The reported figure therefore sits below the cap wherever some arrivals in the hour wait ' +
      'less than it. Each cap, including no cap, is an explicit scenario. The base applies the ' +
      'LONGEST cap (15 min): running uncapped would apply the uniform-arrival assumption exactly ' +
      'where A3 is documented to fail, which puts three stops with mean expected waits over an ' +
      'hour into the plan, one of them eleven hours long at rank 4.',
    falsifiedBy: 'Observed waits at low-frequency stops.',
    scenarioDimension: 'waitCap',
  },
  {
    id: 'A6',
    text:
      'Heat is counted above a reference temperature. The default of 30 °C is FortyGuard’s ' +
      'documented API default for the exceedance and persistence analytics — an API convention, ' +
      'NOT a health or heat-stress threshold. No source used here publishes one.',
    falsifiedBy: 'A published transit-specific heat-stress threshold.',
    scenarioDimension: 'referenceTemperatureC',
  },
  {
    id: 'A7',
    text:
      'The ridership period (FY2024 Q4, Apr–Jun 2024) does not match the GTFS schedule (July 2026) ' +
      'or the thermal analysis date. Drift is modelled by recomputing on the neighbouring ' +
      'published quarters, which is sourced; a uniform multiplier would be useless because it ' +
      'cannot change a ranking.',
    falsifiedBy: 'A ridership quarter contemporaneous with the schedule and the thermal date.',
    scenarioDimension: 'ridershipQuarter',
  },
  {
    id: 'A8',
    text:
      'The published ridership splits Weekday from Weekend but not Saturday from Sunday, so the ' +
      'single Weekend average is applied to each weekend day. The TIMETABLES are not shared: ' +
      'Saturday and Sunday are extracted separately and run 5,476 and 4,815 trips against a ' +
      'weekday’s 7,854. Weekend ridership is never paired with a weekday schedule.',
    falsifiedBy: 'Ridership published separately for Saturday and Sunday.',
    scenarioDimension: null,
  },
  {
    id: 'A9',
    text:
      'GTFS times of 24:00 and later belong to the analysed service day and are stored unwrapped. ' +
      'Projecting them onto clock hours assumes the PRECEDING service day ran the same ' +
      'timetable, so its post-midnight departures stand in for this clock day’s small hours. ' +
      'True for a steady-state weekday or weekend; false across a service change or either side ' +
      'of a holiday.',
    falsifiedBy: 'Analysing a specific dated service rather than a modal one.',
    scenarioDimension: null,
  },
] as const

function hourOf(snapshot: string): number {
  const time = snapshot.split('T')[1] ?? '00:00'
  return Number(time.split(':')[0] ?? '0')
}

interface ResolvedThermal {
  layer: ThermalLayer
  /**
   * Digest of the whole claim this layer makes about itself. Feeds the run id.
   *
   * The **attestation**, not the surface. Two files whose numbers agree while one
   * says `LIVE_FORTYGUARD / REAL / °C` and the other says `DEMO_SYNTHETIC` are two
   * different runs, and an export naming one must not verify against the other.
   */
  attestationSha256: string
  /** The numbers alone, reported so a re-capture of the same surface is visible. */
  surfaceSha256: string
  source: 'snapshot' | 'fixture'
  unitConfirmed: boolean
  semanticsConfirmed: boolean
  /** What DATA_MODE actually resolved to, which `auto` alone does not say. */
  resolvedDataMode: 'cached_real' | 'demo'
  /** Files that exist but cannot be served, and why. Reported, never silent. */
  rejectedSnapshots: Array<{ path: string; reasons: string[] }>
  inputSummary: string
  decision: string
  sourceModule: string
}

/**
 * Where this run's temperatures come from.
 *
 * Two sources, and **neither touches the network**:
 *
 * 1. a committed immutable snapshot for this area and date, when one exists and
 *    `DATA_MODE` permits it;
 * 2. the labelled synthetic fixture.
 *
 * `DATA_MODE=cached_real` makes the snapshot mandatory: if none is committed the
 * run fails rather than quietly substituting the fixture, because a deployment
 * that asked for real data and silently served synthetic data is the exact
 * failure this whole module exists to prevent.
 *
 * A snapshot's own recorded provenance decides the resulting data mode. A
 * snapshot captured from the fixture stays `DEMO_SYNTHETIC` — persisting
 * synthetic numbers does not make them a measurement.
 */
function resolveThermalLayer(input: {
  aoi: ReturnType<typeof getAoi>
  request: RunRequest
  env: ServerEnv
  now: () => Date
  override?: ThermalLayer
}): ResolvedThermal {
  const { aoi, request, env, override } = input

  const snapshotRequest: ThermalSnapshotRequest = {
    aoiId: aoi.id,
    analysisDate: request.analysisDate,
    snapshotTimes: [...request.snapshotTimes],
    analyticType: 'tcm',
    granularityMeters: aoi.thermalGranularityMeters,
    filterType: 1,
    timezone: ANALYSIS_TIMEZONE,
  }

  const fixture = (layer: ThermalLayer, reason: string, module: string): ResolvedThermal => {
    const snapshot = buildDemoThermalSnapshot({
      aoi,
      request: { ...snapshotRequest, granularityMeters: layer.granularityMeters ?? 100 },
      layer,
    })
    return {
      layer,
      attestationSha256: snapshot.attestationSha256,
      surfaceSha256: snapshot.surfaceSha256,
      source: 'fixture',
      unitConfirmed: false,
      semanticsConfirmed: false,
      resolvedDataMode: 'demo',
      rejectedSnapshots: [],
      inputSummary: reason,
      decision:
        'No API request was made and none can be from this path. The run continues on a labelled ' +
        'synthetic fixture, and every number derived from it is marked DEMO — SYNTHETIC.',
      sourceModule: module,
    }
  }

  if (override) {
    // Test seam. The digest still covers the claim rather than the numbers alone,
    // so a test layer cannot collide with a real capture of the same surface.
    const surface = surfaceHash(snapshotRequest, override.cells)
    return {
      layer: override,
      surfaceSha256: surface,
      attestationSha256: attestationHash({
        request: snapshotRequest,
        source: {
          dataMode: override.dataMode === 'CACHED_REAL_DATA' ? 'LIVE_FORTYGUARD' : 'DEMO_SYNTHETIC',
          provenance: override.provenance,
          activityIds: [],
          valueField: override.valueField,
          unit: override.unit,
          unitConfirmed: false,
          semanticsConfirmed: false,
          timezoneStrategy: 'send_local_wallclock_unconverted',
          timezoneStrategyApplied: false,
          capabilityProbeRunId: null,
          capabilityFingerprint: 'caller-supplied',
          capture: {
            capturedAtUtc: `${request.analysisDate}T00:00:00.000Z`,
            captureToolVersion: 'lib/agent/run.ts#thermalLayer',
            tileCount: 0,
            submissionCount: 0,
            timestamps: [],
          },
          notes: [],
        },
        surfaceSha256: surface,
        cells: override.cells,
      }),
      source: 'fixture',
      unitConfirmed: false,
      semanticsConfirmed: false,
      resolvedDataMode: 'demo',
      rejectedSnapshots: [],
      inputSummary: 'Thermal layer supplied directly by the caller (test seam).',
      decision: 'No API request was made.',
      sourceModule: 'lib/agent/run.ts',
    }
  }

  const wantSnapshot = env.DATA_MODE === 'cached_real' || env.DATA_MODE === 'auto'
  let lookupReason = 'DATA_MODE=demo: the committed snapshot store was not consulted.'
  let rejected: Array<{ path: string; reasons: string[] }> = []

  if (wantSnapshot) {
    // A corrupt snapshot, or two that answer the same request, throw out of here
    // rather than falling back: replacing real numbers with synthetic ones
    // without saying so is worse than failing, and choosing arbitrarily between
    // two measurements is worse than both.
    const lookup = loadThermalSnapshot(snapshotRequest, {
      capabilityFingerprint: capabilityFingerprint(),
    })
    rejected = lookup.rejected
    if (lookup.snapshot) {
      const snapshot = lookup.snapshot
      const wanted = new Set(request.snapshotTimes)
      const cells = snapshot.cells.filter((cell) => wanted.has(cell.snapshot.split('T')[1] ?? ''))
      const dataMode = dataModeForSnapshot(snapshot)
      return {
        layer: {
          dataMode,
          provenance: snapshot.source.provenance,
          unit: snapshot.source.unitConfirmed ? snapshot.source.unit : null,
          valueField: snapshot.source.valueField,
          analyticType: snapshot.request.analyticType,
          granularityMeters: snapshot.request.granularityMeters,
          snapshots: [...new Set(cells.map((cell) => cell.snapshot))].sort(),
          timezone: snapshot.request.timezone,
          cells,
          label: 'CACHED REAL DATA',
          sourceNotes: [
            `Served from an immutable snapshot captured ${snapshot.source.capture.capturedAtUtc}.`,
            `Activity ids: ${snapshot.source.activityIds.join(', ')}.`,
            `Requested local hours transmitted as: ${snapshot.source.capture.timestamps
              .map(
                (entry) =>
                  `${entry.requestedLocalTime} → ${entry.transmittedDate} ${entry.transmittedTime}`,
              )
              .join('; ')} under the ${snapshot.source.timezoneStrategy} strategy.`,
            `Capability fingerprint ${snapshot.source.capabilityFingerprint.slice(0, 16)}…, re-checked against the current manifest on load.`,
            `Surface SHA-256 ${snapshot.surfaceSha256}; attestation ${snapshot.attestationSha256}. Both re-verified on load.`,
            ...snapshot.source.notes,
          ],
        },
        attestationSha256: snapshot.attestationSha256,
        surfaceSha256: snapshot.surfaceSha256,
        source: 'snapshot',
        unitConfirmed: snapshot.source.unitConfirmed,
        semanticsConfirmed: snapshot.source.semanticsConfirmed,
        resolvedDataMode: 'cached_real',
        rejectedSnapshots: rejected,
        inputSummary: `Immutable snapshot ${snapshot.attestationSha256.slice(0, 12)}… for ${aoi.id} on ${request.analysisDate}`,
        decision:
          'No API request was made. The snapshot was read from disk, both digests re-verified, ' +
          'its capability fingerprint matched against the current manifest, and it was the only ' +
          'file answering this request; the same file will be attested and exported.',
        sourceModule: 'lib/fortyguard/snapshot-store.ts',
      }
    }
    lookupReason = lookup.reason ?? 'No committed snapshot.'
    if (rejected.length > 0) {
      lookupReason += ` Rejected: ${rejected
        .map((entry) => `${entry.path.split(/[\\/]/).pop()} (${entry.reasons[0]})`)
        .join('; ')}`
    }
  }

  if (env.DATA_MODE === 'cached_real') {
    throw new Error(
      `DATA_MODE=cached_real requires exactly one committed, valid thermal snapshot. ${lookupReason} ` +
        'Capture one with `npm run fortyguard:capture` and commit it, or set DATA_MODE=demo to ' +
        'run on the labelled fixture. Falling back silently is not offered.',
    )
  }

  const resolved = fixture(
    buildDemoThermalLayer({
      aoi,
      snapshotTimes: [...request.snapshotTimes],
      analysisDate: request.analysisDate,
      timezone: ANALYSIS_TIMEZONE,
    }),
    lookupReason,
    'lib/fortyguard/demo-fixture.ts',
  )
  return { ...resolved, rejectedSnapshots: rejected }
}

/**
 * Congruence tolerance for cell footprints, in degrees. ~10 cm at this latitude.
 *
 * A gridded thermal product returns the same rectangle translated across a
 * lattice, and the only thing separating those 10,212 rectangles from one shared
 * shape is that each centroid was rounded independently. Snapping them to a
 * single template — **when they are already congruent to within 10 cm** — lets
 * the interactive payload carry one footprint instead of 10,212 copies of it.
 *
 * The normalisation happens in the engine, once, so the run object, the screen
 * and the export all carry the same geometry. Doing it at the transport layer
 * instead would let the map draw one polygon while the export recorded another.
 */
const RING_CONGRUENCE_DEGREES = 1e-6

type HeatCell = RunResult['heatCells'][number]

function normaliseCellGeometry(cells: HeatCell[]): HeatCell[] {
  const first = cells[0]
  if (!first || first.ring.length === 0) return cells

  const template = first.ring.map(
    ([lon, lat]) => [round(lon - first.lon, 7), round(lat - first.lat, 7)] as [number, number],
  )
  const congruent = cells.every(
    (cell) =>
      cell.ring.length === template.length &&
      cell.ring.every(
        ([lon, lat], index) =>
          Math.abs(lon - cell.lon - template[index]![0]) < RING_CONGRUENCE_DEGREES &&
          Math.abs(lat - cell.lat - template[index]![1]) < RING_CONGRUENCE_DEGREES,
      ),
  )
  // Not a lattice — an irregular footprint keeps its own ring, verbatim.
  if (!congruent) return cells

  return cells.map((cell) => ({
    ...cell,
    ring: template.map(
      ([lon, lat]) => [round(cell.lon + lon, 7), round(cell.lat + lat, 7)] as [number, number],
    ),
  }))
}

function bandFor(score: number): ConfidenceBand {
  if (score >= 75) return 'high'
  if (score >= 50) return 'medium'
  if (score > 0) return 'low'
  return 'unknown'
}

function limitationsFor(
  layer: ThermalLayer,
  validation: {
    verdict: string
    scope: string
    sufficientHoldouts: boolean
    holdoutCount: number
    minimumHoldouts: number
  },
  analysisDate: string,
  dayType: string,
  thermal: {
    stopsWithPartialCoverage: number
    stopsTotal: number
    dayTypeMatchesDate: boolean
    dateDayType: string
    capability: { realProductPermitted: boolean; statement: string }
  },
): string[] {
  const limitations = [
    'Shelter presence is unknown for every stop. No null or zero amenity field is read as "no shelter".',
    'The estimated scenario exposure load is a modelled quantity conditional on five unobserved settings. It is not a measurement of exposure, and no rider was counted at any stop in any hour: riders(h) is a published quarterly average pushed through an unobserved hourly profile.',
    'Ridership is a quarterly average of daily riders for FY2024 Q4 (Apr–Jun 2024) — the latest quarter passing this project’s own completeness checks, which no independent source reconciles. The source does not say whether it counts boardings only or boardings plus alightings; if alightings are included, every exposure value is an over-estimate.',
    'Waiting time is an expectation over arrivals uniform on each analysed hour, with scheduled gaps clipped to that hour. Where a cap applies it truncates each rider’s own wait before averaging — E[min(W, c)], not min(E[W], c) — so the reported wait can sit below the cap.',
    `The ridership period (Apr–Jun 2024) does not match the GTFS schedule (July 2026) or the thermal date (${analysisDate}). This is modelled as the temporal-drift scenario dimension, not corrected away.`,
    'The hourly shape of demand is unobserved. Three materially different profiles are carried in the scenario envelope; none is a measurement.',
    'Which route a rider will board is unobserved. The envelope brackets it; the frequency-share weighting is unsourced and is never presented as observed.',
    `Waiting time is computed from the scheduled ${dayType} timetable — the timetable of the day being analysed, never a weekday schedule standing in for a weekend one. Cancellations, detours, bunching and real-time deviation are not represented.`,
    'The service pattern for each day type is the most frequent active-service set across the dates of that day type in the feed. It is derived, not published as representative.',
    'GTFS departures at 24:00 and later are stored unwrapped and projected onto clock hours under a repeating-service-day assumption (A9), which fails across a service change or a holiday.',
    'The 30 °C reference is FortyGuard’s documented API default for its exceedance and persistence analytics. It is NOT a health or heat-stress threshold.',
    'The scenario exposure load covers only the analysed hours. It is not a daily total.',
    'The reported spread is a scenario envelope over stated assumptions, not a confidence interval.',
    'Only the robust selections hold under every stated assumption. An assumption-dependent candidate is in the plan because of a setting nobody has observed, and is reported with its selection frequency and rank range so that can be weighed rather than taken on trust.',
    'A selected stop is a place to study first, not a place where an intervention has been justified.',
    `Snapshot times are interpreted as ${ANALYSIS_TIMEZONE} wall-clock. ${TIMEZONE_ASSUMPTION}`,
  ]
  if (!thermal.dayTypeMatchesDate) {
    limitations.unshift(
      `COUNTERFACTUAL RUN: ${analysisDate} is a ${thermal.dateDayType}, but the ${dayType} ` +
        'timetable was analysed. The waits are a real timetable and the temperatures are a real ' +
        'date, but they never occurred together, so this is a scenario rather than a description ' +
        `of that ${dayType}.`,
    )
  }
  if (!validation.sufficientHoldouts) {
    limitations.push(
      `The anomaly was validated against ${validation.holdoutCount} held-out snapshot(s); ` +
        `${validation.minimumHoldouts} are required before the anomaly axis is claimed. Two ` +
        'readings agreeing once is what a slow-moving surface produces whether or not the ' +
        'anomaly is a real feature of the ground.',
    )
  }
  limitations.push(thermal.capability.statement)
  if (thermal.stopsWithPartialCoverage > 0) {
    limitations.push(
      `${thermal.stopsWithPartialCoverage} of ${thermal.stopsTotal} stops received a temperature ` +
        'for some analysed hours but not all. They report no scenario exposure load at all rather ' +
        'than a partial sum, because a partial sum is smaller for a reason that looks exactly ' +
        'like a cooler or quieter stop.',
    )
  }
  if (layer.dataMode === 'DEMO_SYNTHETIC') {
    limitations.unshift(
      'THE THERMAL LAYER ON THIS RUN IS SYNTHETIC. No FortyGuard measurement produced any number here.',
    )
  }
  if (validation.scope === 'synthetic_fixture') {
    limitations.push(
      `The anomaly validation ran against the synthetic fixture and returned ${validation.verdict}. That is an estimator self-check. NO Phoenix anomaly has been validated by this run.`,
    )
  } else if (validation.verdict !== 'PERSISTENT') {
    limitations.push(
      `The local heat anomaly did not validate as persistent out of sample (${validation.verdict}); treat the anomaly axis as indicative only.`,
    )
  }
  return limitations
}

export async function executeRun(
  rawRequest: unknown,
  options: ExecuteOptions = {},
): Promise<RunResult> {
  const now = options.now ?? (() => new Date())
  const env = options.env ?? serverEnv()

  const parsed = RunRequestSchema.safeParse(rawRequest ?? {})
  if (!parsed.success) {
    throw new Error(
      `Invalid run request: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
    )
  }
  // `dayType` defaults to the day the analysis DATE actually falls on. When the
  // caller supplies one that disagrees, the run is a counterfactual and says so
  // rather than labelling Monday's temperatures "Saturday".
  const dateDayType = dayTypeForDate(parsed.data.analysisDate)
  const request: RunRequest = { ...parsed.data, dayType: parsed.data.dayType ?? dateDayType }
  const dayTypeMatchesDate = request.dayType === dateDayType

  const dataset = loadStopDataset()
  const datasetManifest = loadDatasetManifest()

  /* --------------------------- thermal, first ---------------------------- */
  // Acquired BEFORE the run id, because the id must cover the thermal surface:
  // two runs of the same request against different surfaces are different runs
  // and an export has to be checkable against the numbers behind it.
  //
  // There is no live path here. A capture spends credits and takes minutes to
  // poll; it happens once, through the operator-gated capture endpoint, and
  // writes an immutable snapshot. Everything a page render can reach is either
  // that committed snapshot or the labelled fixture.
  const aoi = getAoi(request.aoiId)
  const thermal = resolveThermalLayer({ aoi, request, env, now, override: options.thermalLayer })
  const layer = thermal.layer

  const runId = deriveRunId({
    request,
    datasetSha256: datasetManifest.artifact.canonicalSha256,
    engineVersion: ENGINE_VERSION,
    thermalSha256: thermal.attestationSha256,
  })

  const secrets = env.FORTYGUARD_API_KEY ? [env.FORTYGUARD_API_KEY] : []
  const audit = new AuditLog(runId, now, secrets)

  /* ------------------------------- validating ---------------------------- */
  const windowIssue = checkAnalysisWindow(request.analysisDate, request.snapshotTimes, now())
  const stops: TransitStop[] = dataset.stops.filter((stop) =>
    bboxContains(aoi.bbox, { lat: stop.lat, lon: stop.lon }),
  )

  audit.transition({
    step: 'validating',
    inputSummary: `${dataset.stops.length} active stops city-wide, AOI ${aoi.id}`,
    outputSummary: `${stops.length} stops in the area; ridership on ${
      stops.filter((s) => s.ridership !== null).length
    }, schedule on ${stops.filter((s) => s.service).length}`,
    decision: windowIssue
      ? `Date window issue: ${windowIssue.code}`
      : 'Inputs accepted; date inside the documented acceptance window',
    source: 'lib/data/stops.ts',
    payloadForHash: { dataset: datasetManifest.artifact.sha256, aoi: aoi.id },
    error: windowIssue?.message ?? null,
  })

  if (stops.length === 0) {
    audit.transition({
      step: 'blocked',
      inputSummary: `AOI ${aoi.id}`,
      outputSummary: 'No stops',
      decision: 'blocked',
      source: 'lib/geo/aoi.ts',
      error: 'The selected area contains no active stops.',
    })
    throw new Error(`Area of interest ${aoi.id} contains no active stops.`)
  }

  /* --------------------------------- tiling ------------------------------ */
  const tilePlan = planTiles(aoi, env.FORTYGUARD_MAX_TILE_SQ_MI)
  audit.transition({
    step: 'tiling',
    inputSummary: `AOI ${aoi.id} = ${tilePlan.aoiAreaSqMi.toFixed(2)} mi²`,
    outputSummary: `${tilePlan.tiles.length} tiles, max ${env.FORTYGUARD_MAX_TILE_SQ_MI} mi² each, coverage ${tilePlan.coversAoi ? 'complete' : 'INCOMPLETE'}`,
    decision: `${tilePlan.tiles.length * request.snapshotTimes.length} heatmap submissions for a live run`,
    source: 'lib/geo/tiles.ts',
    payloadForHash: tilePlan.tiles.map((tile) => tile.id),
  })

  if (!tilePlan.coversAoi) {
    audit.transition({
      step: 'failed',
      inputSummary: `AOI ${aoi.id}`,
      outputSummary: 'Tile coverage check failed',
      decision: 'failed',
      source: 'lib/geo/tiles.ts',
      error: 'Tiles do not cover the area of interest without gaps.',
    })
    throw new Error('Tile plan does not cover the area of interest.')
  }

  /* --------------------- thermal provenance, audited --------------------- */
  const contractExercised: 'live' | 'fixture' | 'none' =
    thermal.source === 'snapshot' && layer.dataMode === 'CACHED_REAL_DATA' ? 'live' : 'fixture'

  // The unit is confirmed only when the capability probe says so AND the
  // snapshot that carried the values agrees. Either alone is not enough: the
  // probe's answer is about the API, the snapshot's is about these cells.
  const capability = loadCapability()
  const capabilityGate = evaluateCapability(capability)
  /** A layer that claims to be a measurement. The fixture is exempt from these gates. */
  const realLayer = layer.dataMode !== 'DEMO_SYNTHETIC'
  const unitConfirmed = thermal.unitConfirmed && capabilityGate.celsiusPermitted
  const celsiusPermitted = realLayer ? unitConfirmed : false
  const snapshotCapabilityConfirmed =
    capabilityGate.realProductPermitted && thermal.unitConfirmed && thermal.semanticsConfirmed
  const capabilitySummary =
    realLayer && !snapshotCapabilityConfirmed
      ? 'The current capability manifest is confirmed, but this particular real layer does not ' +
        'attest to both the confirmed temperature semantics and Celsius unit. Metric A is ' +
        'therefore NOT expressed in °C and the thermal axes remain blocked for this layer.'
      : capabilityStatement(capability)

  /**
   * The unit every surface prints.
   *
   * Three cases, and none of them is a literal typed into a component:
   * the layer's own label when it carries one — the fixture says
   * `°C (synthetic)`, which must survive verbatim — the documented unit once a
   * probe has confirmed it, and otherwise an explicit statement that the unit is
   * unknown.
   */
  const thermalUnitLabel =
    layer.unit ?? (celsiusPermitted ? LITERAL_CELSIUS : 'unconfirmed unit')

  audit.transition({
    step: 'normalizing',
    inputSummary: thermal.inputSummary,
    outputSummary:
      `${layer.cells.length} cells for ${layer.snapshots.length} snapshots, ` +
      `DATA_MODE=${env.DATA_MODE} resolved to ${thermal.resolvedDataMode}, ` +
      `mode ${layer.dataMode}, attestation ${thermal.attestationSha256.slice(0, 12)}…, ` +
      `surface ${thermal.surfaceSha256.slice(0, 12)}…` +
      (thermal.rejectedSnapshots.length > 0
        ? `, ${thermal.rejectedSnapshots.length} committed snapshot(s) rejected`
        : ''),
    decision: thermal.decision,
    source: thermal.sourceModule,
    payloadForHash: { thermal: thermal.attestationSha256, cells: layer.cells.length },
  })

  /* ------------------------- metric B: local anomaly --------------------- */
  const cellsBySnapshot = new Map<string, ThermalCell[]>()
  for (const cell of layer.cells) {
    const bucket = cellsBySnapshot.get(cell.snapshot)
    if (bucket) bucket.push(cell)
    else cellsBySnapshot.set(cell.snapshot, [cell])
  }

  /*
   * On a real layer whose field is not confirmed to hold heat, no anomaly is
   * computed either.
   *
   * Excluding it from the RANKING was not enough. The z-scores were still
   * produced, still fed the confidence score, still coloured the map, and still
   * appeared under a legend reading "Local heat anomaly" — a complete, valid,
   * publicly-labelled heat finding over a property nobody had identified. A
   * robust z-score is scale-free, so it computes happily over anything; that is
   * the reason to withhold it, not a reason to keep it.
   */
  const anomalyPermitted = !realLayer || capabilityGate.heatFieldIdentified
  const anomaliesBySnapshot = new Map<string, CellAnomaly[]>()
  if (anomalyPermitted) {
    for (const [snapshot, cells] of cellsBySnapshot) {
      anomaliesBySnapshot.set(snapshot, computeSnapshotAnomalies(cells, DEFAULT_ANOMALY_PARAMETERS))
    }
  }
  // A persistence result on the fixture is an estimator self-check, never a
  // statement about Phoenix. The scope travels with the verdict everywhere.
  const anomalyValidation = validateAnomalies(
    anomaliesBySnapshot,
    layer.dataMode === 'DEMO_SYNTHETIC' ? 'synthetic_fixture' : 'live_measurement',
  )
  // The rings travel with the cells, so containment can be tested against the
  // actual footprint rather than approximated by a distance constant.
  const ringsByCellId = new Map(layer.cells.map((cell) => [cell.id, cell.ring]))
  const stopAnomalies = attachAnomaliesToStops(stops, anomaliesBySnapshot, ringsByCellId)

  /* ------------------------ metric A: exposure load ---------------------- */
  // Snapshot times are validated as distinct whole hours, so this map is
  // injective and no snapshot can silently overwrite another.
  const hours = request.snapshotTimes.map((time) => Number(time.split(':')[0] ?? '0'))

  /*
   * The **thermal civil date** and the **GTFS service day** are two different
   * things, and the small hours are where they come apart. Minutes at or past
   * 1440 in the feed are `24:xx` and later: still on the service day that began
   * the previous morning, but occurring on this civil date. So the timetable for
   * a civil date is this day type's own in-day trips plus the *preceding* service
   * day's post-midnight ones.
   *
   * Which day type that preceding service day was is answered by the DATE when
   * the run is describing a real one: Monday's small hours are Sunday's thin
   * service, Wednesday's are Tuesday's full service, and both dates are
   * `weekday`. A counterfactual — an analyst asking what Saturday's timetable
   * would look like on this hot Monday — has no such date to appeal to, so it
   * falls back to the conservative modal answer and the run says which was used.
   */
  const precedingServiceDayType = dayTypeMatchesDate
    ? precedingDayTypeForDate(request.analysisDate)
    : precedingDayType(request.dayType)

  /*
   * On a REAL layer whose unit is unconfirmed, the thermal arithmetic does not
   * run at all.
   *
   * Masking the result afterwards was not enough, and the difference is not
   * cosmetic. `max(0, T − 30)` subtracts a Celsius constant from a number of
   * unknown scale; the 30/35/40 scenario sweep does it three times. Whatever came
   * out was still computed, still summed into an envelope, and still exported as
   * `exposureObserved`, `temperatureC`, `excessC` and `meanExcessC` — a set of
   * fully-populated columns with no unit behind any of them.
   *
   * So the temperature is withheld from the exposure model instead. Every
   * downstream quantity is then null because it was never computed, exposure
   * coverage is zero, and the evidence mode drops the exposure axis on its own.
   * The synthetic fixture is exempt: it is labelled `°C (synthetic)` everywhere
   * and claims nothing about the API.
   */
  //
  // `unitConfirmed` above already combines the two answers that matter — the
  // probe's, about the API, and the snapshot's, about these particular cells —
  // and then this gate ignored it and asked the manifest alone. So a snapshot
  // recording `unitConfirmed: false` still went through `T − 30` and the
  // 30/35/40 sweep whenever the *current* manifest happened to confirm Celsius,
  // which is precisely the retroactive relabelling the fingerprint exists to
  // prevent. The timezone was missing too: temperatures attached to the wrong
  // part of the day multiply the wrong waits, whatever their unit.
  const thermalMathsPermitted =
    !realLayer || (unitConfirmed && capabilityGate.realProductPermitted)

  const scenarioTables: StopScenarioTable[] = stops.map((stop) => {
    const anomaly = stopAnomalies.get(stop.id)
    const temperatureByHour = new Map<number, number>()
    if (thermalMathsPermitted) {
      for (const entry of anomaly?.bySnapshot ?? []) {
        if (entry.value !== null) temperatureByHour.set(hourOf(entry.snapshot), entry.value)
      }
    }
    return buildStopScenarioTable({
      stop,
      temperatureByHour,
      hours,
      dayType: request.dayType,
      precedingDayType: precedingServiceDayType,
    })
  })

  const scenarios = enumerateScenarios()
  const exposures = scenarioTables.map((table) => computeStopExposure(table, BASE_SCENARIO))
  const envelopes = new Map(
    scenarioTables.map((table) => [table.stopId, scenarioEnvelope(table, scenarios)]),
  )

  const stopsWithTemperature = scenarioTables.filter((table) => table.hasTemperature).length
  const stopsWithCompleteThermal = scenarioTables.filter(
    (table) => table.thermalCoverageComplete,
  ).length
  const stopsWithPartialThermal = scenarioTables.filter(
    (table) => table.hasTemperature && !table.thermalCoverageComplete,
  ).length

  /* ----------------------------- quality gate ---------------------------- */
  const exposureCoverage =
    stops.length > 0 ? exposures.filter((e) => e.exposure !== null).length / stops.length : 0
  const anomalyCoverage =
    stops.length > 0
      ? [...stopAnomalies.values()].filter((a) => a.z !== null).length / stops.length
      : 0
  // Reported rather than absorbed: a stop the snapshots barely covered is a gap,
  // and a coverage percentage alone does not say how many gaps are of this kind.
  const stopsWithoutAnomalyObservations = [...stopAnomalies.values()].filter(
    (entry) => entry.z === null && entry.snapshotsWithScore < MIN_SNAPSHOTS_FOR_STOP_ANOMALY,
  ).length

  const thermalGate = evaluateThermalGate({
    layer,
    anomaliesBySnapshot,
    stopsTotal: stops.length,
    stopsWithTemperature,
    unitConfirmed,
  })

  const manifest = buildProductManifest(
    {
      baselinePass: true,
      shelterInventoryAvailable: false,
      ridershipDocumented: true,
      scheduleAvailable: true,
      exposureCoverage,
      anomalyCoverage,
      anomalyValidation: anomalyValidation.verdict,
      // Two further conditions on the two-axis product, both of which were
      // previously unchecked:
      //   - the anomaly needs enough held-out snapshots to be validated at all;
      //   - a REAL capture needs the capability probe to have confirmed the
      //     field, the literal Celsius unit and an applied timezone strategy.
      sufficientHoldouts: anomalyValidation.sufficientHoldouts,
      capabilityConfirmed: !realLayer || snapshotCapabilityConfirmed,
      // The anomaly is scale-free, so it does not need a unit — but it does need
      // the field to be identified and confirmed to hold heat. Without that, a
      // valid z-score over an arbitrary numeric property would be reported as a
      // "local heat anomaly", and scale-invariance is not evidence that the data
      // is heat.
      anomalyFieldConfirmed:
        !realLayer || (capabilityGate.heatFieldIdentified && thermal.semanticsConfirmed),
      liveSignalObtained: layer.dataMode === 'CACHED_REAL_DATA',
      contractExercised,
      dataMode: layer.dataMode,
      thermalGate,
      forcedMode: env.PRODUCT_MODE as never,
    },
    now().toISOString(),
  )

  audit.transition({
    step: 'quality_gate',
    inputSummary: `${layer.cells.length} cells, ${stops.length} stops`,
    outputSummary:
      `Thermal gate ${thermalGate.outcome}; anomaly validation ${anomalyValidation.verdict} ` +
      `across ${anomalyValidation.perHoldout.length} holdout(s) validated independently ` +
      `(weakest: rank correlation ${anomalyValidation.rankCorrelation ?? 'n/a'}, ` +
      `top-decile retention ${anomalyValidation.topDecileRetention ?? 'n/a'}); ` +
      `evidence permits ${manifest.evidenceMode}, PRODUCT_MODE requested ${manifest.requestedMode}, ` +
      `effective mode ${manifest.mode}` +
      (manifest.promotionRefused ? ' (promotion REFUSED)' : '') +
      (manifest.downgraded ? ' (narrowed by configuration)' : '') +
      `; axes used exposure=${manifest.axes.exposure} anomaly=${manifest.axes.anomaly}`,
    decision: [
      ...manifest.rationale,
      ...manifest.blockingReasons,
      ...anomalyValidation.failureReasons,
    ].join(' '),
    source: 'lib/gates + lib/metrics/anomaly.ts',
    payloadForHash: {
      gate: thermalGate.outcome,
      evidenceMode: manifest.evidenceMode,
      mode: manifest.mode,
      axes: manifest.axes,
    },
  })

  /* -------------------------------- selection ---------------------------- */
  // The gates are not advisory. `manifest.axes` is the same object the mode was
  // derived from, and an excluded metric is masked to null inside
  // `rankCandidates`, so it cannot reach a percentile, a front, the tiebreak or
  // a quadrant. Before this, the mode was a label printed beside a ranking that
  // had always used both axes.
  const axes = manifest.axes
  /**
   * One sentence, used by the audit event, the methodology block and the CSV.
   *
   * Defined once because it drifted: the audit asserted Pareto layering over
   * both axes while the methodology had already learned to say otherwise.
   */
  const selectionRule =
    axes.exposure && axes.anomaly
      ? 'Pareto layering on (exposure, anomaly); within a front, order by ' +
        'min(exposure percentile, anomaly percentile); minimum separation applied, ' +
        'relaxed only if the capacity cannot otherwise be filled.'
      : axes.exposure || axes.anomaly
        ? `Ranked on ${axes.exposure ? 'exposure' : 'the local anomaly'} alone: the other axis ` +
          'is excluded by the product gates and takes no part in the ordering, the tiebreak or ' +
          'the quadrants. With one objective there is no dominance structure, so every ranked ' +
          'candidate sits on a single front. Minimum separation applied, relaxed only if the ' +
          'capacity cannot otherwise be filled.'
        : 'No ranking was produced: the product gates permit neither axis.'
  const selectionOptions = {
    capacity: request.capacity,
    minSeparationMeters: DEFAULT_MIN_SEPARATION_METERS,
    excludedIds: request.excludedIds ?? [],
    includedIds: request.includedIds ?? [],
    axes,
  }
  const geometry = stops.map((stop) => ({
    id: String(stop.id),
    lat: stop.lat,
    lon: stop.lon,
    anomalyZ: stopAnomalies.get(stop.id)?.z ?? null,
  }))

  const selection = selectUnderCapacity(
    geometry.map((entry, index) => ({ ...entry, exposure: exposures[index]?.exposure ?? null })),
    selectionOptions,
  )
  const rankedById = new Map(selection.ranked.map((entry) => [entry.id, entry]))

  /* ------------------- assumption sensitivity of the plan ---------------- */
  // The whole cross product is re-selected, because the headline result is the
  // SPLIT between candidates that survive every scenario and candidates that do
  // not. The per-stop tables make each pass a handful of multiplications rather
  // than a recomputation.
  //
  // Two things are recorded per candidate, and both are reported: how often it
  // is selected, and how far its rank moves while it is. A candidate selected
  // 98% of the time but swinging between rank 2 and rank 48 is a different
  // object from one that is always rank 3, and a single frequency hides that.
  const selectionCount = new Map<string, number>()
  const bestRank = new Map<string, number>()
  const worstRank = new Map<string, number>()
  const dimensionLoss = new Map<string, Set<string>>()
  const droppedByCombinationOnly = new Set<string>()

  // Scenarios in which each stop could be evaluated at all. A scenario naming a
  // quarter this stop has no figure for is UNAVAILABLE, not a scenario the stop
  // failed; counting it as failure manufactured assumption-sensitivity out of a
  // gap in the source.
  const availableCount = new Map<string, number>()
  for (let index = 0; index < stops.length; index += 1) {
    availableCount.set(
      String(stops[index]!.id),
      scenariosAvailableFor(scenarioTables[index]!, scenarios),
    )
  }

  // Pins are placed by the analyst, so they appear in every scenario's selection
  // regardless of merit. Counting them would report a pin as 324/324 robust —
  // the strongest analytical claim the product makes, produced by a click.
  const pinnedSet = new Set(selection.pinnedIds)

  // The envelope varies five settings of the EXPOSURE model and nothing else, so
  // re-selecting under it says nothing about a run that does not use exposure:
  // every scenario would return the same ranking and every candidate would be
  // reported as robust under all 324 of them. That would be the strongest claim
  // the product makes, produced by an axis the gates excluded.
  const scenarioSweepApplies = axes.exposure

  for (const scenario of scenarioSweepApplies ? scenarios : []) {
    const alternative = selectUnderCapacity(
      geometry.map((entry, index) => ({
        ...entry,
        exposure: exposureForScenario(scenarioTables[index]!, scenario),
      })),
      selectionOptions,
    )
    const chosen = new Set(alternative.selectedIds)
    // `selectedIds` is in rank order: position 0 is rank 1.
    alternative.selectedIds.forEach((id, index) => {
      if (pinnedSet.has(id)) return
      const rank = index + 1
      selectionCount.set(id, (selectionCount.get(id) ?? 0) + 1)
      bestRank.set(id, Math.min(bestRank.get(id) ?? rank, rank))
      worstRank.set(id, Math.max(worstRank.get(id) ?? rank, rank))
    })

    // Attribution is ONE-AT-A-TIME: a setting is blamed only when changing that
    // single dimension away from the base drops the candidate. The earlier
    // version unioned every dimension that differed in any losing scenario, so
    // a stop dropping under one four-way combination was reported as sensitive
    // to all four settings independently — which is not what was measured.
    const changed = SCENARIO_DIMENSIONS.filter(
      (dimension) => scenario[dimension] !== BASE_SCENARIO[dimension],
    )
    for (const id of selection.selectedIds) {
      if (pinnedSet.has(id) || chosen.has(id)) continue
      if (changed.length === 1) {
        const dimension = changed[0]!
        const losses = dimensionLoss.get(id) ?? new Set<string>()
        losses.add(`${dimension}=${String(scenario[dimension])}`)
        dimensionLoss.set(id, losses)
      } else {
        droppedByCombinationOnly.add(id)
      }
    }
  }

  const layerAgeDays = stopLayerAgeDays(now())

  const results: StopResult[] = stops.map((stop, index) => {
    const exposure = exposures[index]!
    const table = scenarioTables[index]!
    const anomaly = stopAnomalies.get(stop.id)
    const ranked = rankedById.get(String(stop.id))
    const bounds = envelopes.get(stop.id)
    const id = String(stop.id)

    const survived = selectionCount.get(id) ?? 0
    const baseSelected = selection.selectedIds.includes(id)
    const isPinned = selection.pinnedIds.includes(id)
    const evaluable = scenarioSweepApplies ? (availableCount.get(id) ?? 0) : 0

    // Robust means: evaluable under EVERY scenario, and selected in every one of
    // them. A stop the source cannot support everywhere cannot earn the strongest
    // claim the product makes, and a pin never earns it at all. When the sweep
    // does not apply, nothing is robust — the split is withheld rather than
    // awarded by default.
    const fullyEvaluable = scenarioSweepApplies && evaluable === scenarios.length
    const assumptionSensitive = isPinned
      ? false
      : baseSelected
        ? !(fullyEvaluable && survived === scenarios.length)
        : true
    // The denominator is what was actually evaluated, not what was offered.
    const scenarioSelectionRate = evaluable > 0 ? survived / evaluable : 0

    const missing = [...new Set([...exposure.missing, ...(anomaly?.z === null ? ['heat anomaly'] : [])])]
    const complete = ranked?.complete ?? false

    /* ------------------------------ confidence --------------------------- */
    const dataModeScore =
      layer.dataMode === 'LIVE_FORTYGUARD' ? 1 : layer.dataMode === 'CACHED_REAL_DATA' ? 0.85 : 0.2
    const completeness =
      (exposure.exposure !== null ? 0.5 : 0) + (anomaly?.z != null ? 0.5 : 0)
    const freshness =
      layerAgeDays === null ? 0.5 : Math.max(0, Math.min(1, 1 - layerAgeDays / 365))
    // A fixture self-check is not evidence about Phoenix, so it cannot raise
    // confidence the way a live validation would.
    const anomalySupport =
      anomalyValidation.scope === 'synthetic_fixture'
        ? 0.15
        : anomalyValidation.verdict === 'PERSISTENT'
          ? 1
          : anomalyValidation.verdict === 'WEAK'
            ? 0.5
            : 0.15

    const components = {
      completeness: round(completeness, 3),
      freshness: round(freshness, 3),
      dataMode: dataModeScore,
      anomalyValidation: anomalySupport,
      scenarioStability: round(scenarioSelectionRate, 3),
    }
    const confidenceScore =
      round(
        0.3 * components.completeness +
          0.1 * components.freshness +
          0.25 * components.dataMode +
          0.2 * components.anomalyValidation +
          0.15 * components.scenarioStability,
        4,
      ) * 100

    const reasons: string[] = []
    if (dataModeScore <= 0.25) reasons.push('Thermal layer is not a live FortyGuard measurement.')
    if (missing.length) reasons.push(`Missing: ${missing.join(', ')}.`)
    if (bounds?.spreadRatio && bounds.spreadRatio > 1.5) {
      reasons.push(
        `Exposure varies by ×${bounds.spreadRatio.toFixed(1)} across the ${scenarios.length}-scenario envelope.`,
      )
    }
    if (isPinned) {
      reasons.push(
        'Pinned by the analyst. It is in the plan by instruction, not by ranking, and carries no ' +
          'robustness claim.',
      )
    } else if (baseSelected && assumptionSensitive) {
      const losses = [...(dimensionLoss.get(id) ?? [])].sort().slice(0, 3)
      const best = bestRank.get(id)
      const worst = worstRank.get(id)
      const attribution = losses.length
        ? `; drops when ${losses.join(' or ')} alone is changed.`
        : droppedByCombinationOnly.has(id)
          ? '; no single setting drops it — only combinations do.'
          : '.'
      reasons.push(
        `Assumption-dependent: selected in ${survived} of ${evaluable} evaluable scenarios` +
          (evaluable < scenarios.length
            ? ` (${scenarios.length - evaluable} of ${scenarios.length} could not be evaluated)`
            : '') +
          (best !== undefined && worst !== undefined
            ? `, ranking ${best === worst ? `${best}` : `${best}–${worst}`} where selected`
            : '') +
          attribution,
      )
    }
    if (bounds && bounds.scenariosUnavailable > 0) {
      reasons.push(
        `${bounds.scenariosUnavailable} of ${scenarios.length} scenarios could not be evaluated ` +
          `here${table.quartersUnavailable.length ? ` (no published ridership for ${table.quartersUnavailable.join(', ')})` : ''}.`,
      )
    }
    if (anomalyValidation.scope === 'synthetic_fixture') {
      reasons.push('Anomaly validated only against the synthetic fixture, not against Phoenix.')
    } else if (anomalyValidation.verdict !== 'PERSISTENT') {
      reasons.push(`Anomaly did not validate as persistent (${anomalyValidation.verdict}).`)
    }

    return {
      stop,
      // The quantity this product used. Null when the gates excluded the axis:
      // a number that is excluded from selection but still printed in the rank
      // column is a number the reader will rank on anyway.
      exposure: axes.exposure ? exposure.exposure : null,
      // …and the measurement itself, always, so nothing is hidden — only
      // separated from the thing it is not allowed to influence.
      exposureObserved: exposure.exposure,
      exposurePercentile: ranked?.exposurePercentile ?? null,
      envelopeLow: bounds?.low ?? null,
      envelopeHigh: bounds?.high ?? null,
      envelopeSpreadRatio: bounds?.spreadRatio ?? null,
      scenariosEvaluated: bounds?.scenariosEvaluated ?? 0,
      scenariosUnavailable: bounds?.scenariosUnavailable ?? scenarios.length,
      quartersUnavailable: [...table.quartersUnavailable],
      thermalHoursCovered: table.hoursWithTemperature,
      thermalHoursAnalysed: table.hours.length,
      thermalCoverageComplete: table.thermalCoverageComplete,
      scenarioSelectionRate: round(scenarioSelectionRate, 3),
      scenarioSelectionCount: survived,
      /** The honest denominator: scenarios this stop could be evaluated under. */
      scenarioCount: evaluable,
      scenariosOffered: scenarios.length,
      scenarioRankBest: bestRank.get(id) ?? null,
      scenarioRankWorst: worstRank.get(id) ?? null,
      pinned: isPinned,
      assumptionSensitive,
      sensitiveTo: [...(dimensionLoss.get(id) ?? [])].sort(),
      droppedByCombinationOnly: droppedByCombinationOnly.has(id),
      anomalyZ: axes.anomaly ? (anomaly?.z ?? null) : null,
      anomalyZObserved: anomaly?.z ?? null,
      anomalyObservations: anomaly?.snapshotsWithScore ?? 0,
      anomalyIneligibleReason: anomaly?.ineligibleReason ?? null,
      anomalyPercentile: ranked?.anomalyPercentile ?? null,
      backgroundC: anomaly?.backgroundC ?? null,
      quadrant: ranked?.quadrant ?? null,
      paretoFront: ranked?.paretoFront ?? null,
      hourly: exposure.hourly,
      anomalyBySnapshot: anomaly?.bySnapshot ?? [],
      ridersInWindow: exposure.ridersInWindow,
      publishedDailyRiders:
        stop.ridership?.byQuarter[BASE_SCENARIO.ridershipQuarter]?.[
          RIDERSHIP_CATEGORY_FOR_DAY_TYPE[request.dayType]
        ] ?? null,
      ridersAllocatedAcrossDay: exposure.ridersAllocatedAcrossDay,
      meanWaitMinutes: exposure.meanWaitMinutes,
      meanExcessC: exposure.meanExcessC,
      confidence: {
        band: bandFor(confidenceScore),
        score: round(confidenceScore, 1),
        components,
        reasons,
      },
      missing,
      complete,
    }
  })

  /* ------------------------- the headline result ------------------------- */
  // The result of this product is not "a plan of N stops". It is the split: the
  // candidates that hold under every stated assumption, and the candidates that
  // are an artefact of one. Reporting the plan as a single ranked list would
  // present those two as the same kind of thing, and they are not.
  const pinnedIds = [...selection.pinnedIds]
  const analytic = selection.selectedIds.filter((id) => !pinnedSet.has(id))
  const robustIds = scenarioSweepApplies
    ? analytic.filter(
        (id) =>
          (availableCount.get(id) ?? 0) === scenarios.length &&
          (selectionCount.get(id) ?? 0) === scenarios.length,
      )
    : []
  const assumptionDependentIds = analytic.filter((id) => !robustIds.includes(id))
  const pinnedSuffix = pinnedIds.length
    ? ` + ${pinnedIds.length} analyst-pinned ${pinnedIds.length === 1 ? 'location' : 'locations'}`
    : ''
  const headline =
    manifest.mode === 'NO_GO_THERMAL_PRODUCT'
      ? `NO RANKED RECOMMENDATION — the product gates permit neither axis${pinnedSuffix}`
      : !scenarioSweepApplies
        ? `${analytic.length} ranked ${analytic.length === 1 ? 'candidate' : 'candidates'} on the ` +
          'anomaly axis alone; the robustness split does not apply because the scenario envelope ' +
          `varies only the exposure model${pinnedSuffix}`
        : `${robustIds.length} robust ${robustIds.length === 1 ? 'priority' : 'priorities'} + ` +
          `${assumptionDependentIds.length} assumption-dependent ` +
          `${assumptionDependentIds.length === 1 ? 'candidate' : 'candidates'}${pinnedSuffix}`

  audit.transition({
    step: 'scoring',
    inputSummary: `${stops.length} stops, ${scenarios.length} scenarios`,
    outputSummary:
      `${headline}. ` +
      (scenarioSweepApplies
        ? (axes.exposure && axes.anomaly
            ? `Across ${selection.frontsUsed} Pareto front(s). `
            : `Ranked on ${axes.exposure ? 'exposure' : 'the local anomaly'} alone. `) +
          `Robust = selected in all ${scenarios.length} scenarios; each candidate also carries ` +
          'its selection frequency and the range of ranks it takes across the scenarios in ' +
          'which it is selected.'
        : 'No scenario sweep: the envelope varies only the exposure model, which this run does ' +
          'not use, so no robustness split is offered.'),
    // Says what this run did. It used to assert Pareto layering over both axes
    // and a 324-scenario sweep unconditionally, so a mono-axis or NO_GO run
    // recorded a method it had not used, in the one place meant to be the record.
    decision:
      `Weight-free selection, ${selection.requestedSeparationMeters} m minimum separation. ` +
      selectionRule,
    source: 'lib/metrics/selection.ts + lib/metrics/exposure.ts',
    payloadForHash: selection.selectedIds,
  })

  audit.transition({
    step: 'awaiting_approval',
    inputSummary: headline,
    outputSummary: 'Plan ready for human review',
    decision: 'A person must approve before the plan can be exported',
    source: 'lib/agent/run.ts',
  })

  /* ------------------------- map layer (aggregated) ---------------------- */
  const cellAggregate = new Map<
    string,
    { lon: number; lat: number; ring: Array<[number, number]>; values: number[]; zs: number[] }
  >()
  for (const [snapshot, entries] of anomaliesBySnapshot) {
    const cells = cellsBySnapshot.get(snapshot) ?? []
    const ringById = new Map(cells.map((cell) => [cell.id, cell.ring]))
    for (const entry of entries) {
      const key = `${entry.lon.toFixed(5)}|${entry.lat.toFixed(5)}`
      const bucket = cellAggregate.get(key) ?? {
        lon: entry.lon,
        lat: entry.lat,
        ring: ringById.get(entry.cellId) ?? [],
        values: [],
        zs: [],
      }
      bucket.values.push(entry.value)
      if (entry.z !== null) bucket.zs.push(entry.z)
      cellAggregate.set(key, bucket)
    }
  }
  const heatCells = normaliseCellGeometry(
    [...cellAggregate.values()].map((bucket) => ({
      lon: round(bucket.lon, 6),
      lat: round(bucket.lat, 6),
      ring: bucket.ring,
      value: round(bucket.values.reduce((a, b) => a + b, 0) / bucket.values.length, 2),
      z: bucket.zs.length ? round(bucket.zs.reduce((a, b) => a + b, 0) / bucket.zs.length, 2) : null,
    })),
  )

  const { cells: _cells, ...layerWithoutCells } = layer
  void _cells

  return {
    runId,
    state: audit.state,
    createdAt: now().toISOString(),
    request,
    manifest,
    aoi,
    tilePlan,
    thermal: { ...layerWithoutCells, cellCount: layer.cells.length },
    heatCells,
    results,
    plan: {
      capacity: selection.capacity,
      entries: selection.entries,
      selectedIds: selection.selectedIds,
      headline,
      robustIds,
      assumptionDependentIds,
      pinnedIds,
      axesUsed: axes,
      scenarioSweepApplies,
      scenarioCount: scenarios.length,
      robustRule: !scenarioSweepApplies
        ? `The ${scenarios.length}-scenario envelope varies five settings of the EXPOSURE model ` +
          'and nothing else, and this run does not use exposure. Re-selecting under it would ' +
          'return the same ranking every time and report every candidate as robust under all ' +
          `${scenarios.length} scenarios — the strongest claim this product makes, produced by an ` +
          'axis the gates excluded. The split is therefore withheld rather than awarded.'
        : `A selection is robust when it can be evaluated under every one of the ${scenarios.length} ` +
        'scenarios in the envelope AND is chosen in every one of them. A stop the source cannot ' +
        'support everywhere is reported against the number of scenarios it could actually be ' +
        'evaluated under, and cannot be robust. Anything else is an assumption-dependent ' +
        'candidate, reported with its selection frequency and rank range. Analyst pins are ' +
        'counted in neither: they are in the plan by instruction, and carry no robustness claim.',
      quadrantCounts: selection.quadrantCounts,
      incompleteIds: selection.incompleteIds,
      minimumSeparationMeters: selection.minimumSeparationMeters,
      requestedSeparationMeters: selection.requestedSeparationMeters,
      frontsUsed: selection.frontsUsed,
      notes: selection.notes,
    },
    methodology: {
      exposure: {
        name: 'Estimated scenario exposure load',
        formula: 'ESEL = Σ_hours  riders(h) × wait(h) × max(0, T(h) − T_ref)',
        ridersFormula:
          'riders(h) = R × w(h), where w is a distribution over the 24 clock hours that is zero ' +
          'wherever no service runs, so Σ_{h=0..23} riders(h) = R exactly.',
        waitFormula:
          'wait(h) = E[min(W, cap)] for an arrival uniform on hour h, where W is the time to the ' +
          'next scheduled departure. Each scheduled gap is clipped to hour h before it is ' +
          'weighted, so a gap crossing the hour boundary contributes only the part of itself a ' +
          'passenger can arrive in. It collapses to Σgap²/(2Σgap) only when the gaps tile the ' +
          'hour exactly, and to headway/2 only when they are also equal.',
        waitCapRule: WAIT_CAP_RULE,
        // The unit is only degrees when the probe has confirmed that the
        // property read actually holds a Celsius temperature. Until then the
        // excess above the reference is in whatever the API returned, and
        // saying "°C" would be the guess this project exists to avoid.
        //
        // These three strings are the ONLY place a unit is spelled. Every panel,
        // tooltip, legend and export column reads them, so a hardcoded "°C"
        // cannot survive somewhere the layer is not actually Celsius.
        thermalUnitLabel,
        loadUnitShort: `${thermalUnitLabel}·rider-min`,
        unit: `scenario ${thermalUnitLabel}·rider-minutes over the analysed hours`,
        celsiusReadingPermitted: celsiusPermitted,
        capabilityStatement: capabilitySummary,
        isMeasurement: false,
        quantityCaveat:
          'A modelled quantity under one stated scenario, not a measurement. The riders are a ' +
          'published quarterly average allocated by an unobserved hourly profile, the wait is ' +
          'computed from the timetable rather than observed, and no rider’s exposure has been ' +
          'measured. Comparable between stops within a run; not a count of people and not a ' +
          'dose anyone received.',
        referenceTemperatureC: BASE_SCENARIO.referenceTemperatureC,
        referenceTemperatureSource:
          "FortyGuard's documented API default for the exceedance and persistence analytics. " +
          'This is an API convention, NOT a health or heat-stress threshold.',
        waitCap: BASE_SCENARIO.waitCap,
        routeChoice: BASE_SCENARIO.routeChoice,
        demandProfile: BASE_SCENARIO.demandProfile,
        dayType: request.dayType,
        ridershipCategory: RIDERSHIP_CATEGORY_FOR_DAY_TYPE[request.dayType],
        dayTypeRule:
          `The ${request.dayType} timetable is paired with the published ` +
          `${RIDERSHIP_CATEGORY_FOR_DAY_TYPE[request.dayType]} ridership average. Weekend ` +
          'ridership is never combined with a weekday schedule. The source publishes one Weekend ' +
          'average and does not split Saturday from Sunday, so that single average is applied to ' +
          'each weekend day against its own genuinely different timetable.',
        ridershipQuarter: BASE_SCENARIO.ridershipQuarter,
        ridershipQuarterLabel: 'FY2024 Q4 — Apr–Jun 2024',
        ridershipQuarterSelection:
          'The latest quarter passing this project’s own completeness checks, which are executed ' +
          'on every dataset build and are NOT independently reconciled. See ' +
          'datasetProvenance.completeness.',
        periodMismatch:
          'Ridership covers Apr–Jun 2024; the GTFS schedule is effective July 2026 and the ' +
          `thermal date is ${request.analysisDate}. Handled as the ridershipQuarter scenario ` +
          'dimension, not as a rounding error.',
        assumptions: [...EXPOSURE_ASSUMPTIONS],
      },
      scenarioEnvelope: {
        description: scenarioSweepApplies
          ? 'The spread across the full cross product of the five unobserved dimensions. It is an ' +
            'envelope of stated scenarios, not a confidence interval — nothing here is a sampling ' +
            'distribution.'
          : 'NOT APPLIED on this run. Every dimension below varies the EXPOSURE model, which this ' +
            'run does not use, so re-selecting under them would return the same ranking every ' +
            'time and report every candidate as robust under all of them.',
        applied: scenarioSweepApplies,
        /** Scenarios actually re-selected. Zero when the sweep does not apply. */
        scenarioCount: scenarioSweepApplies ? scenarios.length : 0,
        scenariosOffered: scenarios.length,
        dimensions: {
          demandProfile: [...DEMAND_PROFILES],
          routeChoice: [...ROUTE_CHOICE_MODELS],
          waitCap: [...WAIT_CAP_SCENARIOS],
          referenceTemperatureC: [...REFERENCE_TEMPERATURES_C],
          ridershipQuarter: [...DRIFT_QUARTERS],
        },
        base: { ...BASE_SCENARIO },
        assumptionSensitiveRule:
          'A candidate is assumption-sensitive unless it is selected in every one of the ' +
          `${scenarios.length} scenarios.`,
      },
      anomaly: {
        formula: 'z = (v − median(neighbours within R)) / (1.4826 × MAD(neighbours within R))',
        radiusMeters: DEFAULT_ANOMALY_PARAMETERS.radiusMeters,
        minNeighbours: DEFAULT_ANOMALY_PARAMETERS.minNeighbours,
        leaveOneOut: true,
        validation: {
          fitSnapshot: anomalyValidation.fitSnapshot,
          holdoutSnapshots: anomalyValidation.holdoutSnapshots,
          perHoldout: anomalyValidation.perHoldout.map((entry) => ({ ...entry })),
          comparedCells: anomalyValidation.comparedCells,
          rankCorrelation: anomalyValidation.rankCorrelation,
          topDecileRetention: anomalyValidation.topDecileRetention,
          topDecileChanceLevel: anomalyValidation.topDecileChanceLevel,
          verdict: anomalyValidation.verdict,
          scope: anomalyValidation.scope,
          statement: anomalyValidation.statement,
          failureReasons: anomalyValidation.failureReasons,
          minimumSnapshotsPerStop: MIN_SNAPSHOTS_FOR_STOP_ANOMALY,
          stopsWithoutSufficientObservations: stopsWithoutAnomalyObservations,
        },
      },
      selection: {
        // Names what this run actually did. It used to state the two-axis rule
        // unconditionally, so a mono-axis run described a Pareto layering over a
        // metric it had excluded.
        rule: selectionRule,
        axesUsed: axes,
        minSeparationMeters: selection.requestedSeparationMeters,
        weightsUsed: false,
      },
    },
    audit: audit.toJSON(),
    datasetProvenance: {
      stopsSha256: datasetManifest.artifact.sha256,
      stopsCanonicalSha256: datasetManifest.artifact.canonicalSha256,
      stopCount: dataset.stops.length,
      generatedAtUtc: dataset.generatedAtUtc,
      ridershipCoveragePct: dataset.counts.ridershipCoveragePct,
      serviceCoveragePct: dataset.counts.serviceCoveragePct,
      serviceCoverageByDayType: dataset.counts.serviceCoverageByDayType,
      completeness: dataset.provenance.ridership.completenessChecks,
    },
    dataResolution: {
      configured: env.DATA_MODE,
      resolved: thermal.resolvedDataMode,
      dataMode: layer.dataMode,
      provenance: layer.provenance,
      /**
       * `auto` says what it will try, not what it did. Every surface reads this
       * rather than the configured value, so a run that fell back to the fixture
       * cannot be read as one that served a capture.
       */
      isSynthetic: layer.dataMode === 'DEMO_SYNTHETIC',
      unitConfirmed,
      unitLabel: thermalUnitLabel,
      valuesAre: layer.dataMode === 'DEMO_SYNTHETIC'
        ? 'synthetic'
        : unitConfirmed
          ? 'real, unit confirmed'
          : 'real, unit unconfirmed',
      snapshotAttestationSha256: thermal.source === 'snapshot' ? thermal.attestationSha256 : null,
      rejectedSnapshots: thermal.rejectedSnapshots.map((entry) => ({
        file: entry.path.split(/[\\/]/).pop() ?? entry.path,
        reasons: entry.reasons,
      })),
    },
    serviceDayResolution: {
      /** The date the temperatures belong to. */
      thermalCivilDate: request.analysisDate,
      /** The service day whose in-day trips run on that date. */
      analysedServiceDay: request.dayType,
      /** The civil date before it, and the service day that ran that night. */
      precedingCivilDate: previousCivilDate(request.analysisDate),
      precedingServiceDay: precedingServiceDayType,
      precedingDerivedFrom: dayTypeMatchesDate ? 'the analysis date' : 'a conservative modal fallback',
      rule:
        'GTFS times at or past 24:00 belong to the service day that began the previous morning ' +
        'and occur on this civil date. The timetable for a civil date is therefore this day ' +
        "type's own in-day trips plus the PRECEDING service day's post-midnight ones. Which day " +
        'type that was is read off the date when the run describes a real one; a counterfactual ' +
        'has no date to appeal to and uses the thinnest plausible answer, so the early-hours ' +
        'wait is never understated.',
    },
    dayTypeResolution: {
      analysisDate: request.analysisDate,
      dateFallsOn: dateDayType,
      analysed: request.dayType,
      matchesDate: dayTypeMatchesDate,
      rule:
        'dayType defaults to the day the analysis date actually falls on. A run that analyses a ' +
        'different day type is a counterfactual — a real timetable paired with another day’s ' +
        'temperatures — and is labelled as one rather than presented as that day.',
    },
    thermalCoverage: {
      analysedHours: [...hours],
      stopsTotal: stops.length,
      stopsWithAnyHour: stopsWithTemperature,
      stopsWithEveryHour: stopsWithCompleteThermal,
      stopsWithPartialCoverage: stopsWithPartialThermal,
      stopsMissingAQuarter: scenarioTables.filter(
        (table) => table.quartersUnavailable.length > 0,
      ).length,
      rule:
        'The scenario exposure load is a sum over the analysed hours, so it is produced only for ' +
        'stops that received a temperature for EVERY analysed hour. A stop covered for some hours ' +
        'reports no load and says how many hours it has: summing over whichever hours arrived ' +
        'would make a partially covered stop look cooler or quieter than a fully covered one, ' +
        'which is indistinguishable from a real finding.',
    },
    limitations: limitationsFor(layer, anomalyValidation, request.analysisDate, request.dayType, {
      stopsWithPartialCoverage: stopsWithPartialThermal,
      stopsTotal: stops.length,
      dayTypeMatchesDate,
      dateDayType,
      capability: capabilityGate,
    }),
  }
}

/**
 * Append the self-attestation and export transitions to a **completed** run.
 *
 * ## An export is a frozen representation, not a second execution
 *
 * This function used to build a new `AuditLog` and replay every recorded event
 * through it. That regenerated each timestamp from the export's clock, so a plan
 * downloaded on Thursday carried a trail saying it had validated, tiled,
 * normalised, gated and scored on Thursday — whatever day it actually ran. The
 * hashes moved with the payloads, the sequence numbers were re-derived, and the
 * one artefact whose entire purpose is to be unchanged was rewritten on every
 * read.
 *
 * The prefix is now the same array elements it always was. `appendAuditEvent`
 * cannot touch an earlier record, so "the export preserved the original audit" is
 * a property of the code rather than something to spot-check. Nothing here calls
 * the engine, loads a snapshot, or recomputes a timestamp that already exists.
 *
 * ## Not "approval"
 *
 * This product has no authentication, so the name is a claim that someone
 * reviewed the plan, recorded verbatim alongside the run id **and the audit
 * digest** it was made against. Calling it an approval would imply an identity
 * check that never happens.
 */
export function finalizeRun(
  result: RunResult,
  options: { attestedBy: string; now?: () => Date; secrets?: string[] },
): RunResult {
  const now = options.now ?? (() => new Date())
  const secrets = options.secrets ?? []

  // The digest of the trail as it stood when it was reviewed. Bound into the
  // attestation, so the name is tied to a specific sequence of records and not
  // merely to a run id that a differently-audited run could also carry.
  const reviewedAuditSha256 = auditHash(result.audit)

  const withAttestation = appendAuditEvent(
    result.audit,
    {
      step: 'approved',
      inputSummary: `${result.plan.headline} (${result.runId})`,
      outputSummary: `Self-attested by "${options.attestedBy}"`,
      // The wording is the record. An export that said "approved" would imply an
      // authorisation nobody performed and nothing verified.
      decision:
        'NAMED SELF-ATTESTATION, not an authenticated approval: this product has no ' +
        'authentication, so the name is whatever the reviewer typed. It is bound to run id ' +
        `${result.runId} and to audit digest ${reviewedAuditSha256.slice(0, 16)}…, which is the ` +
        'trail exactly as it stood when the plan was reviewed. Nothing before this record was ' +
        'regenerated to produce the export.',
      source: 'lib/agent/run.ts',
      payloadForHash: {
        runId: result.runId,
        selected: result.plan.selectedIds,
        audit: reviewedAuditSha256,
      },
    },
    { now, secrets },
  )

  const audit = appendAuditEvent(
    withAttestation,
    {
      step: 'exported',
      inputSummary: `Run ${result.runId}`,
      outputSummary: 'Export generated',
      decision:
        'Plan exported with full provenance. The engine was not re-executed and no snapshot was ' +
        'read: this artefact is a frozen representation of the run above.',
      source: 'lib/export',
      payloadForHash: result.plan.selectedIds,
    },
    { now, secrets },
  )

  return {
    ...result,
    state: 'exported',
    audit,
    attestation: {
      attestedBy: options.attestedBy,
      attestedAtUtc: now().toISOString(),
      runId: result.runId,
      reviewedAuditSha256,
      kind: 'named_self_attestation',
      caveat:
        'This product has no authentication. The name above is a claim by whoever typed it that ' +
        'they reviewed this plan, bound to the run id and the audit digest it was made against. ' +
        'It is NOT an authenticated approval and confers no authority.',
    },
  }
}
