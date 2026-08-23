import type { RunResult } from '@/lib/types'
import { toCsv, withCsvPreamble } from './csv'
import { ANALYSIS_TIMEZONE, TIMEZONE_ASSUMPTION } from '@/lib/agent/request'
import { ENGINE_VERSION } from '@/lib/agent/run'

/**
 * Exports carry the inputs, both metrics, their assumptions, the validation
 * result and the limitations. An export that dropped its caveats would be the
 * easiest way for a careful product to become a misleading one.
 */

const EXPORT_COLUMNS = [
  'rank',
  'selected',
  'stop_id',
  'stop_name',
  'routes',
  'scenario_exposure_load',
  'envelope_low',
  'envelope_high',
  'envelope_spread_ratio',
  'robustness',
  'scenario_selection_count',
  'scenario_count_evaluable',
  'scenario_count_offered',
  'scenarios_unavailable',
  'quarters_unavailable',
  'scenario_selection_rate',
  'scenario_rank_best',
  'scenario_rank_worst',
  'assumption_sensitive',
  'sensitive_to',
  'dropped_by_combination_only',
  'exposure_percentile',
  // Two columns, because they are two different facts. `anomaly_z_sigma` is what
  // this run *used*; it is empty when the gates excluded the axis.
  // `anomaly_z_observed` is the measurement, present either way, so nothing is
  // hidden — it is only kept out of the column a reader would rank on.
  'anomaly_z_sigma',
  'anomaly_z_observed',
  'anomaly_observations',
  'anomaly_ineligible_reason',
  'anomaly_percentile',
  'local_background',
  'quadrant',
  'pareto_front',
  'riders_in_window',
  'mean_wait_minutes',
  'mean_excess',
  'ridership_day_avg',
  'ridership_day_category',
  'ridership_quarter',
  'day_type',
  'scheduled_departures_per_day',
  'route_count',
  'thermal_hours_covered',
  'thermal_hours_analysed',
  'confidence_band',
  'confidence_score',
  'selection_reason_code',
  'selection_reason',
  'shelter_status',
  'lat',
  'lon',
] as const

