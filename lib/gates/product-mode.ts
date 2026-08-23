import type { DataMode, GateResult, ProductManifest, ProductMode } from '@/lib/types'
import { resolveAllowedClaims } from '@/lib/claims/registry'
import type { ThermalGateReport } from './thermal-gate'

/**
 * Which product this run is allowed to be.
 *
 * The product name is an output of the data, not an input. Two metrics have to
 * be independently computable for the full product to be claimed; when only one
 * is, the product narrows and says so rather than filling the gap.
 */

export interface GateInputs {
  baselinePass: boolean
  /** A usable, recent, complete shelter inventory exists. */
  shelterInventoryAvailable: boolean
  /** Ridership carries a documented unit, period and day category. */
  ridershipDocumented: boolean
  /** Scheduled headways are available from an official feed. */
  scheduleAvailable: boolean
  /** Share of stops for which metric A could be computed. */
  exposureCoverage: number
  /** Share of stops for which metric B could be computed. */
  anomalyCoverage: number
  /** Verdict of the out-of-sample anomaly validation. */
  anomalyValidation: string
  /**
   * Whether enough snapshots were held out to validate the anomaly at all.
   *
   * A `PERSISTENT` verdict from a single holdout is two readings agreeing once,
   * which a slow-moving surface produces regardless of whether the anomaly is a
   * real feature of the ground. Without this the two-axis product could be
   * claimed on a two-snapshot run.
   */
  sufficientHoldouts: boolean
  /**
   * Whether the capability probe permits the full product on THIS layer.
   *
   * Always true for the fixture, which claims nothing about the API. For a real
   * capture it requires a confirmed value field, a literal Celsius unit and an
   * applied timezone strategy — each separately sufficient to make the excess
   * above a reference temperature meaningless.
   */
  capabilityConfirmed: boolean
  /**
   * Whether the value field is identified AND confirmed to hold heat.
   *
   * Gates the anomaly axis. Weaker than `capabilityConfirmed` on purpose: a
   * robust z-score is unchanged by the unit, so the anomaly does not need one —
   * but it does need the number to be heat, or the product reports a "local heat
   * anomaly" over a property nobody has identified.
   */
  anomalyFieldConfirmed: boolean
  liveSignalObtained: boolean
  contractExercised: 'live' | 'fixture' | 'none'
  dataMode: DataMode
  thermalGate: ThermalGateReport
  forcedMode?: ProductMode | 'auto'
}

const MIN_COVERAGE = 0.5

