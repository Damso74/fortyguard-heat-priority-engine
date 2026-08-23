'use client'

import Link from 'next/link'
import { useMemo } from 'react'
import { useOperations } from '@/components/operations/OperationsProvider'

const DECISION_WORKFLOW = [
  ['01', 'Understand heat', '/heat'],
  ['02', 'Prioritize', '/planner'],
  ['03', 'Inspect', '/missions'],
  ['04', 'Validate', '/evidence'],
  ['05', 'Prove', '/reports'],
] as const

function MetricCard({
  label,
  value,
  detail,
  tone = 'default',
}: {
  label: string
  value: string
  detail: string
  tone?: 'default' | 'heat' | 'verified'
}) {
  const toneClass =
    tone === 'heat'
      ? 'border-l-heat-500'
      : tone === 'verified'
        ? 'border-l-ok-700'
        : 'border-l-brand-500'
  return (
    <article className={`hpe-card border-l-4 ${toneClass} p-4`}>
      <p className="hpe-label">{label}</p>
      <p className="hpe-num mt-2 text-2xl font-bold tracking-tight text-ink-900">{value}</p>
      <p className="mt-1 text-[11px] leading-relaxed text-ink-500">{detail}</p>
    </article>
  )
}

export function OverviewPage() {
  const { run, loading, error, missions, refresh } = useOperations()

  const coverage = useMemo(() => {
    if (!run) return null
    const selected = new Set(run.plan.selectedIds)
    const total = run.results.reduce((sum, result) => sum + (result.exposure ?? 0), 0)
    const covered = run.results.reduce(
      (sum, result) => sum + (selected.has(String(result.stop.id)) ? result.exposure ?? 0 : 0),
      0,
    )
    return total > 0 ? (covered / total) * 100 : null
  }, [run])

  const selected = useMemo(() => {
    if (!run) return []
    const resultById = new Map(run.results.map((result) => [String(result.stop.id), result]))
    return run.plan.entries
      .filter((entry) => entry.selected)
      .sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999))
      .slice(0, 5)
      .map((entry) => ({ entry, result: resultById.get(entry.candidateId) }))
  }, [run])

  const submitted = missions.filter((mission) => mission.status === 'submitted').length
  const reviewed = missions.filter((mission) => mission.status === 'reviewed').length

  if (error) {
    return (
      <section className="hpe-card mx-auto max-w-xl p-6 text-center" role="alert">
        <p className="text-base font-bold text-ink-900">The verified pilot could not be loaded.</p>
        <p className="mt-2 text-[13px] text-ink-600">{error}</p>
        <button type="button" onClick={refresh} className="mt-4 rounded-md bg-brand-600 px-4 py-2 text-[13px] font-semibold text-white">
          Try again
        </button>
      </section>
    )
  }

  return (
    <div className="space-y-5">
      <section className="grid gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(340px,0.65fr)]">
        <div className="overflow-hidden rounded-xl border border-[#d7dee8] bg-[#0f2238] p-6 text-white shadow-sm sm:p-7">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full border border-cyan-300/25 bg-cyan-300/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-cyan-100">
              Real FortyGuard pilot
            </span>
            <span className="rounded-full border border-amber-300/25 bg-amber-300/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-amber-100">
              Exposure-only
            </span>
          </div>
          <h1 className="mt-5 max-w-3xl text-3xl font-bold leading-tight tracking-[-0.025em] sm:text-4xl">
            Turn heat evidence into the next defensible field action.
          </h1>
          <p className="mt-3 max-w-2xl text-[14px] leading-relaxed text-slate-300">
            Prioritize the Phoenix transit stops a constrained team should inspect first, preserve uncertainty, and carry every decision into a reviewable field mission.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Link href="/heat" className="rounded-lg bg-[#e85d2a] px-4 py-2.5 text-[13px] font-bold text-white shadow-sm hover:bg-[#cf4d20]">
              Explore heat evidence
            </Link>
            <Link href="/planner" className="rounded-lg border border-white/20 bg-white/8 px-4 py-2.5 text-[13px] font-semibold text-white hover:bg-white/12">
              Open priority planner
            </Link>
          </div>
        </div>

        <aside className="hpe-card p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="hpe-label">Recommended next action</p>
              <h2 className="mt-2 text-xl font-bold tracking-tight text-ink-900">Confirm the 10 proposed missions</h2>
            </div>
            <span className="rounded-full bg-heat-100 px-2.5 py-1 text-[10px] font-bold uppercase text-heat-700">Human approval</span>
          </div>
          <p className="mt-3 text-[13px] leading-relaxed text-ink-600">
            The engine has ranked the covered stops. Field evidence is still needed before any shelter or feasibility statement can be made.
          </p>
          <Link href="/missions" className="mt-4 inline-flex rounded-md bg-brand-600 px-3 py-2 text-[12px] font-semibold text-white hover:bg-brand-700">
            Review inspection missions
          </Link>
          <dl className="mt-5 grid grid-cols-3 gap-2 border-t border-ink-100 pt-4 text-center">
            <div><dt className="text-[10px] text-ink-500">Draft</dt><dd className="hpe-num mt-1 text-lg font-bold">{Math.max(0, missions.length - submitted - reviewed)}</dd></div>
            <div><dt className="text-[10px] text-ink-500">Submitted</dt><dd className="hpe-num mt-1 text-lg font-bold">{submitted}</dd></div>
            <div><dt className="text-[10px] text-ink-500">Reviewed</dt><dd className="hpe-num mt-1 text-lg font-bold">{reviewed}</dd></div>
          </dl>
        </aside>
      </section>

      <nav aria-label="Decision workflow" className="hpe-card grid overflow-hidden sm:grid-cols-5">
        {DECISION_WORKFLOW.map(([step, label, href]) => (
          <Link
            key={href}
            href={href}
            className="group flex items-center gap-3 border-b border-ink-100 px-4 py-3 last:border-b-0 hover:bg-ink-50 sm:border-b-0 sm:border-r sm:last:border-r-0"
          >
            <span className="hpe-num text-[10px] font-bold text-brand-700">{step}</span>
            <span className="text-[12px] font-semibold text-ink-700 group-hover:text-ink-900">{label}</span>
          </Link>
        ))}
      </nav>

      <section aria-label="Pilot metrics" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Robust priorities" value={loading ? '—' : String(run?.plan.robustIds.length ?? 0)} detail="Selected in every tested assumption scenario." tone="verified" />
        <MetricCard label="Conditional candidates" value={loading ? '—' : String(run?.plan.assumptionDependentIds.length ?? 0)} detail="Selected under the base settings, but not every scenario." tone="heat" />
        <MetricCard label="Modelled exposure covered" value={coverage === null ? '—' : `${coverage.toFixed(1)}%`} detail="Share of modelled load represented by the selected stops." />
        <MetricCard label="Thermal evidence" value={loading ? '—' : `${run?.thermal.cellCount ?? 0} cells`} detail={`${run?.request.snapshotTimes.length ?? 3} stored FortyGuard snapshots · no live credit spent.`} />
      </section>

      <section className="grid gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(360px,0.8fr)]">
        <article className="hpe-card overflow-hidden">
          <div className="flex items-center justify-between border-b border-ink-100 px-5 py-4">
            <div>
              <p className="hpe-label">Current priority plan</p>
              <h2 className="mt-1 text-base font-bold text-ink-900">Highest-ranked inspection candidates</h2>
            </div>
            <Link href="/planner" className="text-[12px] font-semibold text-brand-700 underline underline-offset-4">View full plan</Link>
          </div>
          <ol className="divide-y divide-ink-100">
            {selected.length === 0
              ? Array.from({ length: 5 }, (_, index) => <li key={index} className="h-16 animate-pulse bg-ink-50/50" />)
              : selected.map(({ entry, result }) => {
                  const robust = run?.plan.robustIds.includes(entry.candidateId)
                  return (
                    <li key={entry.candidateId} className="grid grid-cols-[42px_minmax(0,1fr)_auto] items-center gap-3 px-5 py-3">
                      <span className="hpe-num grid h-8 w-8 place-items-center rounded-md bg-ink-50 text-[12px] font-bold text-ink-700">#{entry.rank}</span>
                      <div className="min-w-0">
                        <p className="truncate text-[13px] font-semibold text-ink-900">{result?.stop.name ?? `Stop ${entry.candidateId}`}</p>
                        <p className="mt-0.5 text-[11px] text-ink-500">Selected in {result?.scenarioSelectionCount ?? 0}/{result?.scenarioCount ?? 0} scenarios</p>
                      </div>
                      <span className={`rounded-full px-2 py-1 text-[9px] font-bold uppercase tracking-wide ${robust ? 'bg-ok-100 text-ok-700' : 'bg-flag-100 text-flag-700'}`}>
                        {robust ? 'Robust' : 'Conditional'}
                      </span>
                    </li>
                  )
                })}
          </ol>
        </article>

        <article className="hpe-card p-5">
          <p className="hpe-label">Decision agent</p>
          <h2 className="mt-1 text-base font-bold text-ink-900">Observable, constrained workflow</h2>
          <ol className="mt-4 space-y-3">
            {[
              ['Checked stored FortyGuard snapshots', 'Complete'],
              ['Validated field, unit and Phoenix time', 'Complete'],
              ['Tested spatial persistence', run?.manifest.mode === 'EXPOSURE_ONLY' ? 'Limited' : 'Complete'],
              ['Disabled unsupported hotspot claims', 'Complete'],
              ['Stress-tested ranking assumptions', 'Complete'],
              ['Drafted inspection missions', 'Awaiting approval'],
            ].map(([step, status], index) => (
              <li key={step} className="grid grid-cols-[24px_minmax(0,1fr)_auto] items-center gap-2 text-[12px]">
                <span className={`grid h-6 w-6 place-items-center rounded-full text-[10px] font-bold ${status === 'Limited' ? 'bg-flag-100 text-flag-700' : status === 'Awaiting approval' ? 'bg-ink-100 text-ink-600' : 'bg-ok-100 text-ok-700'}`}>{index + 1}</span>
                <span className="text-ink-700">{step}</span>
                <span className="text-[10px] font-semibold text-ink-500">{status}</span>
              </li>
            ))}
          </ol>
          <div className="mt-5 rounded-lg border border-flag-700/25 bg-flag-100/50 p-3">
            <p className="text-[12px] font-bold text-flag-700">Claim withheld</p>
            <p className="mt-1 text-[11px] leading-relaxed text-ink-700">This run cannot support a persistent local-hotspot claim. Absolute heat remains available for exposure prioritization.</p>
          </div>
        </article>
      </section>
    </div>
  )
}