export function planPreamble(run: RunResult): Record<string, unknown> {
  const exposure = run.methodology.exposure
  const anomaly = run.methodology.anomaly
  return {
    product: 'Heat Priority Engine — Phoenix Transit Heat Exposure & Anomaly',
    engine_version: ENGINE_VERSION,
    run_id: run.runId,
    // When the FILE was written, not when anything in it happened. Named to
    // match the JSON export, which had the same problem.
    artefact_written_at_utc: new Date().toISOString(),
    attested_at_utc: run.attestation?.attestedAtUtc ?? '(not attested)',
    // The effective mode and how it was arrived at. `product_mode` alone could
    // not distinguish "the evidence supports this" from "an environment variable
    // said so", which were different facts with the same name.
    product_mode: run.manifest.mode,
    product_mode_permitted_by_evidence: run.manifest.evidenceMode,
    product_mode_requested: run.manifest.requestedMode,
    product_mode_narrowed_by_configuration: run.manifest.downgraded,
    product_mode_promotion_refused: run.manifest.promotionRefused,
    axes_used: [
      run.manifest.axes.exposure ? 'exposure' : null,
      run.manifest.axes.anomaly ? 'anomaly' : null,
    ]
      .filter(Boolean)
      .join(' ') || 'none',
    blocking_reasons: run.manifest.blockingReasons.join(' | ') || 'none',
    gate_results: run.manifest.gateDetail
      .map((gate) => `${gate.id}=${gate.status}`)
      .join(' '),
    data_mode: run.manifest.dataMode,
    data_mode_configured: run.dataResolution.configured,
    data_mode_resolved: run.dataResolution.resolved,
    values_are: run.dataResolution.valuesAre,
    thermal_provenance: run.thermal.provenance,
    // The unit is resolved per run and named once. Column headers deliberately
    // carry no unit: `..._c` would assert Celsius on a layer that may not be.
    thermal_unit: run.methodology.exposure.thermalUnitLabel,
    scenario_exposure_load_unit: run.methodology.exposure.unit,
    celsius_reading_permitted: run.methodology.exposure.celsiusReadingPermitted,
    thermal_value_field: run.thermal.valueField ?? 'unresolved',
    area_of_interest: `${run.aoi.label} (${run.aoi.id})`,
    analysis_date: run.request.analysisDate,
    snapshot_times: run.request.snapshotTimes.join(' '),
    day_category: run.methodology.exposure.ridershipCategory,
    timezone: ANALYSIS_TIMEZONE,
    timezone_assumption: TIMEZONE_ASSUMPTION,
    capacity: run.plan.capacity,
    result: run.plan.headline,
    robust_rule: run.plan.robustRule,
    robust_count: run.plan.robustIds.length,
    assumption_dependent_count: run.plan.assumptionDependentIds.length,
    scenario_count: run.plan.scenarioCount,
    exposure_metric: exposure.name,
    exposure_formula: exposure.formula,
    exposure_unit: exposure.unit,
    exposure_is_measurement: exposure.isMeasurement,
    exposure_quantity_caveat: exposure.quantityCaveat,
    exposure_wait_formula: exposure.waitFormula,
    exposure_wait_cap_rule: exposure.waitCapRule,
    exposure_reference_temperature: exposure.referenceTemperatureC,
    exposure_capability_statement: exposure.capabilityStatement,
    exposure_wait_cap: exposure.waitCap,
    exposure_route_choice: exposure.routeChoice,
    exposure_ridership_quarter: exposure.ridershipQuarter,
    exposure_assumptions: exposure.assumptions.map((a) => `${a.id}: ${a.text}`).join(' | '),
    anomaly_formula: anomaly.formula,
    anomaly_radius_m: anomaly.radiusMeters,
    anomaly_leave_one_out: anomaly.leaveOneOut,
    anomaly_validation_verdict: anomaly.validation.verdict,
    anomaly_validation_rank_correlation: anomaly.validation.rankCorrelation ?? 'n/a',
    anomaly_validation_top_decile_retention: anomaly.validation.topDecileRetention ?? 'n/a',
    anomaly_validation_chance_level: anomaly.validation.topDecileChanceLevel,
    attested_by: run.attestation?.attestedBy ?? '(not attested)',
    attestation_kind: run.attestation?.kind ?? 'none',
    attestation_run_id: run.attestation?.runId ?? '',
    attestation_caveat:
      run.attestation?.caveat ??
      'This export was not attested. Nothing here is an authenticated approval.',
    selection_rule: run.methodology.selection.rule,
    // Said "Pareto layering over two separate metrics" on every run, including
    // the ones that used one metric or none.
    selection_weights_used: 'none',
    scenario_sweep_applied: run.plan.scenarioSweepApplies,
    scenario_count_swept: run.methodology.scenarioEnvelope.scenarioCount,
    scenario_count_offered: run.methodology.scenarioEnvelope.scenariosOffered,
    reviewed_audit_sha256: run.attestation?.reviewedAuditSha256 ?? '(not attested)',
    minimum_separation_m: run.plan.minimumSeparationMeters,
    stops_dataset_sha256: run.datasetProvenance.stopsSha256,
    stop_count: run.datasetProvenance.stopCount,
    ridership_coverage_pct: run.datasetProvenance.ridershipCoveragePct,
    service_coverage_pct: run.datasetProvenance.serviceCoveragePct,
    limitations: run.limitations.join(' | '),
  }
}