export function evaluateGates(inputs: GateInputs): GateResult[] {
  const gates: GateResult[] = []

  gates.push({
    id: 'baseline',
    status: inputs.baselinePass ? 'PASS' : 'FAIL',
    summary: inputs.baselinePass
      ? 'Source record counts and joins reproduce from freshly fetched official layers.'
      : 'Baseline metrics did not reproduce.',
    evidence: [
      'scripts/fetch/fetch_arcgis.py asserts the service-reported count on every layer.',
      'tests/unit/baseline-metrics.test.ts pins the reference values and every artefact hash.',
    ],
  })

  gates.push({
    id: 'ridershipDocumentation',
    status: inputs.ridershipDocumented ? 'PASS' : 'FAIL',
    summary: inputs.ridershipDocumented
      ? 'Ridership carries a published unit, period and day category.'
      : 'Ridership has no documented unit or period.',
    evidence: [
      'Valley Metro BusStopQuarterlyRidership: average daily riders per stop, by quarter, split Weekday / Weekend.',
      'The layer does not disambiguate boardings from boardings plus alightings; exposure is an upper bound if alightings are included.',
      "The City's undocumented RIDERSHIP integer is retained only as a cross-check and is never computed on.",
    ],
  })

  gates.push({
    id: 'scheduledService',
    status: inputs.scheduleAvailable ? 'PASS' : 'FAIL',
    summary: inputs.scheduleAvailable
      ? 'Scheduled headways are derived from the official GTFS feed.'
      : 'No schedule is available, so expected wait cannot be estimated.',
    evidence: [
      'Valley Metro GTFS via City of Phoenix Open Data, licensed ODC-BY.',
      'Departures per hour per route on a representative weekday; the final stop of each trip is excluded.',
      'Scheduled service, not observed service.',
    ],
  })

  gates.push({
    id: 'shelterInventory',
    status: inputs.shelterInventoryAvailable ? 'PASS' : 'FAIL',
    summary: inputs.shelterInventoryAvailable
      ? 'A usable shelter inventory is loaded.'
      : 'No public source can say which Phoenix stops already have a shelter.',
    evidence: [
      'City NBR_SHELTERS: 20 non-null values across 4104 stops.',
      'Valley Metro Shelters (integer): 0 positive values across 4289 Phoenix stops.',
      'Phoenix publishes 3164 sheltered stops for FY2024-25 — the fields are incomplete, not negative.',
    ],
  })

  const contractStatus =
    inputs.contractExercised === 'live'
      ? 'PASS'
      : inputs.contractExercised === 'fixture'
        ? 'PASS_FIXTURE'
        : 'FAIL'
  gates.push({
    id: 'fortyGuardContract',
    status: contractStatus,
    summary:
      inputs.contractExercised === 'live'
        ? 'Submit, poll and result parsing verified against the live API.'
        : 'Submit, poll, error and result parsing verified against typed fixtures; the live path is implemented and unexecuted.',
    evidence: [
      'tests/integration/fortyguard-client.test.ts covers every documented failure mode and several undocumented ones.',
    ],
  })

  gates.push({
    id: 'fortyGuardLiveSignal',
    status: inputs.liveSignalObtained
      ? inputs.thermalGate.outcome === 'GO_THERMAL_SIGNAL'
        ? 'PASS'
        : inputs.thermalGate.outcome === 'GO_CONDITIONAL_FACTOR_ONLY'
          ? 'PASS_WITH_LIMITATIONS'
          : 'FAIL'
      : 'BLOCKED_LIVE',
    summary: inputs.liveSignalObtained
      ? `Live signal evaluated: ${inputs.thermalGate.outcome}.`
      : 'No cached real FortyGuard snapshot was used for this run; no live request was made.',
    evidence: inputs.liveSignalObtained
      ? inputs.thermalGate.reasons
      : [
          'The deployment cannot submit a request; it reads committed snapshots only.',
          'Capture locally and commit an exact matching snapshot to close this gate.',
        ],
  })

  gates.push({
    id: 'exposureMetric',
    status:
      inputs.exposureCoverage >= MIN_COVERAGE
        ? 'PASS'
        : inputs.exposureCoverage > 0
          ? 'PASS_WITH_LIMITATIONS'
          : 'FAIL',
    summary: `Metric A computable for ${(inputs.exposureCoverage * 100).toFixed(1)}% of stops in the area.`,
    evidence: [
      'Requires published ridership, scheduled service and a temperature at the stop.',
      'Reported in °C·rider-minutes with an uncertainty interval across the documented parameter grid.',
    ],
  })

  gates.push({
    id: 'anomalyMetric',
    status: !inputs.sufficientHoldouts
      ? 'NOT_AVAILABLE'
      : inputs.anomalyValidation === 'PERSISTENT'
        ? 'PASS'
        : inputs.anomalyValidation === 'WEAK'
          ? 'PASS_WITH_LIMITATIONS'
          : inputs.anomalyValidation === 'INSUFFICIENT_DATA'
            ? 'NOT_AVAILABLE'
            : 'FAIL',
    summary:
      `Metric B computable for ${(inputs.anomalyCoverage * 100).toFixed(1)}% of stops; ` +
      `out-of-sample validation: ${inputs.anomalyValidation}.`,
    evidence: [
      'Robust local z-score against a median/MAD background, cell excluded from its own background.',
      'Validated by holding out snapshots: a real anomaly persists across the afternoon, noise does not.',
    ],
  })

  gates.push({
    id: 'interventionFeasibility',
    status: 'NOT_AVAILABLE',
    summary: 'No right-of-way, utility or construction dataset is loaded, so no buildability claim is made.',
    evidence: ['Neither metric has a feasibility or cost term.'],
  })

  return gates
}

