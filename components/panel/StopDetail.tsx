'use client'

import { useEffect, useRef, useState } from 'react'
import type { PlanEntry } from '@/lib/types'
import type { ExpandedPlanSummary, StopDetailPayload, SummaryStopResult } from '@/lib/agent/summary'
import { Badge, ConfidenceBadge, ProvenanceBadge } from '@/components/evidence/Badge'
import { INK, QUADRANT_COLOR, QUADRANT_LABEL } from '@/lib/viz/palette'

/**
 * Everything behind one stop's two numbers.
 *
 * The hourly profile is the point of the panel: exposure is a *product* of three
 * terms, and a planner needs to see which term is doing the work. A stop can
 * rank highly because it is busy, because the wait is long, or because it is
 * hot — and the response to each is different.
 */
export function StopDetail({
  result,
  entry,
  run,
  onClose,
}: {
  result: SummaryStopResult | null
  entry: PlanEntry | null
  run: ExpandedPlanSummary
  onClose: () => void
}) {
  const [showTable, setShowTable] = useState(false)
  const [detail, setDetail] = useState<StopDetailPayload | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)
  const anchorRef = useRef<HTMLElement | null>(null)
  const selectedId = result ? String(result.stop.id) : null

  // The panel sits below the list and the matrix in a scrolling column, so
  // selecting a stop from the map or from far down the list would otherwise
  // update something the user cannot see. Bring it into view on every change.
  //
  // Instant, not smooth: a smooth scroll keeps the panel moving for hundreds of
  // milliseconds after the click, which makes every element inside it a moving
  // target for anything trying to interact with it next.
  useEffect(() => {
    if (!selectedId) return
    const frame = requestAnimationFrame(() => {
      anchorRef.current?.scrollIntoView({ behavior: 'auto', block: 'start' })
    })
    return () => cancelAnimationFrame(frame)
    // `detail` is a dependency because the panel grows from a single line to a
    // full profile when it arrives, and a scroll performed against the
    // placeholder leaves the body below the fold.
  }, [selectedId, detail])

  /*
   * The interactive response carries what the list and the map draw. The hourly
   * decomposition, the per-snapshot anomaly, the confidence rationale and the
   * scenario envelope internals belong to ONE stop, and shipping them for every
   * stop in the area cost about 1.4 MB on the 816 nobody opened.
   *
   * They come from `/api/plans/detail`, read out of the same stored run the
   * export freezes — so this panel and the exported CSV cannot show different
   * numbers for the same stop.
   */
  useEffect(() => {
    if (!selectedId) return
    const controller = new AbortController()
    setDetail(null)
    setDetailError(null)
    fetch(
      `/api/plans/detail?runId=${encodeURIComponent(run.runId)}&stopId=${encodeURIComponent(selectedId)}`,
      { signal: controller.signal },
    )
      .then(async (response) => {
        const payload = await response.json()
        if (!response.ok) throw new Error(payload?.error ?? `Detail failed (${response.status})`)
        setDetail(payload as StopDetailPayload)
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return
        setDetailError(cause instanceof Error ? cause.message : 'Detail could not be loaded.')
      })
    return () => controller.abort()
  }, [run.runId, selectedId])

  if (!result) {
    return (
      <section className="border-t border-ink-200 p-3" aria-labelledby="detail-heading">
        <h2 id="detail-heading" className="text-[13px] font-semibold text-ink-900">
          Stop detail
        </h2>
        <p className="mt-1 text-[12px] text-ink-500">
          Select a stop on the map, in the list or in the matrix to see how its exposure was built
          and what is unknown about it.
        </p>
      </section>
    )
  }

  const full = detail && detail.stop.id === result.stop.id ? detail : null
  if (!full) {
    // Same anchor and same test id as the loaded panel: the section IS the stop
    // detail, and it is one fetch from being complete. Rendering it under a
    // different identity would make "the detail panel is in view" untrue for the
    // moment a reader is actually looking at it.
    return (
      <section
        ref={anchorRef}
        className="scroll-mt-2 border-t border-ink-200 p-3"
        aria-labelledby="detail-heading"
        data-testid="stop-detail"
        data-stop-id={String(result.stop.id)}
      >
        <h2 id="detail-heading" className="truncate text-[13px] font-semibold text-ink-900">
          {result.stop.name}
        </h2>
        <p
          className="mt-1 text-[12px] text-ink-500"
          data-testid={detailError ? 'stop-detail-error' : 'stop-detail-loading'}
          role={detailError ? 'alert' : undefined}
        >
          {detailError ?? 'Loading this stop’s detail…'}
        </p>
      </section>
    )
  }

  const { stop } = full
  const maxExposure = Math.max(
    ...full.hourly.map((hour) => hour.exposure ?? 0),
    1,
  )
  const synthetic = run.manifest.dataMode === 'DEMO_SYNTHETIC'

  return (
    <section
      ref={anchorRef}
      className="scroll-mt-2 border-t border-ink-200 p-3"
      aria-labelledby="detail-heading"
      data-testid="stop-detail"
      data-stop-id={String(stop.id)}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 id="detail-heading" className="truncate text-[13px] font-semibold text-ink-900">
            {stop.name}
          </h2>
          <p className="truncate text-[11px] text-ink-500">
            Stop {stop.id}
            {stop.routes.length ? ` · routes ${stop.routes.slice(0, 8).join(', ')}` : ''}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded border border-ink-300 px-1.5 py-0.5 text-[11px] text-ink-700 hover:bg-ink-50"
        >
          Close
        </button>
      </div>

      <div className="mt-2 flex flex-wrap gap-1">
        {entry?.selected ? <Badge tone="ok">Selected · rank {entry.rank}</Badge> : null}
        {full.quadrant && (
          <span
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ring-inset"
            style={{
              background: `${QUADRANT_COLOR[full.quadrant]}1a`,
              color: INK.primary,
              boxShadow: `inset 0 0 0 1px ${QUADRANT_COLOR[full.quadrant]}66`,
            }}
          >
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ background: QUADRANT_COLOR[full.quadrant] }}
            />
            {QUADRANT_LABEL[full.quadrant]}
          </span>
        )}
        {full.paretoFront && run.plan.axesUsed.exposure && run.plan.axesUsed.anomaly ? (
          <Badge tone="brand">Pareto front {full.paretoFront}</Badge>
        ) : null}
        {entry?.selected ? (
          <Badge
            tone={full.assumptionSensitive ? 'warn' : 'ok'}
            title={
              full.assumptionSensitive
                ? `Selected in ${full.scenarioSelectionCount} of ${full.scenarioCount} scenarios.`
                : `Selected in every one of the ${full.scenarioCount} scenarios.`
            }
          >
            {full.assumptionSensitive
              ? `Assumption-dependent · ${full.scenarioSelectionCount}/${full.scenarioCount}`
              : `Robust · ${full.scenarioCount}/${full.scenarioCount}`}
          </Badge>
        ) : null}
        <ConfidenceBadge band={full.confidence.band} score={full.confidence.score} />
        <Badge tone="neutral" title="No public source can establish shelter presence at this stop.">
          Shelter: unknown
        </Badge>
      </div>

      {/* ---------------------------- headline ---------------------------- */}
      <div className="mt-3 grid grid-cols-2 gap-2">
        <div className="rounded border border-ink-200 p-2">
          <p className="hpe-label">Estimated scenario exposure load</p>
          <p className="hpe-num mt-0.5 text-lg font-semibold leading-none text-ink-900">
            {full.exposure === null ? '—' : Math.round(full.exposure).toLocaleString('en-US')}
          </p>
          <p className="text-[10px] leading-tight text-ink-500">
            {run.methodology.exposure.unit} — modelled, not measured
          </p>
          {full.envelopeLow !== null && full.envelopeHigh !== null && (
            <p className="hpe-num mt-1 text-[10px] text-ink-500">
              {Math.round(full.envelopeLow).toLocaleString('en-US')}–
              {Math.round(full.envelopeHigh).toLocaleString('en-US')} scenario envelope
              {full.envelopeSpreadRatio ? ` (×${full.envelopeSpreadRatio.toFixed(1)})` : ''}
              <span className="block normal-case">
                across {full.scenariosEvaluated} scenarios — not a confidence interval
              </span>
            </p>
          )}
        </div>
        <div className="rounded border border-ink-200 p-2">
          <p className="hpe-label">Heat anomaly</p>
          <p className="hpe-num mt-0.5 text-lg font-semibold leading-none text-ink-900">
            {full.anomalyZ === null
              ? '—'
              : `${full.anomalyZ > 0 ? '+' : ''}${full.anomalyZ.toFixed(2)}`}
          </p>
          <p className="text-[10px] leading-tight text-ink-500">σ vs the surrounding kilometre</p>
          {full.backgroundC !== null && (
            <p className="hpe-num mt-1 text-[10px] text-ink-500">
              local background {full.backgroundC.toFixed(1)}{' '}
              {run.methodology.exposure.thermalUnitLabel}
            </p>
          )}
        </div>
      </div>

      {/* ------------------------- hourly profile -------------------------- */}
      <div className="mt-3">
        <div className="flex items-baseline justify-between">
          <h3 className="hpe-label">
            Scenario exposure load by hour — modelled riders × wait × heat above reference
          </h3>
          <button
            type="button"
            onClick={() => setShowTable((value) => !value)}
            className="text-[10px] font-medium text-brand-700 underline underline-offset-2"
          >
            {showTable ? 'Chart' : 'Table'}
          </button>
        </div>

        {showTable ? (
          <div className="mt-1 overflow-x-auto">
            <table className="w-full text-[11px]">
              <caption className="sr-only">Exposure decomposition by hour</caption>
              <thead className="text-ink-500">
                <tr>
                  <th scope="col" className="py-1 text-left">Hour</th>
                  <th scope="col" className="py-1 text-right">Riders</th>
                  <th scope="col" className="py-1 text-right">Wait</th>
                  <th scope="col" className="py-1 text-right">Temp</th>
                  <th scope="col" className="py-1 text-right">Excess</th>
                  <th scope="col" className="py-1 text-right">Exposure</th>
                </tr>
              </thead>
              <tbody className="hpe-num">
                {full.hourly.map((hour) => (
                  <tr key={hour.hour} className="border-t border-ink-100">
                    <td className="py-1 text-left">{String(hour.hour).padStart(2, '0')}:00</td>
                    <td className="py-1 text-right">{hour.riders.toFixed(1)}</td>
                    <td className="py-1 text-right">
                      {hour.waitMinutes === null ? '—' : `${hour.waitMinutes.toFixed(1)}m`}
                    </td>
                    <td className="py-1 text-right">
                      {hour.temperatureC === null ? '—' : hour.temperatureC.toFixed(1)}
                    </td>
                    <td className="py-1 text-right">
                      {hour.excessC === null ? '—' : hour.excessC.toFixed(1)}
                    </td>
                    <td className="py-1 text-right font-semibold">
                      {hour.exposure === null ? '—' : Math.round(hour.exposure)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="mt-1.5 space-y-1.5">
            {full.hourly.map((hour) => {
              const width = ((hour.exposure ?? 0) / maxExposure) * 100
              return (
                <div key={hour.hour}>
                  <div className="flex items-baseline justify-between text-[11px]">
                    <span className="hpe-num text-ink-700">
                      {String(hour.hour).padStart(2, '0')}:00
                    </span>
                    <span className="hpe-num text-ink-500">
                      {hour.riders.toFixed(1)} riders ×{' '}
                      {hour.waitMinutes === null ? '—' : hour.waitMinutes.toFixed(1)} min ×{' '}
                      {hour.excessC === null
                      ? '—'
                      : `${hour.excessC.toFixed(1)} ${run.methodology.exposure.thermalUnitLabel}`}
                    </span>
                    <span className="hpe-num w-14 text-right font-semibold text-ink-900">
                      {hour.exposure === null ? '—' : Math.round(hour.exposure)}
                    </span>
                  </div>
                  <div className="mt-0.5 h-2 w-full rounded-sm bg-ink-100">
                    <div
                      className="h-2 rounded-sm bg-heat-500"
                      style={{ width: `${Math.max(width, hour.exposure ? 2 : 0)}%` }}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        )}
        <p className="mt-1 text-[10px] leading-tight text-ink-500">
          Riders: the published daily average for{' '}
          {run.methodology.exposure.ridershipQuarterLabel}, allocated across the 24 clock hours by
          the <code>{run.methodology.exposure.demandProfile}</code> profile, which sums to the
          published daily total exactly and is zero where no service runs (A1). No rider here was
          counted at this stop in this hour. Wait: {run.methodology.exposure.waitFormula} Route
          model <code>{run.methodology.exposure.routeChoice}</code>, cap{' '}
          <code>{run.methodology.exposure.waitCap}</code> (A3–A5). Excess: temperature above{' '}
          {run.methodology.exposure.referenceTemperatureC}{' '}
          {run.methodology.exposure.thermalUnitLabel} — FortyGuard&rsquo;s API analytic default,
          not a health threshold (A6).
        </p>
        <p className="mt-1 text-[10px] leading-tight text-ink-500">
          {run.methodology.exposure.waitCapRule}
        </p>
        {full.publishedDailyRiders !== null && full.ridersAllocatedAcrossDay !== null && (
          <p className="hpe-num mt-1 text-[10px] text-ink-500">
            Allocation check: {full.ridersAllocatedAcrossDay.toFixed(2)} riders allocated across
            the day vs {full.publishedDailyRiders.toFixed(2)} published.
          </p>
        )}
        {entry?.selected && (
          <div className="mt-2 rounded border border-ink-200 p-2">
            <h4 className="hpe-label">Behaviour across the scenario envelope</h4>
            <dl className="hpe-num mt-1 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
              <div>
                <dt className="text-[10px] text-ink-500">Selection frequency</dt>
                <dd className="font-semibold text-ink-900">
                  {full.scenarioSelectionCount} / {full.scenarioCount}
                  <span className="ml-1 font-normal text-ink-500">
                    ({Math.round(full.scenarioSelectionRate * 100)}%)
                  </span>
                </dd>
              </div>
              <div>
                <dt className="text-[10px] text-ink-500">Rank range where selected</dt>
                <dd className="font-semibold text-ink-900">
                  {full.scenarioRankBest === null || full.scenarioRankWorst === null
                    ? '—'
                    : full.scenarioRankBest === full.scenarioRankWorst
                      ? `${full.scenarioRankBest}`
                      : `${full.scenarioRankBest}–${full.scenarioRankWorst}`}
                </dd>
              </div>
            </dl>
            <p className="mt-1 text-[10px] leading-tight text-ink-500">
              {full.assumptionSensitive
                ? 'Assumption-dependent: it leaves the plan under at least one stated assumption.'
                : 'Robust: selected under every stated assumption in the envelope.'}{' '}
              A wide rank range means the position moves even where the stop is kept.
            </p>
            {full.assumptionSensitive && full.sensitiveTo.length > 0 && (
              <p className="mt-1 text-[10px] leading-tight text-flag-700">
                Drops out of the plan under: {full.sensitiveTo.slice(0, 6).join(', ')}
                {full.sensitiveTo.length > 6 ? ` (+${full.sensitiveTo.length - 6} more)` : ''}.
              </p>
            )}
          </div>
        )}
      </div>

      {/* --------------------------- anomaly ------------------------------- */}
      <div className="mt-3">
        <h3 className="hpe-label">Heat anomaly by snapshot</h3>
        <table className="mt-1 w-full text-[11px]">
          <tbody className="hpe-num">
            {full.anomalyBySnapshot.map((snapshot) => (
              <tr key={snapshot.snapshot} className="border-t border-ink-100">
                <td className="py-1 text-ink-700">{snapshot.snapshot.replace('T', ' ')}</td>
                <td className="py-1 text-right">
                  {snapshot.value === null ? '—' : `${snapshot.value.toFixed(1)}°`}
                </td>
                <td className="py-1 text-right font-medium">
                  {snapshot.z === null
                    ? 'n/a'
                    : `${snapshot.z > 0 ? '+' : ''}${snapshot.z.toFixed(2)}σ`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p
          className={`mt-1 text-[10px] leading-tight ${
            run.methodology.anomaly.validation.scope === 'synthetic_fixture'
              ? 'text-flag-700'
              : 'text-ink-500'
          }`}
        >
          {run.methodology.anomaly.validation.statement}
          {run.methodology.anomaly.validation.rankCorrelation !== null &&
            ` Rank correlation ${run.methodology.anomaly.validation.rankCorrelation.toFixed(2)}, top-decile retention ${((run.methodology.anomaly.validation.topDecileRetention ?? 0) * 100).toFixed(0)}% vs ${(run.methodology.anomaly.validation.topDecileChanceLevel * 100).toFixed(0)}% chance.`}
        </p>
      </div>

      {/* --------------------------- provenance ---------------------------- */}
      <div className="mt-3">
        <h3 className="hpe-label">Provenance</h3>
        <ul className="mt-1 space-y-1 text-[11px]">
          <li className="flex items-start gap-1.5">
            <ProvenanceBadge provenance="REAL" />
            <span className="text-ink-700">
              Ridership{' '}
              {stop.ridership?.byQuarter[run.methodology.exposure.ridershipQuarter]?.[
                run.methodology.exposure.ridershipCategory
              ]?.toFixed(1) ?? 'n/a'}{' '}
              riders/day ({run.methodology.exposure.ridershipCategory},{' '}
              {run.methodology.exposure.ridershipQuarterLabel}) — Valley Metro
            </span>
          </li>
          <li className="flex items-start gap-1.5">
            <ProvenanceBadge provenance="REAL" />
            <span className="text-ink-700">
              {stop.service?.byDayType?.[run.methodology.exposure.dayType]?.dailyDepartures ?? 0}{' '}
              scheduled departures on the {run.methodology.exposure.dayType} timetable, over{' '}
              {stop.service?.byDayType?.[run.methodology.exposure.dayType]?.routeCount ?? 0}{' '}
              route(s) — Valley Metro GTFS
            </span>
          </li>
          <li className="flex items-start gap-1.5">
            <ProvenanceBadge provenance={synthetic ? 'SYNTHETIC' : 'REAL'} />
            <span className="text-ink-700">
              {synthetic
                ? 'Temperature is a labelled synthetic fixture, not a measurement.'
                : `Temperature from FortyGuard, field "${run.thermal.valueField}".`}
            </span>
          </li>
          <li className="flex items-start gap-1.5">
            <ProvenanceBadge provenance="UNKNOWN" />
            <span className="text-ink-700">Shelter presence — no usable public source.</span>
          </li>
        </ul>
      </div>

      {/* --------------------------- confidence ---------------------------- */}
      <div className="mt-3">
        <h3 className="hpe-label">Confidence — separate from priority</h3>
        <ul className="mt-1 space-y-0.5 text-[11px] text-ink-700">
          {Object.entries(full.confidence.components).map(([key, value]) => (
            <li key={key} className="flex items-baseline justify-between gap-2">
              <span className="capitalize">{key.replace(/([A-Z])/g, ' $1').toLowerCase()}</span>
              <span className="hpe-num">{(value * 100).toFixed(0)}%</span>
            </li>
          ))}
        </ul>
        {full.confidence.reasons.length > 0 && (
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[10px] text-flag-700">
            {full.confidence.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        )}
      </div>

      {entry && (
        <div className="mt-3 rounded border border-ink-200 bg-ink-50 p-2">
          <h3 className="hpe-label">Why this outcome</h3>
          <p className="mt-1 text-[11px] text-ink-700">{entry.reason}</p>
        </div>
      )}

      <div className="mt-3">
        <h3 className="hpe-label">What this does not say</h3>
        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[10px] text-ink-500">
          <li>Nothing here states whether this stop already has a shelter.</li>
          <li>No number here is a temperature reduction, a cost, or a person protected.</li>
          <li>This is a stop to study first, not an intervention that has been justified.</li>
        </ul>
      </div>
    </section>
  )
}
