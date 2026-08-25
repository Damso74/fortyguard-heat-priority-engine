'use client'

import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useMemo, useState } from 'react'
import { useOperations } from '@/components/operations/OperationsProvider'

const PriorityMap = dynamic(
  () => import('@/components/map/PriorityMap').then((module) => module.PriorityMap),
  {
    ssr: false,
    loading: () => <div className="grid h-full place-items-center text-[13px] text-ink-500">Loading measured heat…</div>,
  },
)

export function OverviewPage({ mapStyleUrl }: { mapStyleUrl: string }) {
  const { run, loading, error, missions, refresh } = useOperations()
  const [activeId, setActiveId] = useState<string | null>(null)

  const selected = useMemo(() => {
    if (!run) return []
    const resultById = new Map(run.results.map((result) => [String(result.stop.id), result]))
    return run.plan.entries
      .filter((entry) => entry.selected)
      .sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999))
      .slice(0, 5)
      .map((entry) => ({ entry, result: resultById.get(entry.candidateId) }))
  }, [run])

  const mapStops = useMemo(() => {
    if (!run) return []
    const entryById = new Map(run.plan.entries.map((entry) => [entry.candidateId, entry]))
    const selectedIds = new Set(run.plan.selectedIds)
    return run.results.map((result) => {
      const id = String(result.stop.id)
      const entry = entryById.get(id)
      return {
        id,
        lon: result.stop.lon,
        lat: result.stop.lat,
        name: result.stop.name,
        rank: entry?.selected ? entry.rank : null,
        selected: selectedIds.has(id),
        complete: result.complete,
        exposure: result.exposure,
        exposurePercentile: result.exposurePercentile,
        anomalyZ: result.anomalyZ,
        quadrant: result.quadrant,
      }
    })
  }, [run])

  const submitted = missions.filter((mission) => mission.status === 'submitted').length
  const reviewed = missions.filter((mission) => mission.status === 'reviewed').length
  const pendingReview = missions.find((mission) => mission.observation?.review === 'pending')
  const activeMission = missions.find((mission) => mission.status === 'assigned' || mission.status === 'in_progress')
  const nextAction = pendingReview
    ? { title: 'Review the new field observation', href: '/evidence', label: 'Review observation' }
    : activeMission
      ? { title: `Continue mission #${activeMission.rank}`, href: `/missions/${activeMission.id}`, label: 'Continue mission' }
      : missions.length > 0 && reviewed === missions.length
        ? { title: 'Download the reviewed decision brief', href: '/reports', label: 'Open audit' }
        : { title: `Review ${missions.length || 10} inspection candidates`, href: '/missions', label: 'Review candidates' }

  if (error) {
    return (
      <section className="hpe-card mx-auto max-w-xl p-6 text-center" role="alert">
        <h1 className="text-xl font-bold text-ink-900">The Phoenix pilot could not be loaded.</h1>
        <p className="mt-2 text-[13px] text-ink-600">{error}</p>
        <button type="button" onClick={refresh} className="hpe-button-primary mt-4">Try again</button>
      </section>
    )
  }

  return (
    <div className="space-y-5" aria-busy={loading}>
      <section className="grid min-h-[660px] overflow-hidden rounded-[24px] bg-ink-900 shadow-[0_24px_70px_rgb(11_24_40_/_0.18)] ring-1 ring-ink-900/10 xl:grid-cols-[minmax(390px,0.78fr)_minmax(620px,1.22fr)]">
        <div className="relative isolate flex flex-col justify-between overflow-hidden p-7 sm:p-8 xl:p-10">
          <div className="pointer-events-none absolute -left-24 top-12 -z-10 h-72 w-72 rounded-full bg-brand-600/20 blur-3xl" />
          <div className="pointer-events-none absolute -bottom-28 right-0 -z-10 h-80 w-80 rounded-full bg-heat-500/20 blur-3xl" />

          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-ok-700/40 bg-ok-700/15 px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-emerald-200">
                Real FortyGuard pilot
              </span>
              <span className="rounded-full border border-white/15 bg-white/5 px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-slate-300">
                Historical pilot · July 2024
              </span>
            </div>

            <h1 className="mt-6 max-w-2xl text-[clamp(2.5rem,3.4vw,4rem)] font-bold leading-[0.98] tracking-[-0.055em] text-white">
              Inspect the right bus stops
              <span className="mt-2 block text-heat-500">before the next heat wave.</span>
            </h1>
            <p className="mt-5 max-w-xl text-[16px] leading-7 text-slate-300 sm:text-[17px]">
              Turn measured heat and transit demand into a field plan your team can explain, review, and defend.
            </p>
            <p className="mt-3 text-[11px] font-semibold leading-5 text-slate-300">
              {loading ? 'Loading verified measurements…' : `${run?.results.length ?? 0} stops analyzed · ${run?.thermal.cellCount ?? 0} heat measurements · Human review required`}
            </p>
            <p className="mt-1 text-[10px] leading-4 text-slate-400">
              Heat and ridership: 2024 · Scheduled service: July 2026
            </p>

            <div className="mt-6 flex flex-wrap gap-3">
              <Link href="/planner" className="inline-flex min-h-12 items-center justify-center rounded-xl bg-heat-500 px-5 py-3 text-[14px] font-bold text-white shadow-lg shadow-heat-700/25 transition-colors hover:bg-heat-600">
                View priority map <span className="ml-2" aria-hidden="true">→</span>
              </Link>
              <Link href="/heat" className="inline-flex min-h-12 items-center justify-center rounded-xl border border-white/20 bg-white/8 px-5 py-3 text-[14px] font-bold text-white transition-colors hover:bg-white/14">
                Explore measured heat
              </Link>
            </div>
          </div>

          <dl className="mt-8 grid grid-cols-3 divide-x divide-white/10 border-t border-white/10 pt-5">
            <div className="pr-4">
              <dt className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">Robust picks</dt>
              <dd className="hpe-num mt-2 text-3xl font-bold text-white">{run?.plan.robustIds.length ?? '—'}</dd>
            </div>
            <div className="px-4">
              <dt className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">Tested cases</dt>
              <dd className="hpe-num mt-2 text-3xl font-bold text-white">{run?.plan.scenarioCount ?? '—'}</dd>
            </div>
            <div className="pl-4">
              <dt className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">Heat cells</dt>
              <dd className="hpe-num mt-2 text-3xl font-bold text-white">{run?.thermal.cellCount ?? '—'}</dd>
            </div>
          </dl>
        </div>

        <div className="relative min-h-[520px] border-t border-white/10 bg-ink-800 xl:border-l xl:border-t-0">
          {run ? (
            <PriorityMap
              compact
              cells={run.heatCells}
              stops={mapStops}
              bbox={run.aoi.bbox}
              layerMode="temperature"
              valueFieldLabel="Temperature"
              anomalyLabel="Local anomaly"
              activeId={activeId}
              temperatureUnit={run.methodology.exposure.thermalUnitLabel}
              loadUnitShort={run.methodology.exposure.loadUnitShort}
              onSelect={setActiveId}
              styleUrl={mapStyleUrl}
            />
          ) : (
            <div className="grid h-full place-items-center text-[13px] text-slate-300">Preparing the measured map…</div>
          )}
          <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-28 bg-gradient-to-b from-ink-900/35 to-transparent" />
          <span className="pointer-events-none absolute left-4 top-4 z-20 rounded-full border border-white/35 bg-ink-900/80 px-3 py-2 text-[10px] font-bold uppercase tracking-[0.08em] text-white shadow-lg backdrop-blur-md">
            Measured temperature · darker is warmer
          </span>
          <div className="pointer-events-none absolute inset-x-4 bottom-4 z-20 rounded-2xl border border-white/60 bg-white/94 p-4 shadow-2xl backdrop-blur-md sm:inset-x-auto sm:right-4 sm:w-[300px]">
            <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-brand-700">Operational answer</p>
            <p className="mt-1 text-[15px] font-bold text-ink-900">
              {run?.plan.capacity ?? 10} inspection candidates · {run?.plan.robustIds.length ?? 0} robust
            </p>
            <p className="mt-1 text-[11px] leading-4 text-ink-600">
              The other {run?.plan.assumptionDependentIds.length ?? 0} change with the tested assumptions.
            </p>
          </div>
        </div>
      </section>

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(320px,0.75fr)]">
        <article className="hpe-card overflow-hidden">
          <div className="flex items-center justify-between border-b border-ink-100 px-5 py-4">
            <div><p className="hpe-label">Inspect first</p><h2 className="mt-1 text-base font-bold text-ink-900">Top five stops</h2></div>
            <Link href="/planner" className="text-[12px] font-semibold text-brand-700 underline underline-offset-4">View all {run?.plan.capacity ?? 10}</Link>
          </div>
          <ol className="divide-y divide-ink-100">
            {selected.length === 0
              ? Array.from({ length: 5 }, (_, index) => <li key={index} className="h-16 animate-pulse bg-ink-50/50 motion-reduce:animate-none" />)
              : selected.map(({ entry, result }) => {
                  const stable = run?.plan.robustIds.includes(entry.candidateId)
                  return (
                    <li key={entry.candidateId} className="grid grid-cols-[40px_minmax(0,1fr)_auto] items-center gap-3 px-5 py-3">
                      <span className="hpe-num text-[13px] font-bold text-ink-500">#{entry.rank}</span>
                      <div className="min-w-0"><p className="truncate text-[13px] font-semibold text-ink-900">{result?.stop.name ?? `Stop ${entry.candidateId}`}</p><p className="mt-0.5 text-[11px] text-ink-500">{stable ? 'Stable in all tested combinations' : 'Changes with assumptions'}</p></div>
                      <span className={`rounded-full px-2 py-1 text-[9px] font-bold uppercase tracking-wide ${stable ? 'bg-ok-100 text-ok-700' : 'bg-flag-100 text-flag-700'}`}>{stable ? 'Stable' : 'Variable'}</span>
                    </li>
                  )
                })}
          </ol>
        </article>

        <article className="flex flex-col justify-between overflow-hidden rounded-xl bg-gradient-to-br from-brand-700 to-ink-900 p-5 text-white shadow-lg">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-brand-100">Next action</p>
            <h2 className="mt-2 text-xl font-bold tracking-tight text-white">{nextAction.title}</h2>
            <p className="mt-3 text-[13px] leading-5 text-slate-300">A person confirms every field observation before the reviewed decision changes.</p>
          </div>
          <div className="mt-5">
            <Link href={nextAction.href} className="inline-flex min-h-11 items-center justify-center rounded-lg bg-white px-4 py-2 text-[13px] font-bold text-brand-700 transition-colors hover:bg-brand-50">{nextAction.label} →</Link>
            <p className="mt-4 text-[11px] text-slate-300">{submitted} awaiting review · {reviewed} reviewed</p>
          </div>
        </article>
      </section>
    </div>
  )
}