/**
 * Which metrics a mode is allowed to use.
 *
 * The mode name and the axis set are the same fact stated twice, so they are
 * derived from one table. Everything downstream — selection, the Pareto sweep,
 * the robustness split, the interface, the export — reads the axis set rather
 * than switching on the name, because a `switch` that forgets a case fails open.
 */
export interface AxisPermission {
  exposure: boolean
  anomaly: boolean
}

export const AXES_FOR_MODE: Record<ProductMode, AxisPermission> = {
  HEAT_EXPOSURE_AND_ANOMALY: { exposure: true, anomaly: true },
  EXPOSURE_ONLY: { exposure: true, anomaly: false },
  ANOMALY_ONLY: { exposure: false, anomaly: true },
  NO_GO_THERMAL_PRODUCT: { exposure: false, anomaly: false },
}

/** Is `requested` a subset of what `permitted` allows? */
function isNarrowerOrEqual(requested: ProductMode, permitted: ProductMode): boolean {
  const want = AXES_FOR_MODE[requested]
  const have = AXES_FOR_MODE[permitted]
  return (!want.exposure || have.exposure) && (!want.anomaly || have.anomaly)
}

export interface ModeResolution {
  /** The most the evidence supports. Computed from the gates, from nothing else. */
  evidenceMode: ProductMode
  /** What configuration asked for. */
  requestedMode: ProductMode | 'auto'
  /** What the run actually is: never wider than the evidence. */
  mode: ProductMode
  /** Metrics this run may use. Read by selection, the UI and the export. */
  axes: AxisPermission
  /** True when configuration narrowed the product below the evidence. */
  downgraded: boolean
  /** True when configuration asked for more than the evidence supports. */
  promotionRefused: boolean
  /** Why each axis is unavailable. Empty when both are. */
  blockingReasons: string[]
  rationale: string[]
}

/**
 * The effective mode: `min(evidence, configuration)`.
 *
 * The previous version returned `PRODUCT_MODE` verbatim before looking at a
 * single gate, so an environment variable could name `HEAT_EXPOSURE_AND_ANOMALY`
 * on a run whose capability was unconfirmed and whose anomaly had never been
 * validated, and the product would say so. The variable is now a request for a
 * **narrower** product, honoured only when its axes are a subset of the ones the
 * evidence permits. A request for more is refused, loudly, and the evidence mode
 * stands.
 *
 * There is no path through this function that widens anything.
 */
export function resolveProductMode(inputs: GateInputs): ModeResolution {
  const evidence = evidenceMode(inputs)
  const requested = inputs.forcedMode ?? 'auto'
  const rationale = [...evidence.rationale]

  if (requested === 'auto') {
    return {
      evidenceMode: evidence.mode,
      requestedMode: requested,
      mode: evidence.mode,
      axes: AXES_FOR_MODE[evidence.mode],
      downgraded: false,
      promotionRefused: false,
      blockingReasons: evidence.blockingReasons,
      rationale,
    }
  }

  if (!isNarrowerOrEqual(requested, evidence.mode)) {
    rationale.push(
      `PRODUCT_MODE asked for ${requested}, which uses an axis the evidence does not support ` +
        `(the evidence permits ${evidence.mode}). Configuration may narrow this product and may ` +
        'never widen it, so the request was refused and the evidence mode stands.',
    )
    return {
      evidenceMode: evidence.mode,
      requestedMode: requested,
      mode: evidence.mode,
      axes: AXES_FOR_MODE[evidence.mode],
      downgraded: false,
      promotionRefused: true,
      blockingReasons: evidence.blockingReasons,
      rationale,
    }
  }

  const downgraded = requested !== evidence.mode
  if (downgraded) {
    rationale.push(
      `PRODUCT_MODE narrowed this run from ${evidence.mode} to ${requested}. A narrower product ` +
        'than the evidence supports is always allowed.',
    )
  }
  return {
    evidenceMode: evidence.mode,
    requestedMode: requested,
    mode: requested,
    axes: AXES_FOR_MODE[requested],
    downgraded,
    promotionRefused: false,
    blockingReasons: evidence.blockingReasons,
    rationale,
  }
}

