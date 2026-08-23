/**
 * Shared domain vocabulary.
 *
 * The types encode the project's data-honesty rules structurally, so a violation
 * is a type error rather than a review comment. Two examples: `shelterStatus` is
 * a tri-state with no `unsheltered` member reachable from a null amenity field,
 * and every published quantity carries its own unit and provenance rather than
 * travelling as a bare number.
 *
 * The decision unit is the **stop**. An earlier version ranked 500 m grid cells
 * of this project's own construction; a stop is what a planner actually inspects,
 * and it removes an invented spatial abstraction from the product.
 */

export type Provenance = 'REAL' | 'DERIVED' | 'PROXY' | 'SYNTHETIC' | 'UNKNOWN'

export type DataMode =
  | 'LIVE_FORTYGUARD'
  | 'CACHED_REAL_DATA'
  | 'DEMO_SYNTHETIC'
  | 'BLOCKED_LIVE'

export type ConfidenceBand = 'high' | 'medium' | 'low' | 'unknown'

/* -------------------------------------------------------------------------- */
/* Transit stops                                                              */
/* -------------------------------------------------------------------------- */

/**
 * No `'unsheltered'` member exists. No public source tested here can support
 * that classification, and a null amenity field must never become a negative
 * claim.
 */
export type ShelterStatus = 'unknown' | 'sheltered_confirmed' | 'survey_required'

/** Average daily riders per day category, for one fiscal quarter. */
export interface QuarterRidership {
  weekday: number | null
  weekend: number | null
}

export interface StopRidership {
  /** Fiscal quarter key, e.g. `2024_4` = FY2024 Q4 = Apr–Jun 2024. */
  baseQuarter: string
  /** Every quarter retained, so temporal drift can be a sourced scenario. */
  byQuarter: Record<string, QuarterRidership>
}

/**
 * The three day types analysed separately.
 *
 * Weekend ridership must never be paired with a weekday timetable. Saturday and
 * Sunday are not interchangeable either — in the shipped feed Saturday runs
 * 5,476 trips against Sunday's 4,815 — so both are carried.
 */
export type DayType = 'weekday' | 'saturday' | 'sunday'

export const DAY_TYPES: readonly DayType[] = ['weekday', 'saturday', 'sunday'] as const

/** Which published ridership column a day type draws from. */
export const RIDERSHIP_CATEGORY_FOR_DAY_TYPE: Record<DayType, 'weekday' | 'weekend'> = {
  weekday: 'weekday',
  saturday: 'weekend',
  sunday: 'weekend',
}

export interface DayTypeService {
  dailyDepartures: number
  routeCount: number
  /** Roll-up onto clock hours, for coverage checks only. No wait uses it. */
  hourlyDepartures: number[]
  /**
   * Route name -> sorted scheduled departure **minutes past the start of the
   * service day**.
   *
   * Actual times, not counts. A headway distribution cannot be recovered from
   * departures-per-hour: an even 10-minute service and a bunched pair followed
   * by a 50-minute hole produce the same count and very different waits.
   *
   * Values of 1440 and above are genuine GTFS times of 24:00 or later and denote
   * the small hours still belonging to this service day. They are **not** wrapped
   * in the dataset; the projection onto clock hours is a named assumption
   * applied in `lib/metrics/exposure.ts`.
   */
  routeDepartures: Record<string, number[]>
  /** How many of those departures sit at or past 24:00. */
  departuresAfterMidnight: number
}

export interface StopService {
  /** One timetable per day type. A day type absent here has no service. */
  byDayType: Partial<Record<DayType, DayTypeService>>
}

export interface TransitStop {
  id: number
  code: number | null
  name: string
  description: string
  lat: number
  lon: number
  routes: string[]
  /** Valley Metro published quarterly ridership. Null when the stop has no row. */
  ridership: StopRidership | null
  /** Derived from the official GTFS feed. Null when the stop has no service. */
  service: StopService | null
  /** City of Phoenix `RIDERSHIP`. Undocumented; cross-check only, never computed on. */
  legacyRidershipIndex: number | null
  matchMethod: 'stop_id' | 'stop_code' | 'unmatched'
  shelterStatus: ShelterStatus
}

/** One quarter's result from the executable completeness checks. */
export interface QuarterCompleteness {
  weekdayTotal: number
  stopsReporting: number
  totalRetention: number
  stopRetention: number
  passes: boolean
  failures: string[]
}

