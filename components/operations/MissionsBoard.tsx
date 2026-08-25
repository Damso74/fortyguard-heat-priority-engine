'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'
import { ModuleHeader } from '@/components/operations/ModuleHeader'
import { useOperations } from '@/components/operations/OperationsProvider'

type MissionFilter = 'to_inspect' | 'in_progress' | 'reviewed'

const FILTER_LABEL: Record<MissionFilter, string> = {
  to_inspect: 'To inspect',
  in_progress: 'In progress',
  reviewed: 'Reviewed',
}

export function MissionsBoard() {
  const { missions, run, loading, error, refresh, setMissionStatus, resetDemoWorkspace } = useOperations()
  const [filter, setFilter] = useState<MissionFilter>('to_inspect')
  const [confirmingReset, setConfirmingReset] = useState(false)

  const counts = useMemo(() => ({
    to_inspect: missions.filter((mission) => mission.status === 'draft' || mission.status === 'assigned').length,
    in_progress: missions.filter((mission) => ['in_progress', 'submitted'].includes(mission.status)).length,
    reviewed: missions.filter((mission) => mission.status === 'reviewed').length,
  }), [missions])

  const visible = useMemo(() => missions.filter((mission) => {
    if (filter === 'to_inspect') return mission.status === 'draft' || mission.status === 'assigned'
    if (filter === 'in_progress') return mission.status === 'in_progress' || mission.status === 'submitted'
    return mission.status === 'reviewed'
  }), [filter, missions])

  const reviewNeeded = missions.some((mission) => mission.observation?.review === 'pending' || mission.observation?.review === 'rejected')
  const nextMission = missions.find((mission) => mission.status !== 'reviewed' && !mission.observation)

  return (
    <div className="space-y-5">
      <ModuleHeader
        eyebrow="Field work"
        title="Inspection missions"
        description="Open the highest-priority stop and record what the datasets cannot see."
        actions={reviewNeeded
          ? <Link href="/evidence" className="hpe-button-primary">Review observations →</Link>
          : nextMission
            ? <Link href={`/missions/${nextMission.id}`} className="hpe-button-primary">Open next mission →</Link>
            : null}
      />

      {loading && !run ? (
        <section className="hpe-card p-8 text-center" aria-busy="true"><p className="font-bold text-ink-900">Preparing missions…</p></section>
      ) : error && !run ? (
        <section className="hpe-card p-8 text-center" role="alert"><p className="font-bold text-stop-700">The mission queue could not be loaded.</p><p className="mt-2 text-[13px] text-ink-600">{error}</p><button type="button" onClick={refresh} className="hpe-button-primary mt-5">Try again</button></section>
      ) : null}

      {confirmingReset ? (
        <section className="hpe-card flex flex-col gap-3 border-stop-700/25 bg-stop-100/50 p-4 sm:flex-row sm:items-center sm:justify-between" role="alert">
          <div><p className="text-[13px] font-bold text-stop-700">Reset every demo mission and observation?</p><p className="mt-1 text-[12px] text-ink-700">This affects only this browser session and cannot be undone.</p></div>
          <div className="flex gap-2"><button type="button" onClick={() => setConfirmingReset(false)} className="hpe-button-secondary">Cancel</button><button type="button" onClick={() => { resetDemoWorkspace(); setConfirmingReset(false) }} className="hpe-button-danger">Confirm reset</button></div>
        </section>
      ) : null}

      <div className="flex flex-wrap gap-2" role="group" aria-label="Mission status">
        {(Object.keys(FILTER_LABEL) as MissionFilter[]).map((status) => (
          <button
            key={status}
            type="button"
            onClick={() => setFilter(status)}
            aria-pressed={filter === status}
            className={`min-h-11 rounded-lg border px-4 py-2 text-[12px] font-semibold ${filter === status ? 'border-brand-600 bg-brand-600 text-white' : 'border-ink-200 bg-white text-ink-700 hover:bg-ink-50'}`}
          >
            {FILTER_LABEL[status]} · {counts[status]}
          </button>
        ))}
      </div>

      <section className="hpe-card overflow-hidden">
        <div className="border-b border-ink-100 px-5 py-4"><p className="hpe-label">Downtown Phoenix</p><h2 className="mt-1 text-base font-bold text-ink-900">{FILTER_LABEL[filter]}</h2></div>
        <div className="divide-y divide-ink-100">
          {visible.length === 0 ? (
            <div className="p-10 text-center"><p className="text-[14px] font-semibold text-ink-800">Nothing here right now.</p><p className="mt-1 text-[12px] text-ink-500">Choose another status to view the rest of the queue.</p></div>
          ) : visible.map((mission) => (
            <article key={mission.id} className="grid gap-3 px-5 py-4 md:grid-cols-[44px_minmax(0,1fr)_auto] md:items-center">
              <span className="hpe-num text-[13px] font-bold text-ink-500">#{mission.rank}</span>
              <div className="min-w-0"><h3 className="truncate text-[13px] font-bold text-ink-900">{mission.stopName}</h3><p className="mt-1 text-[11px] text-ink-500">{mission.robust ? 'Stable in all tested combinations' : 'Changes with assumptions'}</p></div>
              <div className="flex flex-wrap items-center gap-2">
                {mission.status === 'draft' ? <button type="button" onClick={() => setMissionStatus(mission.id, 'assigned')} className="hpe-button-secondary">Assign</button> : null}
                <Link href={`/missions/${mission.id}`} className="hpe-button-primary">Open mission</Link>
              </div>
            </article>
          ))}
        </div>
      </section>

      <details className="hpe-card p-4 text-[12px] text-ink-600">
        <summary className="min-h-11 cursor-pointer py-2 font-semibold text-brand-700">Demo controls and workflow rules</summary>
        <p className="mt-2 max-w-2xl leading-5">Each mission stays linked to its ranked stop. Field observations require a separate human review and never change the thermal ranking silently.</p>
        <button type="button" onClick={() => setConfirmingReset(true)} className="hpe-button-secondary mt-4">Reset demo workspace</button>
      </details>
    </div>
  )
}