/**
 * The most this run's evidence supports. Configuration is not consulted.
 *
 * Kept separate from `resolveProductMode` so that "what the data permits" is a
 * function of the data alone and can be asserted as such.
 */
function evidenceMode(inputs: GateInputs): {
  mode: ProductMode
  rationale: string[]
  blockingReasons: string[]
} {
  const rationale: string[] = []
  const blockingReasons: string[] = []

  const thermalUsable =
    inputs.thermalGate.outcome === 'GO_THERMAL_SIGNAL' ||
    inputs.thermalGate.outcome === 'GO_CONDITIONAL_FACTOR_ONLY'

  // A failed discrimination gate ends the product, but it does not end the
  // report. Returning here meant the run named one reason and silently dropped
  // every other one — so an operator fixing the discrimination problem would
  // discover the unconfirmed capability only on the next attempt. Every
  // blocking reason is accumulated and all of them are reported.
  const thermalSignalBlocked = inputs.liveSignalObtained && !thermalUsable
  if (thermalSignalBlocked) {
    blockingReasons.push(
      'Thermal signal: a live FortyGuard signal was obtained but failed the discrimination gate ' +
        `(${inputs.thermalGate.outcome}), so no thermal product is claimed whatever else holds.`,
    )
  }

  /* ------------------------------- exposure ------------------------------ */
  if (inputs.exposureCoverage < MIN_COVERAGE) {
    blockingReasons.push(
      `Exposure: computable for ${(inputs.exposureCoverage * 100).toFixed(1)}% of stops, below ` +
        `the ${MIN_COVERAGE * 100}% floor.`,
    )
  }
  if (!inputs.capabilityConfirmed) {
    blockingReasons.push(
      'Exposure: the capability probe has not confirmed the value field, that the field holds a ' +
        'temperature, the literal Celsius unit and an applied timezone strategy. The excess above ' +
        'a reference temperature is therefore not a quantity, so exposure is excluded from ' +
        'selection entirely — not merely printed without a unit.',
    )
  }
  const exposureOk =
    !thermalSignalBlocked && inputs.exposureCoverage >= MIN_COVERAGE && inputs.capabilityConfirmed

  /* -------------------------------- anomaly ------------------------------ */
  if (inputs.anomalyCoverage < MIN_COVERAGE) {
    blockingReasons.push(
      `Anomaly: computable for ${(inputs.anomalyCoverage * 100).toFixed(1)}% of stops, below the ` +
        `${MIN_COVERAGE * 100}% floor.`,
    )
  }
  if (inputs.anomalyValidation === 'NOT_PERSISTENT') {
    blockingReasons.push(
      'Anomaly: at least one held-out snapshot contradicted the fit, so the anomaly is excluded ' +
        'from selection.',
    )
  }
  if (!inputs.sufficientHoldouts) {
    blockingReasons.push(
      'Anomaly: too few held-out snapshots agreed with the fit to validate it out of sample, so ' +
        'the anomaly is excluded from selection. It is not merely reported with a caveat — an ' +
        'unvalidated axis that still moves the ranking is an unvalidated ranking.',
    )
  }
  if (!inputs.anomalyFieldConfirmed) {
    blockingReasons.push(
      'Anomaly: the capability probe has not confirmed which property carries the value, or that ' +
        'the property holds a temperature. A robust z-score is scale-free and would compute ' +
        'perfectly well over an arbitrary numeric field — and would then be reported as a local ' +
        'HEAT anomaly. Scale-invariance is not evidence that the data is heat, so the axis is ' +
        'excluded.',
    )
  }
  const anomalyOk =
    !thermalSignalBlocked &&
    inputs.anomalyCoverage >= MIN_COVERAGE &&
    inputs.anomalyValidation !== 'NOT_PERSISTENT' &&
    inputs.sufficientHoldouts &&
    inputs.anomalyFieldConfirmed

  if (exposureOk && anomalyOk) {
    rationale.push(
      'Both metrics are independently computable and the anomaly persists out of sample, so both axes are reported.',
    )
    rationale.push(
      'Shelter inventory remains unavailable, so the product prioritises study and inspection, never installation.',
    )
    return { mode: 'HEAT_EXPOSURE_AND_ANOMALY', rationale, blockingReasons }
  }
  if (exposureOk) {
    rationale.push(
      'The local anomaly could not be established, so only exposure is reported. It is the sole ' +
        'ranking axis: there is no Pareto structure with one objective, and the anomaly does not ' +
        'enter the ordering, the tiebreak or the quadrants.',
    )
    return { mode: 'EXPOSURE_ONLY', rationale, blockingReasons }
  }
  if (anomalyOk) {
    rationale.push(
      'Ridership, schedule coverage or the capability confirmation is insufficient for an ' +
        'exposure estimate, so only the anomaly is reported and it is the sole ranking axis.',
    )
    return { mode: 'ANOMALY_ONLY', rationale, blockingReasons }
  }

  rationale.push(
    'Neither metric is usable, so this run offers NO ranked recommendation. Stops are still ' +
      'described, and analyst pins are still honoured as instructions, but nothing here is a ' +
      'priority produced by the engine.',
  )
  if (thermalSignalBlocked) {
    rationale.push(
      'The thermal layer did not discriminate between places, which alone is enough to withdraw ' +
        'the product; the other reasons above are reported so they can be fixed together rather ' +
        'than one per attempt.',
    )
  }
  return { mode: 'NO_GO_THERMAL_PRODUCT', rationale, blockingReasons }
}