export interface CompletenessReport {
  checks: {
    minTotalRetention: number
    minStopRetention: number
    description: string
    whatPassingDoesNotEstablish: string
    /** Structurally false: no published control total reconciles these. */
    independentlyReconciled: false
  }
  quarters: Record<string, QuarterCompleteness>
  latestPassing: string | null
  selected: string
  selectedIsLatestPassing: boolean
}

export interface StopDataset {
  kind: string
  version: number
  generatedAtUtc: string
  generator: string
  provenance: Record<string, unknown> & {
    ridership: { completenessChecks: CompletenessReport } & Record<string, unknown>
  }
  counts: {
    activeStops: number
    withDocumentedRidership: number
    withScheduledService: number
    ridershipCoveragePct: number
    serviceCoveragePct: number
    weekdayRidershipSum: number
    shelterStatusKnown: number
    serviceCoverageByDayType: Record<DayType, number>
  }
  dayTypes: {
    analysed: DayType[]
    ridershipCategory: Record<DayType, 'weekday' | 'weekend'>
    note: string
  }
  bbox: BoundingBox
  stops: TransitStop[]
}

/* -------------------------------------------------------------------------- */
/* Geography                                                                  */
/* -------------------------------------------------------------------------- */

export interface BoundingBox {
  minLon: number
  minLat: number
  maxLon: number
  maxLat: number
}

export interface AreaOfInterest {
  id: string
  label: string
  description: string
  bbox: BoundingBox
  /** Resolution the thermal request and immutable snapshot must agree on. */
  thermalGranularityMeters: 60 | 80 | 100
}

export interface AnalysisTile {
  id: string
  bbox: BoundingBox
  areaSqMi: number
  row: number
  col: number
}

export interface TilePlan {
  aoiId: string
  tiles: AnalysisTile[]
  maxTileSqMi: number
  totalAreaSqMi: number
  aoiAreaSqMi: number
  coversAoi: boolean
}

/* -------------------------------------------------------------------------- */
/* Thermal layer                                                              */
/* -------------------------------------------------------------------------- */

export interface ThermalCell {
  id: string
  centroidLon: number
  centroidLat: number
  ring: Array<[number, number]>
  value: number
  /** `YYYY-MM-DDTHH:MM`. */
  snapshot: string
}

export interface ThermalLayer {
  dataMode: DataMode
  provenance: Provenance
  unit: string | null
  valueField: string | null
  analyticType: string
  granularityMeters: number | null
  snapshots: string[]
  timezone: string
  cells: ThermalCell[]
  label: string
  sourceNotes: string[]
}

/* -------------------------------------------------------------------------- */
/* Results                                                                    */
/* -------------------------------------------------------------------------- */

export type Quadrant = 'BOTH_HIGH' | 'EXPOSURE_DRIVEN' | 'ANOMALY_DRIVEN' | 'NEITHER'

