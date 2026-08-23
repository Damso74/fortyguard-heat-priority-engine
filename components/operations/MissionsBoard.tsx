'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'
import { EvidencePill, ModuleHeader } from '@/components/operations/ModuleHeader'
import { useOperations, type MissionStatus } from '@/components/operations/OperationsProvider'

const STATUS_LABEL: Record<MissionStatus, string> = {
  draft: 'Draft',
  assigned: 'Assigned',
  in_progress: 'In progress',
  submitted: 'Submitted',
  reviewed: 'Reviewed',
}

export function MissionsBoard() {
  const { missions, run, setMissionStatus, resetDemoWorkspace } = useOperations()
  const [filter, setFilter] = useState<'all' | MissionStatus>('all')
  const visible = useMemo(
    () => missions.filter((mission) => filter === 'all' || mission.status === filter),
    [filter, missions],
  )
  const nextMission = missions.find((mission) => mission.observation?.review === 'pending') ?? missions[0]
  const hasPendingEvidence = missions.some((mission) => mission.observation?.review === 'pending')

  return (
    <div className="space-y-5">
      <ModuleHeader
        eyebrow="Inspect & validate"
        title="Inspection missions"
        description="Convert a frozen priority plan into bounded field work. Every mission retains the exact run, rank and evidence state that created it."
        actions={
          <>
            <button type="button" onClick={resetDemoWorkspace} className="rounded-md border border-ink-200 bg-white px-3 py-2 text-[12px] font-semibold text-ink-700 hover:bg-ink-50">
              Reset demo workspace
            </button>
            {nextMission ? (
              <Link href={hasPendingEvidence ? '/evidence' : `/missions/${nextMission.id}`} className="rounded-md bg-brand-600 px-3 py-2 text-[12px] font-semibold text-white hover:bg-brand-700">
                {hasPendingEvidence ? 'Review field evidence →' : 'Open top mission →'}
              </Link>
            ) : null}
          </>
        }
      />

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5" aria-label="Mission status summary">
        {(['draft', 'assigned', 'in_progress', 'submitted', 'reviewed'] as const).map((status) => (
          <button
            key={status}
            type="button"
            onClick={() => setFilter(filter === status ? 'all' : status)}
            aria-pressed={filter === status}
            className={`hpe-card p-4 text-left transition ${filter === status ? 'border-brand-500 ring-2 ring-brand-100' : 'hover:border-ink-300'}`}
          >
            <p className="hpe-label">{STATUS_LABEL[status]}</p>
            <p className="hpe-num mt-2 text-2xl font-bold text-ink-900">{missions.filter((mission) => mission.status === status).length}</p>
          </button>
        ))}
      </section>

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <article className="hpe-card overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-100 px-5 py-4">
            <div>
              <p className="hpe-label">Plan v1 · capacity {run?.plan.capacity ?? 10}</p>
              <h2 className="mt-1 text-base font-bold text-ink-900">Downtown Phoenix inspection queue</h2>
            </div>
            <EvidencePill tone="demo">Session-isolated demo</EvidencePill>
          </div>
          <div className="divide-y divide-ink-100">
            {visible.length === 0 ? (
              <div className="p-8 text-center text-[13px] text-ink-500">No missions match this status.</div>
            ) : visible.map((mission) => (
              <div key={mission.id} className="grid gap-3 px-5 py-4 md:grid-cols-[48px_minmax(0,1fr)_auto] md:items-center">
                <span className="hpe-num grid h-10 w-10 place-items-center rounded-lg bg-ink-50 text-[12px] font-bold text-ink-700">#{mission.rank}</span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-[13px] font-bold text-ink-900">{mission.stopName}</p>
                    <EvidencePill tone={mission.robust ? 'verified' : 'warn'}>{mission.robust ? 'Robust' : 'Conditional'}</EvidencePill>
                  </div>
                  <p className="mt-1 text-[11px] text-ink-500">Mission {mission.id} · linked to verified run {run?.runId.slice(0, 10) ?? 'loading'}…</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full bg-ink-50 px-2.5 py-1 text-[10px] font-semibold text-ink-700">{STATUS_LABEL[mission.status]}</span>
                  {mission.status === 'draft' && (
                    <button type="button" onClick={() => setMissionStatus(mission.id, 'assigned')} className="rounded-md border border-ink-200 bg-white px-3 py-2 text-[11px] font-semibold text-ink-700 hover:bg-ink-50">Assign</button>
                  )}
                  <Link href={`/missions/${mission.id}`} className="rounded-md bg-brand-600 px-3 py-2 text-[11px] font-semibold text-white hover:bg-brand-700">
                    Open mission
                  </Link>
                </div>
              </div>
            ))}
          </div>
        </article>

        <aside className="space-y-4">
          <article className="hpe-card p-4">
            <p className="hpe-label">Mission contract</p>
            <ul className="mt-3 space-y-2 text-[12px] leading-relaxed text-ink-700">
              <li>✓ Linked to a frozen plan and source snapshot.</li>
              <li>✓ Captures unknown field conditions only.</li>
              <li>✓ Requires human review before influencing a revision.</li>
              <li>✓ Preserves every prior decision version.</li>
            </ul>
          </article>
          <article className="hpe-card border-l-4 border-l-brand-500 p-4">
            <p className="text-[12px] font-bold text-ink-900">No schedule entry required</p>
            <p className="mt-2 text-[12px] leading-relaxed text-ink-600">Service and waiting context comes from GTFS. The inspector records only what the current datasets cannot know.</p>
          </article>
        </aside>
      </section>
    </div>
  )
}
