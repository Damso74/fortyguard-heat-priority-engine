'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { EvidencePill, ModuleHeader } from '@/components/operations/ModuleHeader'
import { useOperations } from '@/components/operations/OperationsProvider'
import { expandPlanSummary, type ExpandedPlanSummary, type PlanSummary } from '@/lib/agent/summary'

interface StrategyResult {
  id: string
  label: string
  description: string
  coverage: number
  selectedIds: string[]
  tone: string
}

function deterministicRandomKey(stopId: number): number {
  return ((stopId * 2654435761) >>> 0) / 4294967296
}

export function ScenarioLab() {
  const { defaults, run: defaultRun } = useOperations()
  const [capacity, setCapacity] = useState(10)
  const [run, setRun] = useState<ExpandedPlanSummary | null>(defaultRun)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (capacity === defaultRun?.plan.capacity) {
      setRun(defaultRun)
      return
    }
    const controller = new AbortController()
    setLoading(true)
    void fetch('/api/plans', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...defaults, capacity }),
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = await response.json()
        if (!response.ok) throw new Error(payload?.error ?? 'Scenario failed.')
        return expandPlanSummary(payload as PlanSummary)
      })
      .then(setRun)
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [capacity, defaultRun, defaults])

  const strategies = useMemo<StrategyResult[]>(() => {
    if (!run) return []
    const eligible = run.results.filter((result) => typeof result.exposure === 'number')
    const total = eligible.reduce((sum, result) => sum + (result.exposure ?? 0), 0)
    const k = Math.min(capacity, eligible.length)
    const coverage = (ids: string[]) => {
      const selected = new Set(ids)
      const covered = eligible.reduce((sum, result) => sum + (selected.has(String(result.stop.id)) ? result.exposure ?? 0 : 0), 0)
      return total > 0 ? (covered / total) * 100 : 0
    }
    const pick = (score: (result: (typeof eligible)[number]) => number) =>
      [...eligible]
        .sort((a, b) => score(b) - score(a) || a.stop.id - b.stop.id)
        .slice(0, k)
        .map((result) => String(result.stop.id))

    const hpeIds = run.plan.selectedIds.slice(0, k)
    const ridershipIds = pick((result) => result.stop.publishedDailyRiders ?? 0)
    const heatIds = pick((result) => result.meanExcessC ?? 0)
    const waitIds = pick((result) => result.meanWaitMinutes ?? 0)
    const randomIds = pick((result) => deterministicRandomKey(result.stop.id))

    return [
      { id: 'hpe', label: 'Heat Priority Engine', description: 'Weight-free selection stress-tested across the assumption envelope.', coverage: coverage(hpeIds), selectedIds: hpeIds, tone: 'bg-brand-600' },
      { id: 'ridership', label: 'Ridership only', description: 'Highest published ridership values, without thermal timing.', coverage: coverage(ridershipIds), selectedIds: ridershipIds, tone: 'bg-slate-500' },
      { id: 'heat', label: 'Thermal intensity only', description: 'Highest mean excess thermal value, without riders or waiting.', coverage: coverage(heatIds), selectedIds: heatIds, tone: 'bg-heat-500' },
      { id: 'wait', label: 'Scheduled wait only', description: 'Highest modelled waiting burden, without heat.', coverage: coverage(waitIds), selectedIds: waitIds, tone: 'bg-violet-500' },
      { id: 'random', label: 'Deterministic random', description: 'Reproducible control ordering using stop identifiers.', coverage: coverage(randomIds), selectedIds: randomIds, tone: 'bg-ink-300' },
    ]
  }, [capacity, run])

  const hpe = strategies[0]
  const ridership = strategies[1]
  const heatContribution = hpe && ridership
    ? hpe.selectedIds.filter((id) => !ridership.selectedIds.includes(id)).length
    : 0
  const bestBaseline = strategies.slice(1).reduce((best, item) => Math.max(best, item.coverage), 0)
  const uplift = hpe ? hpe.coverage - bestBaseline : 0

  return (
    <div className="space-y-5">
      <ModuleHeader
        eyebrow="Govern & document"
        title="Scenario lab"
        description="Compare inspection strategies on the same eligible stops and the same modelled-exposure outcome. No intervention cooling, ROI or people-protected claim is generated."
        actions={
          <>
            <EvidencePill tone="warn">Modelled comparison</EvidencePill>
            <Link href="/reports" className="rounded-md bg-brand-600 px-3 py-2 text-[12px] font-semibold text-white hover:bg-brand-700">
              Open audit report →
            </Link>
          </>
        }
      />

      <section className="hpe-card flex flex-wrap items-center justify-between gap-4 p-4">
        <div>
          <p className="hpe-label">Inspection capacity</p>
          <div className="mt-2 flex gap-2">
            {[10, 20, 50].map((value) => (
              <button key={value} type="button" onClick={() => setCapacity(value)} aria-pressed={capacity === value} className={`min-w-14 rounded-md px-3 py-2 text-[12px] font-bold ${capacity === value ? 'bg-brand-600 text-white' : 'bg-ink-50 text-ink-700'}`}>{value}</button>
            ))}
          </div>
        </div>
        <div className="text-right">
          <p className="text-[11px] text-ink-500">{loading ? 'Recomputing deterministic run…' : `Capacity ${capacity} · ${run?.results.filter((result) => result.complete).length ?? 0} evaluable stops`}</p>
          <p className="mt-1 text-[10px] text-ink-400">Same FortyGuard snapshot set and scenario assumptions</p>
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-3">
        <article className="hpe-card p-4"><p className="hpe-label">HPE Coverage@K</p><p className="hpe-num mt-2 text-2xl font-bold text-brand-700">{hpe ? `${hpe.coverage.toFixed(1)}%` : '—'}</p><p className="mt-1 text-[11px] text-ink-500">Share of modelled exposure selected.</p></article>
        <article className="hpe-card p-4"><p className="hpe-label">Difference vs best baseline</p><p className={`hpe-num mt-2 text-2xl font-bold ${uplift >= 0 ? 'text-ok-700' : 'text-stop-700'}`}>{hpe ? `${uplift >= 0 ? '+' : ''}${uplift.toFixed(1)} pts` : '—'}</p><p className="mt-1 text-[11px] text-ink-500">Reported even when the result is negative.</p></article>
        <article className="hpe-card p-4"><p className="hpe-label">Heat contribution</p><p className="hpe-num mt-2 text-2xl font-bold text-heat-700">{heatContribution}</p><p className="mt-1 text-[11px] text-ink-500">Selections changed versus ridership-only.</p></article>
      </section>

      <section className="hpe-card overflow-hidden">
        <div className="border-b border-ink-100 px-5 py-4"><p className="hpe-label">Coverage comparison</p><h2 className="mt-1 text-base font-bold text-ink-900">Modelled exposure represented by the selected stops</h2></div>
        <div className="space-y-5 p-5">
          {strategies.map((strategy) => (
            <article key={strategy.id}>
              <div className="flex items-end justify-between gap-4"><div><p className="text-[13px] font-bold text-ink-900">{strategy.label}</p><p className="mt-0.5 text-[10px] text-ink-500">{strategy.description}</p></div><p className="hpe-num text-[14px] font-bold text-ink-900">{strategy.coverage.toFixed(1)}%</p></div>
              <div className="mt-2 h-3 overflow-hidden rounded-full bg-ink-100" aria-label={`${strategy.label}: ${strategy.coverage.toFixed(1)} percent`}><div className={`h-full rounded-full ${strategy.tone}`} style={{ width: `${Math.min(100, strategy.coverage)}%` }} /></div>
            </article>
          ))}
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <article className="hpe-card p-5"><p className="text-[12px] font-bold text-ink-900">Interpretation rule</p><p className="mt-2 text-[12px] leading-relaxed text-ink-600">Coverage@K measures modelled load inside this run. It is not a health outcome, a causal impact or a count of people protected.</p></article>
        <article className="hpe-card p-5"><p className="text-[12px] font-bold text-ink-900">Honest negative results</p><p className="mt-2 text-[12px] leading-relaxed text-ink-600">If a simpler baseline performs better, the interface says so. The remaining value must come from timing, robustness, uncertainty resolution or auditability.</p></article>
      </section>
    </div>
  )
}