export function buildPlanRows(run: RunResult): Array<Record<string, unknown>> {
  const resultById = new Map(run.results.map((entry) => [String(entry.stop.id), entry]))

  return run.plan.entries.map((entry) => {
    const result = resultById.get(entry.candidateId)
    const stop = result?.stop

    return {
      rank: entry.rank,
      selected: entry.selected ? 'yes' : 'no',
      stop_id: entry.candidateId,
      stop_name: stop?.name ?? '',
      routes: stop?.routes.join(' ') ?? '',
      scenario_exposure_load: result?.exposure ?? '',
      envelope_low: result?.envelopeLow ?? '',
      envelope_high: result?.envelopeHigh ?? '',
      envelope_spread_ratio: result?.envelopeSpreadRatio ?? '',
      robustness: entry.selected
        ? result?.pinned
          ? 'analyst_pinned'
          : result?.assumptionSensitive
            ? 'assumption_dependent'
            : 'robust'
        : '',
      scenario_selection_count: result?.pinned ? '' : (result?.scenarioSelectionCount ?? ''),
      scenario_count_evaluable: result?.pinned ? '' : (result?.scenarioCount ?? ''),
      scenario_count_offered: result?.scenariosOffered ?? '',
      scenarios_unavailable: result?.scenariosUnavailable ?? '',
      quarters_unavailable: result?.quartersUnavailable.join(' ') ?? '',
      scenario_selection_rate: result?.pinned ? '' : (result?.scenarioSelectionRate ?? ''),
      scenario_rank_best: result?.scenarioRankBest ?? '',
      scenario_rank_worst: result?.scenarioRankWorst ?? '',
      assumption_sensitive: result?.assumptionSensitive ? 'yes' : 'no',
      sensitive_to: result?.sensitiveTo.join(' ') ?? '',
      dropped_by_combination_only: result?.droppedByCombinationOnly ? 'yes' : 'no',
      exposure_percentile: result?.exposurePercentile ?? '',
      anomaly_z_sigma: result?.anomalyZ ?? '',
      anomaly_z_observed: result?.anomalyZObserved ?? '',
      anomaly_observations: result?.anomalyObservations ?? '',
      anomaly_ineligible_reason: result?.anomalyIneligibleReason ?? '',
      anomaly_percentile: result?.anomalyPercentile ?? '',
      local_background: result?.backgroundC ?? '',
      quadrant: result?.quadrant ?? '',
      pareto_front: result?.paretoFront ?? '',
      riders_in_window: result?.ridersInWindow ?? '',
      mean_wait_minutes: result?.meanWaitMinutes ?? '',
      mean_excess: result?.meanExcessC ?? '',
      ridership_day_avg:
        run.methodology.exposure.ridershipCategory === 'weekday'
          ? (stop?.ridership?.byQuarter[run.methodology.exposure.ridershipQuarter]?.weekday ?? '')
          : (stop?.ridership?.byQuarter[run.methodology.exposure.ridershipQuarter]?.weekend ?? ''),
      ridership_day_category: run.methodology.exposure.ridershipCategory,
      ridership_quarter: run.methodology.exposure.ridershipQuarterLabel,
      day_type: run.methodology.exposure.dayType,
      scheduled_departures_per_day:
        stop?.service?.byDayType?.[run.methodology.exposure.dayType]?.dailyDepartures ?? '',
      route_count: stop?.service?.byDayType?.[run.methodology.exposure.dayType]?.routeCount ?? '',
      thermal_hours_covered: result?.thermalHoursCovered ?? '',
      thermal_hours_analysed: result?.thermalHoursAnalysed ?? '',
      confidence_band: result?.confidence.band ?? '',
      confidence_score: result?.confidence.score ?? '',
      selection_reason_code: entry.reasonCode,
      selection_reason: entry.reason,
      shelter_status: 'unknown',
      lat: stop ? stop.lat.toFixed(6) : '',
      lon: stop ? stop.lon.toFixed(6) : '',
    }
  })
}

export function exportPlanCsv(run: RunResult, options: { selectedOnly?: boolean } = {}): string {
  const rows = buildPlanRows(run).filter((row) =>
    options.selectedOnly === false ? true : row.selected === 'yes',
  )
  return withCsvPreamble(toCsv(rows, EXPORT_COLUMNS), planPreamble(run))
}