/** One stop, with both metrics reported separately and never blended. */
export interface StopResult {
  stop: TransitStop
  /**
   * Metric A as **used by this run** — null when the product gates excluded the
   * exposure axis. A number excluded from selection but still printed in the
   * ranking column is a number the reader ranks on anyway.
   */
  exposure: number | null
  /** Metric A as computed, whether or not this run was allowed to use it. */
  exposureObserved: number | null
  exposurePercentile: number | null
  /**
   * Spread across the full scenario cross product. An **envelope over stated
   * assumptions**, not a confidence interval — nothing here is a sampling
   * distribution.
   */
  envelopeLow: number | null
  envelopeHigh: number | null
  envelopeSpreadRatio: number | null
  /** Scenarios this stop could actually be evaluated under. */
  scenariosEvaluated: number
  /** Offered minus evaluated — scenarios naming data this stop does not have. */
  scenariosUnavailable: number
  /** Quarters with no published figure for this stop and day type. */
  quartersUnavailable: string[]
  /** Analysed hours that received a temperature here, and how many were asked for. */
  thermalHoursCovered: number
  thermalHoursAnalysed: number
  /** ESEL is produced only when every analysed hour has a temperature. */
  thermalCoverageComplete: boolean
  /** Share of *evaluable* scenarios in which this stop was selected. */
  scenarioSelectionRate: number
  /** The same figure as a count — the selection frequency. */
  scenarioSelectionCount: number
  /** The denominator behind that count: scenarios this stop could be evaluated under. */
  scenarioCount: number
  /** Size of the full cross product, for context. */
  scenariosOffered: number
  /**
   * Best and worst rank the stop takes across the scenarios in which it is
   * selected. Null when no scenario selects it. A narrow range means the
   * position itself is stable, which a selection frequency alone cannot say.
   */
  scenarioRankBest: number | null
  scenarioRankWorst: number | null
  /** Placed by the analyst rather than by the ranking. Carries no robustness claim. */
  pinned: boolean
  /** True unless the stop is evaluable everywhere and selected everywhere. */
  assumptionSensitive: boolean
  /**
   * Settings that drop it **on their own**, e.g. `waitCap=cap_5`. One-at-a-time
   * attribution: a dimension appears only when changing that single setting away
   * from the base removes the candidate.
   */
  sensitiveTo: string[]
  /** True when only combinations of settings drop it, never one alone. */
  droppedByCombinationOnly: boolean
  /** Metric B as **used by this run** — null when the gates excluded the axis. */
  anomalyZ: number | null
  /** Metric B as computed, whether or not this run was allowed to use it. */
  anomalyZObserved: number | null
  /** Snapshots that actually scored this stop. The per-stop denominator. */
  anomalyObservations: number
  /** Why this stop carries no anomaly. Null when it carries one. */
  anomalyIneligibleReason: string | null
  anomalyPercentile: number | null
  /** Local background the stop is compared against, °C. */
  backgroundC: number | null
  quadrant: Quadrant | null
  paretoFront: number | null
  /** Per-hour decomposition of metric A. */
  hourly: Array<{
    hour: number
    riders: number
    waitMinutes: number | null
    temperatureC: number | null
    excessC: number | null
    exposure: number | null
  }>
  /** Per-snapshot anomaly, for the hourly profile. */
  anomalyBySnapshot: Array<{ snapshot: string; z: number | null; value: number | null }>
  ridersInWindow: number
  /** The published daily total the allocation was drawn from. */
  publishedDailyRiders: number | null
  /** Σ riders(h) over all 24 hours — must equal `publishedDailyRiders`. */
  ridersAllocatedAcrossDay: number | null
  meanWaitMinutes: number | null
  meanExcessC: number | null
  confidence: {
    band: ConfidenceBand
    score: number
    components: Record<string, number>
    reasons: string[]
  }
  missing: string[]
  complete: boolean
}

export interface PlanEntry {
  rank: number
  candidateId: string
  selected: boolean
  reasonCode: string
  reason: string
}

export interface RunRequest {
  aoiId: string
  capacity: number
  analysisDate: string
  /** Distinct whole clock hours, `HH:00`. Validated in `lib/agent/request.ts`. */
  snapshotTimes: string[]
  dayType: DayType
  excludedIds?: string[]
  includedIds?: string[]
}

/* -------------------------------------------------------------------------- */
/* Gates, orchestration                                                       */
/* -------------------------------------------------------------------------- */

export type GateStatus =
  | 'PASS'
  | 'PASS_WITH_LIMITATIONS'
  | 'PASS_FIXTURE'
  | 'BLOCKED_LIVE'
  | 'NOT_AVAILABLE'
  | 'FAIL'

export type ProductMode =
  | 'HEAT_EXPOSURE_AND_ANOMALY'
  | 'EXPOSURE_ONLY'
  | 'ANOMALY_ONLY'
  | 'NO_GO_THERMAL_PRODUCT'

export interface GateResult {
  id: string
  status: GateStatus
  summary: string
  evidence: string[]
}

export interface ProductManifest {
  /** The effective mode: never wider than `evidenceMode`. */
  mode: ProductMode
  /** The most this run's evidence supports, computed from the gates alone. */
  evidenceMode: ProductMode
  /** What `PRODUCT_MODE` asked for. */
  requestedMode: ProductMode | 'auto'
  /** Configuration narrowed the product below the evidence. Always permitted. */
  downgraded: boolean
  /** Configuration asked for a wider product than the evidence. Never permitted. */
  promotionRefused: boolean
  /**
   * The metrics this run may use.
   *
   * Read by selection, the Pareto sweep, the robustness split, the interface and
   * the export, so an excluded axis cannot reach a ranking through a code path
   * that forgot to check the mode name.
   */
  axes: { exposure: boolean; anomaly: boolean }
  /** Why each unavailable axis is unavailable. */
  blockingReasons: string[]
  dataMode: DataMode
  selectedAt: string
  gates: Record<string, GateStatus>
  gateDetail: GateResult[]
  claimsAllowed: string[]
  claimsBlocked: string[]
  rationale: string[]
}

