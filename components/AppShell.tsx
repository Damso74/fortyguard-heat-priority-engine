'use client'

import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AreaOfInterest } from '@/lib/types'
import {
  expandPlanSummary,
  type ExpandedPlanSummary,
  type PlanSummary,
} from '@/lib/agent/summary'
import type { LayerMode } from '@/components/map/PriorityMap'
import { RunControls, type ControlsValue } from '@/components/panel/RunControls'
import { ResultList } from '@/components/panel/ResultList'
import { StopDetail } from '@/components/panel/StopDetail'
import { QuadrantMatrix } from '@/components/panel/QuadrantMatrix'
import { RunSummary } from '@/components/panel/RunSummary'
import { ModeBanner } from '@/components/data-status/ModeBanner'
import { BrandMark } from '@/components/Brand'

const PriorityMap = dynamic(
  () => import('@/components/map/PriorityMap').then((module) => module.PriorityMap),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center text-[13px] text-ink-500">
        Loading map…
      </div>
    ),
  },
)

/*
 * The first layer renders the TEMPERATURE field, not the exposure load. It was
 * labelled "Exposure", which named a quantity the layer does not encode: a cell
 * has a temperature, while an exposure load belongs to a stop and depends on
 * riders and wait as well as heat. The label now says what is drawn.
 */
const LAYER_LABEL: Record<LayerMode, string> = {
  temperature: 'Temperature',
  anomaly: 'Anomaly',
  // Never "Combined": the product's one non-negotiable is that the two metrics
  // are never blended, and this label was quietly implying the opposite.
  combined: 'Exposure × Anomaly',
}

const LAYER_HINT: Record<LayerMode, string> = {
  temperature: 'The temperature field itself, with the selected stops on top.',
  anomaly: 'How unusual each cell is for its own surroundings.',
  combined: 'Stops coloured by which axis puts them above the median.',
}