export function exportRunJson(run: RunResult): string {
  return `${JSON.stringify(
    {
      product: 'Heat Priority Engine',
      engineVersion: ENGINE_VERSION,
      /**
       * When this FILE was written — not when anything in it happened.
       *
       * Named so it cannot be read as part of the run. Every timestamp inside
       * `audit` is from the analysis; this one is from the download, and it is
       * outside the attestation because nobody attested to it.
       */
      artefactWrittenAtUtc: new Date().toISOString(),
      attestedAtUtc: run.attestation?.attestedAtUtc ?? null,
      reviewedAuditSha256: run.attestation?.reviewedAuditSha256 ?? null,
      runId: run.runId,
      state: run.state,
      request: run.request,
      manifest: run.manifest,
      areaOfInterest: run.aoi,
      tilePlan: run.tilePlan,
      thermal: run.thermal,
      dataResolution: run.dataResolution,
      dayTypeResolution: run.dayTypeResolution,
      timezone: { zone: ANALYSIS_TIMEZONE, assumption: TIMEZONE_ASSUMPTION },
      methodology: run.methodology,
      thermalCoverage: run.thermalCoverage,
      plan: run.plan,
      results: run.results.map((entry) => ({
        stopId: entry.stop.id,
        name: entry.stop.name,
        lat: entry.stop.lat,
        lon: entry.stop.lon,
        routes: entry.stop.routes,
        ridership: entry.stop.ridership,
        scheduledDeparturesPerDay:
          entry.stop.service?.byDayType?.[run.methodology.exposure.dayType]?.dailyDepartures ??
          null,
        exposure: entry.exposure,
        envelopeLow: entry.envelopeLow,
        envelopeHigh: entry.envelopeHigh,
        envelopeSpreadRatio: entry.envelopeSpreadRatio,
        scenariosEvaluated: entry.scenariosEvaluated,
        scenariosUnavailable: entry.scenariosUnavailable,
        quartersUnavailable: entry.quartersUnavailable,
        thermalHoursCovered: entry.thermalHoursCovered,
        thermalHoursAnalysed: entry.thermalHoursAnalysed,
        thermalCoverageComplete: entry.thermalCoverageComplete,
        pinned: entry.pinned,
        scenarioSelectionCount: entry.scenarioSelectionCount,
        scenarioCount: entry.scenarioCount,
        scenariosOffered: entry.scenariosOffered,
        scenarioSelectionRate: entry.scenarioSelectionRate,
        scenarioRankBest: entry.scenarioRankBest,
        scenarioRankWorst: entry.scenarioRankWorst,
        assumptionSensitive: entry.assumptionSensitive,
        sensitiveTo: entry.sensitiveTo,
        droppedByCombinationOnly: entry.droppedByCombinationOnly,
        exposureObserved: entry.exposureObserved,
        exposurePercentile: entry.exposurePercentile,
        ridersInWindow: entry.ridersInWindow,
        publishedDailyRiders: entry.publishedDailyRiders,
        ridersAllocatedAcrossDay: entry.ridersAllocatedAcrossDay,
        anomalyZ: entry.anomalyZ,
        anomalyZObserved: entry.anomalyZObserved,
        anomalyObservations: entry.anomalyObservations,
        anomalyIneligibleReason: entry.anomalyIneligibleReason,
        anomalyPercentile: entry.anomalyPercentile,
        backgroundC: entry.backgroundC,
        quadrant: entry.quadrant,
        paretoFront: entry.paretoFront,
        hourly: entry.hourly,
        anomalyBySnapshot: entry.anomalyBySnapshot,
        confidence: entry.confidence,
        missing: entry.missing,
        shelterStatus: entry.stop.shelterStatus,
      })),
      attestation: run.attestation ?? null,
      audit: run.audit,
      datasetProvenance: run.datasetProvenance,
      limitations: run.limitations,
    },
    null,
    2,
  )}\n`
}

export function exportFilename(run: RunResult, extension: 'csv' | 'json'): string {
  const safeMode = run.manifest.dataMode.toLowerCase().replace(/[^a-z0-9]+/g, '-')
  return `heat-priority-plan_${run.runId}_${safeMode}.${extension}`
}