export type RunState =
  | 'created'
  | 'validating'
  | 'tiling'
  | 'submitted'
  | 'polling'
  | 'normalizing'
  | 'quality_gate'
  | 'scoring'
  | 'awaiting_approval'
  | 'approved'
  | 'exported'
  | 'blocked'
  | 'failed'
  | 'cancelled'

export interface AuditEvent {
  timestamp: string
  runId: string
  sequence: number
  step: RunState
  inputSummary: string
  outputSummary: string
  decision: string
  source: string
  hash: string | null
  error: string | null
}

export interface RunResult {
  runId: string
  state: RunState
  createdAt: string
  request: RunRequest
  manifest: ProductManifest
  aoi: AreaOfInterest
  tilePlan: TilePlan
  thermal: Omit<ThermalLayer, 'cells'> & { cellCount: number }
  /** Cells kept for the map heat layer, with their anomaly z. */
  heatCells: Array<{
    lon: number
    lat: number
    ring: Array<[number, number]>
    value: number
    z: number | null
  }>
  results: StopResult[]
  plan: {
    capacity: number
    entries: PlanEntry[]
    selectedIds: string[]
    /** The result, in one line: "N robust priorities + M assumption-dependent candidates". */
    headline: string
    /** Evaluable in every scenario in the envelope, and selected in every one. */
    robustIds: string[]
    /** Selected in the base run, but not robust. */
    assumptionDependentIds: string[]
    /** Placed by the analyst. Counted in neither of the two above. */
    pinnedIds: string[]
    /** The metrics the ranking was allowed to use. */
    axesUsed: { exposure: boolean; anomaly: boolean }
    /**
     * Whether the scenario envelope was re-selected at all.
     *
     * False when the exposure axis is excluded: the envelope varies only the
     * exposure model, so every scenario would return the same ranking and every
     * candidate would be reported as robust under all of them.
     */
    scenarioSweepApplies: boolean
    scenarioCount: number
    robustRule: string
    quadrantCounts: Record<Quadrant, number>
    incompleteIds: string[]
    minimumSeparationMeters: number
    requestedSeparationMeters: number
    frontsUsed: number
    notes: string[]
  }
  methodology: {
    exposure: {
      /** The public name of metric A. */
      name: string
      formula: string
      ridersFormula: string
      waitFormula: string
      /** Exactly what a wait cap does, in one sentence. */
      waitCapRule: string
      /**
       * The unit of T, as resolved for THIS run. `°C (synthetic)` for the
       * fixture, the documented unit once a probe confirms it, and
       * `unconfirmed unit` otherwise. Every UI surface and export column reads
       * this rather than spelling a unit itself.
       */
      thermalUnitLabel: string
      /** Compact load unit for dense surfaces, e.g. `°C (synthetic)·rider-min`. */
      loadUnitShort: string
      unit: string
      /** False until the capability probe confirms the value field AND the unit. */
      celsiusReadingPermitted: boolean
      capabilityStatement: string
      /** Structurally false: nothing in this metric is measured. */
      isMeasurement: false
      quantityCaveat: string
      referenceTemperatureC: number
      referenceTemperatureSource: string
      waitCap: string
      routeChoice: string
      demandProfile: string
      dayType: DayType
      ridershipCategory: 'weekday' | 'weekend'
      dayTypeRule: string
      ridershipQuarter: string
      ridershipQuarterLabel: string
      ridershipQuarterSelection: string
      periodMismatch: string
      assumptions: ReadonlyArray<{
        id: string
        text: string
        falsifiedBy: string
        scenarioDimension: string | null
      }>
    }
    scenarioEnvelope: {
      description: string
      /** False when the sweep does not apply, e.g. a run that excludes exposure. */
      applied: boolean
      /** Scenarios actually re-selected. Zero when the sweep does not apply. */
      scenarioCount: number
      scenariosOffered: number
      dimensions: Record<string, readonly (string | number)[]>
      base: Record<string, string | number>
      assumptionSensitiveRule: string
    }
    anomaly: {
      formula: string
      radiusMeters: number
      minNeighbours: number
      leaveOneOut: true
      validation: {
        fitSnapshot: string
        holdoutSnapshots: string[]
        /**
         * Each holdout scored on its own, before anything was combined.
         *
         * The aggregate below is the **weakest** of these, not a mean. One
         * perfectly aligned holdout and one fully inverted holdout must not
         * average into a pass.
         */
        perHoldout: Array<{
          snapshot: string
          comparedCells: number
          rankCorrelation: number | null
          topDecileRetention: number | null
          verdict: string
          failureReason: string | null
        }>
        /** The weakest holdout's denominator, not the largest. */
        comparedCells: number
        rankCorrelation: number | null
        topDecileRetention: number | null
        topDecileChanceLevel: number
        verdict: string
        scope: string
        statement: string
        failureReasons: string[]
        minimumSnapshotsPerStop: number
        /** Stops with too few scored snapshots to carry an anomaly at all. */
        stopsWithoutSufficientObservations: number
      }
    }
    selection: {
      /** Names the axes this run actually ranked on, not the two-axis rule. */
      rule: string
      axesUsed: { exposure: boolean; anomaly: boolean }
      minSeparationMeters: number
      weightsUsed: false
    }
  }
  audit: AuditEvent[]
  /**
   * Present only on a finalized run.
   *
   * Deliberately not called an approval: there is no authentication anywhere in
   * this product, so the name is unverified by construction.
   */
  attestation?: {
    attestedBy: string
    attestedAtUtc: string
    runId: string
    /**
     * Digest of the audit trail exactly as it stood when the plan was reviewed.
     *
     * Binds the name to a specific sequence of records rather than to a run id
     * alone, and makes a regenerated prefix visible: a second export that
     * rebuilt the trail would carry a different digest here.
     */
    reviewedAuditSha256: string
    kind: 'named_self_attestation'
    caveat: string
  }
  datasetProvenance: {
    stopsSha256: string
    /** Digest with `generatedAtUtc` removed — the value a rebuild reproduces. */
    stopsCanonicalSha256: string
    stopCount: number
    generatedAtUtc: string
    ridershipCoveragePct: number
    serviceCoveragePct: number
    serviceCoverageByDayType: Record<DayType, number>
    /** Executable quarter checks, regenerated on every dataset build. */
    completeness: CompletenessReport
  }
  /**
   * What `DATA_MODE` actually resolved to, and what the values therefore are.
   *
   * `auto` names a preference, not an outcome. Without this, a run that asked for
   * `auto`, found no servable capture and fell back to the fixture reported the
   * same `DATA_MODE` as one that served a real snapshot.
   */
  dataResolution: {
    configured: 'auto' | 'cached_real' | 'demo'
    resolved: 'cached_real' | 'demo'
    dataMode: DataMode
    provenance: Provenance
    isSynthetic: boolean
    unitConfirmed: boolean
    unitLabel: string
    valuesAre: 'synthetic' | 'real, unit confirmed' | 'real, unit unconfirmed'
    snapshotAttestationSha256: string | null
    /** Committed snapshots that exist but cannot be served, and why. */
    rejectedSnapshots: Array<{ file: string; reasons: string[] }>
  }
  /**
   * The thermal civil date and the GTFS service day, kept apart.
   *
   * They are two different things, and the small hours are where they come
   * apart: a `24:30` departure is on the service day that began the previous
   * morning and occurs on this civil date.
   */
  serviceDayResolution: {
    thermalCivilDate: string
    analysedServiceDay: DayType
    precedingCivilDate: string
    precedingServiceDay: DayType
    /** Whether the preceding pattern came from the date or from a fallback. */
    precedingDerivedFrom: string
    rule: string
  }
  /** How the analysed day type relates to the analysis date. */
  dayTypeResolution: {
    analysisDate: string
    dateFallsOn: DayType
    analysed: DayType
    /** False makes this run a labelled counterfactual, not a description of that day. */
    matchesDate: boolean
    rule: string
  }
  /** How much of the analysed thermal window actually arrived. */
  thermalCoverage: {
    analysedHours: number[]
    stopsTotal: number
    stopsWithAnyHour: number
    stopsWithEveryHour: number
    stopsWithPartialCoverage: number
    /** Stops for which some scenario names a quarter the source does not publish. */
    stopsMissingAQuarter: number
    rule: string
  }
  limitations: string[]
}