/** Backwards-compatible wrapper. Prefer `resolveProductMode`. */
export function selectProductMode(inputs: GateInputs): { mode: ProductMode; rationale: string[] } {
  const resolved = resolveProductMode(inputs)
  return { mode: resolved.mode, rationale: resolved.rationale }
}

export function buildProductManifest(inputs: GateInputs, selectedAt: string): ProductManifest {
  const gateDetail = evaluateGates(inputs)
  const resolution = resolveProductMode(inputs)
  const { mode, rationale } = resolution

  const { allowed, blocked } = resolveAllowedClaims({
    hasRealThermalSignal:
      inputs.dataMode === 'LIVE_FORTYGUARD' || inputs.dataMode === 'CACHED_REAL_DATA',
    hasShelterInventory: inputs.shelterInventoryAvailable,
    ridershipUnitDocumented: inputs.ridershipDocumented,
    celsiusConfirmed: inputs.capabilityConfirmed && inputs.dataMode !== 'DEMO_SYNTHETIC',
    sufficientHoldouts: inputs.sufficientHoldouts,
  })

  const gates: Record<string, ProductManifest['gates'][string]> = {}
  for (const gate of gateDetail) gates[gate.id] = gate.status

  return {
    mode,
    evidenceMode: resolution.evidenceMode,
    requestedMode: resolution.requestedMode,
    downgraded: resolution.downgraded,
    promotionRefused: resolution.promotionRefused,
    axes: resolution.axes,
    blockingReasons: resolution.blockingReasons,
    dataMode: inputs.dataMode,
    selectedAt,
    gates,
    gateDetail,
    claimsAllowed: allowed,
    claimsBlocked: blocked,
    rationale,
  }
}

/** The ShadeFirst name stays unreachable while the inventory gate fails. */
export function shadeFirstBrandingPermitted(manifest: ProductManifest): boolean {
  return manifest.gates.shelterInventory === 'PASS'
}
