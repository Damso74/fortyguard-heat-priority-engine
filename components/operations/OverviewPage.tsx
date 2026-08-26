'use client'

import dynamic from 'next/dynamic'
import Image from 'next/image'
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

      <section className="overflow-hidden rounded-[24px] bg-ink-900 text-white shadow-[0_20px_60px_rgb(11_24_40_/_0.14)] ring-1 ring-ink-900/10" aria-labelledby="street-context-title">
        <div className="relative isolate overflow-hidden border-b border-white/10">
          <Image
            src="/editorial/downtown-phoenix-aerial.jpg"
            alt=""
            fill
            sizes="100vw"
            className="-z-20 object-cover object-[center_44%] opacity-35"
          />
          <div className="absolute inset-0 -z-10 bg-gradient-to-r from-ink-900 via-ink-900/92 to-ink-900/60" />
          <div className="grid gap-6 px-6 py-7 sm:px-8 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.68fr)] lg:items-end">
            <div>
              <div className="mb-5 inline-flex items-center gap-3 rounded-xl border border-white/15 bg-ink-900/45 px-3 py-2 shadow-lg backdrop-blur-sm">
                <span className="text-xl font-black tracking-[-0.06em] text-white">PHX</span>
                <span className="h-7 w-px bg-white/20" aria-hidden="true" />
                <span className="text-[9px] font-bold uppercase leading-4 tracking-[0.14em] text-slate-300">Arizona<br />Independent pilot location</span>
              </div>
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-heat-200">Street-level context</p>
            <h2 id="street-context-title" className="mt-2 max-w-2xl text-[clamp(1.75rem,3vw,2.75rem)] font-bold leading-[1.02] tracking-[-0.04em]">
              Heat decisions begin where people wait.
            </h2>
            </div>
            <p className="max-w-xl text-[13px] leading-6 text-slate-200 lg:justify-self-end">
              The pilot proposes where to inspect first. Only a field visit can confirm the shade, shelter, and accessibility people experience at a specific stop.
            </p>
          </div>
        </div>

        <div className="grid min-h-[540px] gap-px bg-white/10 lg:grid-cols-[minmax(0,1.35fr)_minmax(340px,0.65fr)]">
          <figure className="group relative min-h-[360px] overflow-hidden bg-ink-800 lg:min-h-[540px]">
            <Image
              src="/editorial/downtown-valley-metro.jpg"
              alt="Valley Metro bus passing Central and Adams in Downtown Phoenix"
              fill
              loading="eager"
              sizes="(max-width: 1024px) 100vw, 64vw"
              className="object-cover object-[52%_center] transition-transform duration-700 motion-reduce:transition-none lg:group-hover:scale-[1.025]"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-ink-900 via-ink-900/18 to-brand-700/8" />
            <figcaption className="absolute inset-x-0 bottom-0 p-6 sm:p-8">
              <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-heat-200">Downtown Phoenix</p>
              <h3 className="mt-2 max-w-lg text-2xl font-bold tracking-[-0.025em] sm:text-3xl">A real transit system behind every point on the map.</h3>
              <p className="mt-3 max-w-lg text-[13px] leading-5 text-slate-200">Measured heat becomes useful when it leads to a clear, defensible field decision.</p>
            </figcaption>
          </figure>

          <div className="grid gap-px bg-white/10 sm:grid-cols-2 lg:grid-cols-1">
            <figure className="group relative min-h-[300px] overflow-hidden bg-ink-800 lg:min-h-0">
              <Image
                src="/editorial/dash-stop-phoenix.jpg"
                alt="DASH Government Loop bus stop sign under a clear Phoenix sky"
                fill
                sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 36vw"
                className="object-cover object-[54%_42%] transition-transform duration-700 motion-reduce:transition-none lg:group-hover:scale-[1.035]"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-ink-900 via-ink-900/12 to-brand-700/5" />
              <figcaption className="absolute inset-x-0 bottom-0 p-5 sm:p-6">
                <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-heat-200">The stop</p>
                <h3 className="mt-1 text-xl font-bold tracking-tight">A sign, a curb, a place to wait.</h3>
              </figcaption>
            </figure>

            <figure className="group relative min-h-[300px] overflow-hidden bg-ink-800 lg:min-h-0">
              <Image
                src="/editorial/valley-metro-boarding.jpg"
                alt="A passenger boarding a Valley Metro bus in the Phoenix metropolitan area"
                fill
                sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 36vw"
                className="object-cover object-[58%_48%] transition-transform duration-700 motion-reduce:transition-none lg:group-hover:scale-[1.035]"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-ink-900 via-ink-900/20 to-heat-700/5" />
              <figcaption className="absolute inset-x-0 bottom-0 p-5 sm:p-6">
                <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-heat-200">The person</p>
                <h3 className="mt-1 text-xl font-bold tracking-tight">Every priority represents a journey.</h3>
              </figcaption>
            </figure>
          </div>
        </div>

        <div className="flex flex-col gap-2 border-t border-white/10 px-6 py-4 text-[10px] leading-4 text-slate-400 sm:px-8 lg:flex-row lg:items-center lg:justify-between">
          <p><span className="font-bold uppercase tracking-[0.12em] text-slate-300">Context photography</span> · Not evidence from the ranked stops</p>
          <p>
            Photos:{' '}
            Tony Webster:{' '}
            <a href="https://commons.wikimedia.org/wiki/File:Valley_Metro_Bus_-_Downtown_Phoenix,_Arizona_(49441796646).jpg" target="_blank" rel="noreferrer" className="underline decoration-white/35 underline-offset-4 hover:text-white">bus</a>
            {' + '}
            <a href="https://commons.wikimedia.org/wiki/File:Phoenix_Dash_Government_Loop_(Valley_Metro_Bus)_(49447930912).jpg" target="_blank" rel="noreferrer" className="underline decoration-white/35 underline-offset-4 hover:text-white">stop</a>
            {' · '}
            <a href="https://creativecommons.org/licenses/by/2.0/" target="_blank" rel="noreferrer" className="underline decoration-white/35 underline-offset-4 hover:text-white">CC BY 2.0</a>
            {' · '}
            <a href="https://commons.wikimedia.org/wiki/File:MetroBus6669.jpg" target="_blank" rel="noreferrer" className="underline decoration-white/35 underline-offset-4 hover:text-white">Benjamin Sweaney</a>
            {' · '}
            <a href="https://creativecommons.org/publicdomain/zero/1.0/" target="_blank" rel="noreferrer" className="underline decoration-white/35 underline-offset-4 hover:text-white">CC0</a>
            {' · '}
            <a href="https://commons.wikimedia.org/wiki/File:Downtown_Phoenix_Aerial_Looking_Northeast.jpg" target="_blank" rel="noreferrer" className="underline decoration-white/35 underline-offset-4 hover:text-white">DPPed skyline</a>
            {' · '}
            <a href="https://creativecommons.org/licenses/by-sa/3.0/" target="_blank" rel="noreferrer" className="underline decoration-white/35 underline-offset-4 hover:text-white">CC BY-SA 3.0</a>
          </p>
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