export function AppShell({
  areas,
  defaults,
  mapStyleUrl,
  embedded = false,
}: {
  areas: readonly AreaOfInterest[]
  defaults: ControlsValue
  mapStyleUrl: string
  embedded?: boolean
}) {
  const [controls, setControls] = useState<ControlsValue>(defaults)
  const [run, setRun] = useState<ExpandedPlanSummary | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [layerMode, setLayerMode] = useState<LayerMode>('temperature')
  const [panelOpen, setPanelOpen] = useState(true)
  const requestSeq = useRef(0)

  const requestBody = useMemo(
    () => ({
      aoiId: controls.aoiId,
      capacity: controls.capacity,
      analysisDate: controls.analysisDate,
      snapshotTimes: controls.snapshotTimes,
      dayType: controls.dayType,
    }),
    [controls],
  )

  const analyze = useCallback(async (body: unknown) => {
    const seq = ++requestSeq.current
    setRunning(true)
    setError(null)
    try {
      const response = await fetch('/api/plans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const payload = await response.json()
      if (seq !== requestSeq.current) return
      if (!response.ok) throw new Error(payload?.error ?? `Analysis failed (${response.status})`)
      // The endpoint returns a summary: the cell footprints are factored out
      // into one shared template, which is rebuilt here. The reconstruction is
      // exact — the engine normalised the rings to `centroid + template` before
      // the payload was built — so the map draws the polygons the export
      // records, not an approximation of them.
      setRun(expandPlanSummary(payload as PlanSummary))
      setActiveId(null)
    } catch (cause) {
      if (seq !== requestSeq.current) return
      setError(cause instanceof Error ? cause.message : 'Analysis failed.')
      setRun(null)
    } finally {
      if (seq === requestSeq.current) setRunning(false)
    }
  }, [])

  // A change to the inputs re-runs only when a run already exists — the first
  // run is always explicit. De-duplicated by serialised request, so an identical
  // request never fires twice. `analyze` is stable and `hasRun` is a ref, so the
  // dependency list is honest and needs no suppression.
  const lastRequested = useRef<string | null>(null)
  const hasRun = useRef(false)
  hasRun.current = run !== null

  useEffect(() => {
    if (!hasRun.current) return
    const key = JSON.stringify(requestBody)
    if (lastRequested.current === key) return
    lastRequested.current = key
    void analyze(requestBody)
  }, [requestBody, analyze])

  const runAnalysis = () => {
    lastRequested.current = JSON.stringify(requestBody)
    void analyze(requestBody)
  }

  // The first paint shows the product, not a form: the default request runs
  // itself on arrival. This spends nothing (the deployment reads either a
  // committed snapshot or the fixture, and the run is deterministic), and the
  // act that stays explicit is the one with
  // consequences — the attested export.
  const booted = useRef(false)
  useEffect(() => {
    if (booted.current) return
    booted.current = true
    lastRequested.current = JSON.stringify(requestBody)
    void analyze(requestBody)
  }, [requestBody, analyze])

  /*
   * What the map is allowed to call the numbers it draws.
   *
   * On a real layer whose field is unconfirmed, calling the values "Temperature"
   * and the z-score a "Local heat anomaly" is the claim the capability gate
   * exists to withhold — and it was hardcoded into the legend and the tooltip.
   */
  const heatNamed =
    run === null ||
    run.manifest.dataMode === 'DEMO_SYNTHETIC' ||
    run.methodology.exposure.celsiusReadingPermitted
  const valueFieldLabel = heatNamed
    ? 'Temperature'
    : `Unidentified value (${run?.thermal.valueField ?? 'field unknown'})`
  const anomalyLabel = heatNamed
    ? 'Local heat anomaly'
    : 'Local anomaly in an unidentified value'

  const currentAoi = areas.find((area) => area.id === controls.aoiId) ?? areas[0]!
  const activeResult = run?.results.find((entry) => String(entry.stop.id) === activeId) ?? null
  const activeEntry = run?.plan.entries.find((entry) => entry.candidateId === activeId) ?? null

  const mapStops = useMemo(() => {
    if (!run) return []
    const entryById = new Map(run.plan.entries.map((entry) => [entry.candidateId, entry]))
    return run.results.map((result) => {
      const id = String(result.stop.id)
      const entry = entryById.get(id)
      return {
        id,
        lon: result.stop.lon,
        lat: result.stop.lat,
        name: result.stop.name,
        rank: entry?.selected ? entry.rank : null,
        selected: entry?.selected ?? false,
        complete: result.complete,
        exposure: result.exposure,
        exposurePercentile: result.exposurePercentile,
        anomalyZ: result.anomalyZ,
        quadrant: result.quadrant,
      }
    })
  }, [run])

  return (
    // Locked app-shell layout from md up: side-by-side panel and map. Below
    // md the page must scroll normally, or everything past the fold is
    // unreachable by touch.
    <div className={embedded ? 'flex min-h-[calc(100dvh-96px)] flex-col md:h-[calc(100dvh-96px)] md:overflow-hidden' : 'flex min-h-dvh flex-col md:h-dvh md:overflow-hidden'}>
      {/* ------------------------------ header ------------------------------ */}
      {!embedded && <header className="shrink-0 border-b border-ink-200 bg-white">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2">
          <div className="flex items-center gap-2">
            <BrandMark className="h-7 w-7 shrink-0" />
            <div>
              <h1 className="text-[15px] font-bold leading-tight tracking-tight text-ink-900">
                Heat Priority Engine
              </h1>
              <p className="text-[10px] font-medium uppercase tracking-wider text-ink-500">
                Independent pilot · Phoenix, Arizona
              </p>
            </div>
          </div>
          {/*
           * The hero is a question, because that is what the product answers.
           * The subline stays within the claim registry: modelled exposure,
           * local anomaly, assumption stress-test — inspection, no investment
           * recommendation, no causal or cost claim. Below md a compact
           * one-question line carries the same promise in two lines at most.
           */}
          <p className="w-full text-[12px] font-semibold leading-tight text-ink-900 md:hidden">
            Which Phoenix bus stops should be inspected first?
          </p>
          <div className="hidden max-w-2xl md:block">
            <p className="text-[13px] font-semibold leading-tight text-ink-900">
              Which bus stops should Phoenix inspect first before the next heat wave?
            </p>
            <p className="text-[11px] leading-tight text-ink-500">
              Modelled rider heat exposure and locally unusual heat, kept separate and
              stress-tested across 324 assumption scenarios — prioritization for inspection, not
              an investment recommendation.
            </p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <a
              href="/methodology"
              className="text-[12px] font-medium text-brand-700 underline underline-offset-2"
            >
              Methodology
            </a>
          </div>
        </div>
      </header>}

      {embedded && (
        <section className="shrink-0 border-b border-ink-200 bg-white px-4 py-3">
          <p className="hpe-label text-brand-700">Plan &amp; prioritize</p>
          <div className="mt-1 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h1 className="text-lg font-bold tracking-tight text-ink-900">Priority planner</h1>
              <p className="mt-0.5 text-[11px] text-ink-500">
                Which Phoenix bus stops should we inspect first before the next heat wave?
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-flag-700/25 bg-flag-100 px-2.5 py-1 text-[9px] font-bold uppercase tracking-wide text-flag-700">
                Human approval required
              </span>
              <Link href="/missions" className="rounded-md bg-brand-600 px-3 py-2 text-[12px] font-semibold text-white hover:bg-brand-700">
                Create inspection missions →
              </Link>
            </div>
          </div>
        </section>
      )}

      {/*
        Before a run exists there is no data mode, and guessing one from the
        configuration was backwards: with a key and the live flag set, this
        passed `LIVE_FORTYGUARD` — the one value `ModeBanner` renders nothing
        for — so the honesty banner disappeared before a single measurement
        existed, on the strength of two environment variables.

        The mode is a property of a run. Until there is one, the banner says the
        page is showing no data, which is the only true statement available.
      */}
      <ModeBanner dataMode={run ? run.manifest.dataMode : null} />

      {/* ------------------------------- body ------------------------------- */}
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <aside
          className={`flex shrink-0 flex-col border-ink-200 bg-white md:h-full md:overflow-y-auto md:border-r ${
            panelOpen
              ? 'md:w-[330px] lg:w-[380px]'
              : 'md:w-0 md:overflow-hidden md:border-r-0'
          }`}
          aria-label="Analysis panel"
        >
          <RunControls
            value={controls}
            areas={areas}
            running={running}
            onChange={setControls}
            onRun={runAnalysis}
          />

          {error && (
            <div role="alert" className="border-t border-stop-700/25 bg-stop-100 p-3 text-[12px] text-stop-700">
              <strong className="font-semibold">Analysis failed.</strong> {error}
            </div>
          )}

          {!run && !running && !error && (
            <div className="p-4 text-center" data-testid="empty-state">
              <p className="text-[13px] font-medium text-ink-900">No analysis yet</p>
              <p className="mt-1 text-[12px] text-ink-500">
                Pick an area, a date and a capacity, then run the analysis. Two metrics are reported
                separately and never blended: estimated scenario exposure load, and local heat
                anomaly.
              </p>
            </div>
          )}

          {running && !run && (
            <div className="p-4 text-center text-[13px] text-ink-700" data-testid="loading-state">
              Running the pipeline…
            </div>
          )}

          {run && (
            <>
              {/*
               * The conclusion reads first. The headline is the SPLIT, not the
               * plan size: "plan of 50" invites the reader to treat 50 stops as
               * one finding, when only the robust ones hold under every stated
               * assumption. Detail, provenance and export stay in the summary
               * at the bottom.
               */}
              <div className="border-t border-brand-500/30 bg-brand-50 px-3 py-2">
                <p data-testid="result-headline" className="text-[14px] leading-snug text-ink-900">
                  <strong className="hpe-num">{run.plan.robustIds.length}</strong> robust{' '}
                  {run.plan.robustIds.length === 1 ? 'priority' : 'priorities'} +{' '}
                  <strong className="hpe-num">{run.plan.assumptionDependentIds.length}</strong>{' '}
                  assumption-dependent{' '}
                  {run.plan.assumptionDependentIds.length === 1 ? 'candidate' : 'candidates'}
                </p>
                <p className="mt-0.5 text-[10px] leading-tight text-ink-600">
                  Robust = selected in all {run.plan.scenarioCount} scenarios of the assumption
                  envelope. Everything else is in the plan because of a setting nobody has observed.
                </p>
              </div>
              <ResultList
                results={run.results}
                entries={run.plan.entries}
                activeId={activeId}
                loadUnitShort={run.methodology.exposure.loadUnitShort}
                scenarioSweepApplies={run.plan.scenarioSweepApplies}
                onSelect={setActiveId}
              />
              {/*
                A quadrant is a median split on BOTH axes. With one axis the
                excluded metric is null everywhere, so the matrix rendered a
                column of zeros and a legend describing a comparison this run had
                not made. It is a two-axis view, so it appears only when there
                are two axes.
              */}
              {run.manifest.axes.exposure && run.manifest.axes.anomaly && (
                <QuadrantMatrix
                  results={run.results}
                  selectedIds={run.plan.selectedIds}
                  activeId={activeId}
                  onSelect={setActiveId}
                />
              )}
              <StopDetail
                result={activeResult}
                entry={activeEntry}
                run={run}
                onClose={() => setActiveId(null)}
              />
              <RunSummary run={run} requestBody={requestBody} />

              {/*
               * Method at a glance — placed after the result so it explains
               * what the reader just saw instead of delaying it. Each sentence
               * stays inside the claim registry; the full argument lives on the
               * methodology page, and the CTA says "audit" because that is what
               * the page supports.
               */}
              <section
                aria-labelledby="method-cards-h"
                data-testid="method-cards"
                className="border-t border-ink-200 p-3"
              >
                <h2 id="method-cards-h" className="hpe-label">
                  Why this list can be trusted — and how far
                </h2>
                <ul className="mt-1.5 space-y-1.5">
                  <li className="hpe-card p-2">
                    <p className="text-[12px] font-semibold text-ink-900">Two axes, never blended</p>
                    <p className="mt-0.5 text-[11px] leading-snug text-ink-500">
                      Exposure and anomaly are reported separately. No exchange rate converts riders
                      into degrees, and no weight exists anywhere in the product.
                    </p>
                  </li>
                  <li className="hpe-card p-2">
                    <p className="text-[12px] font-semibold text-ink-900">
                      Tested across {run.plan.scenarioCount} assumption scenarios
                    </p>
                    <p className="mt-0.5 text-[11px] leading-snug text-ink-500">
                      A selection is robust only when every stated assumption keeps selecting it;
                      everything else is labelled assumption-dependent.
                    </p>
                  </li>
                  <li className="hpe-card p-2">
                    <p className="text-[12px] font-semibold text-ink-900">Every claim is auditable</p>
                    <p className="mt-0.5 text-[11px] leading-snug text-ink-500">
                      Sources, hashes and limitations travel with each run and export — including
                      the claims this product refuses to make.
                    </p>
                  </li>
                </ul>
                <a
                  href="/methodology"
                  className="mt-2 inline-block text-[12px] font-medium text-brand-700 underline underline-offset-2"
                >
                  Audit the full methodology
                </a>
              </section>
            </>
          )}
        </aside>

        {/* -------------------------------- map ------------------------------ */}
        <main id={embedded ? undefined : 'main'} className="relative min-h-[60vh] flex-1 md:h-full md:min-h-0">
          <div className="absolute left-3 top-3 z-30 flex items-center gap-1 rounded border border-ink-200 bg-white/95 p-1 shadow-sm">
            {(['temperature', 'anomaly', 'combined'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                data-testid={`layer-${mode}`}
                aria-pressed={layerMode === mode}
                title={LAYER_HINT[mode]}
                onClick={() => setLayerMode(mode)}
                className={`rounded px-2 py-1 text-[12px] ${
                  layerMode === mode
                    ? 'bg-brand-600 font-semibold text-white'
                    : 'text-ink-700 hover:bg-ink-50'
                }`}
              >
                {LAYER_LABEL[mode]}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => setPanelOpen((value) => !value)}
            className="absolute right-3 top-3 z-30 hidden rounded border border-ink-200 bg-white/95 px-2 py-1 text-[12px] text-ink-700 shadow-sm hover:bg-ink-50 md:block"
          >
            {panelOpen ? 'Hide panel' : 'Show panel'}
          </button>

          {run ? (
            <PriorityMap
              cells={run.heatCells}
              stops={mapStops}
              bbox={currentAoi.bbox}
              layerMode={layerMode}
              valueFieldLabel={valueFieldLabel}
              anomalyLabel={anomalyLabel}
              activeId={activeId}
              temperatureUnit={run.methodology.exposure.thermalUnitLabel}
              loadUnitShort={run.methodology.exposure.loadUnitShort}
              onSelect={setActiveId}
              styleUrl={mapStyleUrl}
            />
          ) : (
            <div className="flex h-full items-center justify-center bg-ink-50 p-6 text-center">
              <p className="max-w-sm text-[13px] text-ink-500">
                The map fills with the heat field and the prioritised stops once an analysis has
                run.
              </p>
            </div>
          )}
        </main>
      </div>
    </div>
  )
}
