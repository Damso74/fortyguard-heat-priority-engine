'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'
import { EvidencePill } from '@/components/operations/ModuleHeader'
import { useOperations, type ShadeStatus } from '@/components/operations/OperationsProvider'

const SHADE_OPTIONS = ['present', 'partial', 'absent', 'unknown'] as const
const SHELTER_OPTIONS = ['present', 'absent', 'unknown'] as const
const ACCESSIBILITY_OPTIONS = ['clear', 'constrained', 'unknown'] as const
const CONFIDENCE_OPTIONS = ['low', 'medium', 'high'] as const

function choiceLabel(value: string) {
  return value[0]!.toUpperCase() + value.slice(1)
}

function ChoiceButton({
  active,
  label,
  onClick,
}: {
  active: boolean
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={`flex min-h-12 items-center justify-between gap-1 rounded-xl border px-2 py-2.5 text-left text-[11px] font-semibold transition-colors sm:px-3 sm:text-[12px] ${active ? 'border-brand-500 bg-brand-50 text-brand-700 shadow-sm ring-2 ring-brand-100' : 'border-ink-200 bg-white text-ink-700 hover:border-ink-300 hover:bg-ink-50'}`}
    >
      <span>{label}</span>
      <span
        aria-hidden="true"
        className={`grid h-4 w-4 shrink-0 place-items-center rounded-full border text-[9px] ${active ? 'border-brand-600 bg-brand-600 text-white' : 'border-ink-300 bg-white text-transparent'}`}
      >
        ✓
      </span>
    </button>
  )
}

export function FieldMission({ missionId }: { missionId: string }) {
  const { missions, run, loading, error, refresh, setMissionStatus, submitObservation } = useOperations()
  const mission = useMemo(() => missions.find((entry) => entry.id === missionId), [missionId, missions])
  const [shade, setShade] = useState<ShadeStatus>('unknown')
  const [shelter, setShelter] = useState<'present' | 'absent' | 'unknown'>('unknown')
  const [accessibility, setAccessibility] = useState<'clear' | 'constrained' | 'unknown'>('unknown')
  const [confidence, setConfidence] = useState<'low' | 'medium' | 'high'>('medium')
  const [note, setNote] = useState('')

  if (loading && !run) {
    return <section className="hpe-card mx-auto max-w-lg p-8 text-center" aria-busy="true"><p className="hpe-label">Field mission</p><h1 className="mt-3 text-xl font-bold text-ink-900">Preparing the verified mission</h1><p className="mt-2 text-[13px] text-ink-600">Loading the frozen run and its session workspace…</p></section>
  }

  if (error && !run) {
    return <section className="hpe-card mx-auto max-w-lg p-8 text-center" role="alert"><p className="hpe-label text-stop-700">Mission unavailable</p><h1 className="mt-3 text-xl font-bold text-ink-900">The verified run could not be loaded</h1><p className="mt-2 text-[13px] text-ink-600">{error}</p><button type="button" onClick={refresh} className="hpe-button-primary mt-5">Try again</button></section>
  }

  if (!mission) {
    return (
      <section className="hpe-card mx-auto max-w-lg p-6 text-center">
        <p className="text-base font-bold text-ink-900">Mission not available</p>
        <p className="mt-2 text-[13px] text-ink-600">Open a mission from the inspection queue first.</p>
        <Link href="/missions" className="hpe-button-primary mt-4">Back to missions</Link>
      </section>
    )
  }

  if (mission.observation) {
    return (
      <div className="mx-auto max-w-xl space-y-4">
        <section className="hpe-card p-6 text-center">
          <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-ok-100 text-xl font-bold text-ok-700">✓</span>
          <h1 className="mt-4 text-xl font-bold text-ink-900">Observation submitted</h1>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-600">This session-isolated demo observation is waiting for human review. It has not changed the priority ranking.</p>
          <div className="mt-5 flex justify-center gap-2">
            <Link href="/evidence" className="hpe-button-primary">Review evidence</Link>
            <Link href="/missions" className="hpe-button-secondary">Mission queue</Link>
          </div>
        </section>
      </div>
    )
  }

  const submit = () => {
    if (mission.status === 'draft' || mission.status === 'assigned') {
      setMissionStatus(mission.id, 'in_progress')
    }
    submitObservation(mission.id, { shade, shelter, accessibility, confidence, note: note.trim() })
  }

  const markStarted = () => {
    if (mission.status === 'draft' || mission.status === 'assigned') {
      setMissionStatus(mission.id, 'in_progress')
    }
  }

  const observedSignals = Number(shade !== 'unknown') + Number(shelter !== 'unknown') + Number(accessibility !== 'unknown')

  return (
    <div className="mx-auto max-w-6xl space-y-4 pb-16">
      <nav aria-label="Breadcrumb">
        <Link href="/missions" className="inline-flex min-h-11 items-center text-[13px] font-semibold text-brand-700 hover:underline">
          ← Inspection missions
        </Link>
      </nav>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-4">
          <header className="overflow-hidden rounded-2xl bg-ink-900 text-white shadow-xl shadow-ink-900/10">
            <div className="p-5 sm:p-6">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-orange-200">Mission {mission.rank} of {missions.length}</span>
                <div className="flex items-center gap-2">
                  <span className="rounded-full border border-white/15 bg-white/8 px-2.5 py-1 text-[10px] font-semibold capitalize text-slate-200">{mission.status.replace('_', ' ')}</span>
                  <EvidencePill tone="demo">Session-only field record</EvidencePill>
                </div>
              </div>
              <h1 className="mt-4 text-3xl font-bold leading-tight tracking-[-0.035em] sm:text-4xl">{mission.stopName}</h1>
              <div className="mt-3 flex flex-wrap gap-2 text-[11px] font-semibold text-slate-300">
                <span>Priority #{mission.rank}</span>
                <span aria-hidden="true">·</span>
                <span>{mission.robust ? 'Stable in all tested scenarios' : 'Changes with assumptions'}</span>
                <span aria-hidden="true">·</span>
                <span>Stop {mission.stopId}</span>
              </div>
            </div>

            <div className="grid gap-3 border-t border-white/10 bg-white/5 p-4 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-start sm:px-6">
              <span className="w-fit rounded-lg bg-heat-500 px-2.5 py-1.5 text-[9px] font-bold uppercase tracking-[0.12em] text-white">Why inspect</span>
              <p className="text-[12px] leading-5 text-slate-200">High modelled rider heat exposure within the verified Phoenix run. Record only what can be observed on site; the ranking will not change without human review.</p>
            </div>
          </header>

          <section className="hpe-card overflow-hidden">
            <div className="flex flex-col gap-3 border-b border-ink-100 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
              <div>
                <p className="hpe-label">Field observation</p>
                <h2 className="mt-1 text-lg font-bold tracking-tight text-ink-900">Record visible site conditions</h2>
              </div>
              <div className="flex items-center gap-3">
                <div className="h-2 w-28 overflow-hidden rounded-full bg-ink-100" aria-hidden="true">
                  <span className="block h-full rounded-full bg-brand-600 transition-[width]" style={{ width: `${(observedSignals / 3) * 100}%` }} />
                </div>
                <span className="hpe-num text-[11px] font-bold text-ink-600">{observedSignals}/3 observed</span>
              </div>
            </div>

            <div className="divide-y divide-ink-100 px-4 sm:px-5">
              <fieldset className="py-5">
                <legend className="text-[13px] font-bold text-ink-900">Shade condition</legend>
                <p className="mt-1 text-[11px] leading-4 text-ink-500">Estimate the shade available where riders wait.</p>
                <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {SHADE_OPTIONS.map((value) => (
                    <ChoiceButton key={value} label={choiceLabel(value)} active={shade === value} onClick={() => { markStarted(); setShade(value) }} />
                  ))}
                </div>
              </fieldset>

              <div className="grid gap-5 py-5 min-[520px]:grid-cols-2">
                <fieldset>
                  <legend className="text-[13px] font-bold text-ink-900">Shelter</legend>
                  <p className="mt-1 text-[11px] leading-4 text-ink-500">Is a rider shelter physically present?</p>
                  <div className="mt-3 grid grid-cols-3 gap-2">
                    {SHELTER_OPTIONS.map((value) => (
                      <ChoiceButton key={value} label={choiceLabel(value)} active={shelter === value} onClick={() => { markStarted(); setShelter(value) }} />
                    ))}
                  </div>
                </fieldset>

                <fieldset>
                  <legend className="text-[13px] font-bold text-ink-900">Accessibility</legend>
                  <p className="mt-1 text-[11px] leading-4 text-ink-500">Can the boarding and waiting area be used safely?</p>
                  <div className="mt-3 grid grid-cols-3 gap-2">
                    {ACCESSIBILITY_OPTIONS.map((value) => (
                      <ChoiceButton key={value} label={choiceLabel(value)} active={accessibility === value} onClick={() => { markStarted(); setAccessibility(value) }} />
                    ))}
                  </div>
                </fieldset>
              </div>

              <div className="grid gap-5 py-5 min-[520px]:grid-cols-[minmax(0,1fr)_220px]">
                <div>
                  <label htmlFor="field-note" className="text-[13px] font-bold text-ink-900">Field note <span className="font-normal text-ink-500">(optional)</span></label>
                  <p className="mt-1 text-[11px] leading-4 text-ink-500">Describe only observable conditions. Never include personal information.</p>
                  <textarea id="field-note" value={note} maxLength={500} onChange={(event) => { markStarted(); setNote(event.target.value) }} placeholder="Example: west-facing bench; no shade at 14:00." className="mt-3 min-h-28 w-full rounded-xl border border-ink-200 bg-white p-3 text-[16px] text-ink-900 placeholder:text-ink-500" />
                  <p className="mt-1 text-right text-[11px] text-ink-500">{note.length}/500</p>
                </div>

                <fieldset>
                  <legend className="text-[13px] font-bold text-ink-900">Confidence</legend>
                  <p className="mt-1 text-[11px] leading-4 text-ink-500">How certain are you about this observation?</p>
                  <div className="mt-3 grid grid-cols-3 gap-2 min-[520px]:grid-cols-1">
                    {CONFIDENCE_OPTIONS.map((value) => (
                      <ChoiceButton key={value} label={choiceLabel(value)} active={confidence === value} onClick={() => { markStarted(); setConfidence(value) }} />
                    ))}
                  </div>
                </fieldset>
              </div>
            </div>
          </section>
        </div>

        <aside className="space-y-4 lg:sticky lg:top-6">
          <section className="overflow-hidden rounded-2xl bg-gradient-to-br from-brand-700 to-ink-900 p-5 text-white shadow-xl">
            <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-brand-100">Mission checkpoint</p>
            <dl className="mt-3 grid grid-cols-2 gap-2 rounded-xl border border-white/10 bg-white/7 p-3 text-[11px]">
              <div><dt className="text-slate-300">Conditions</dt><dd className="hpe-num mt-1 font-bold text-white">{observedSignals} of 3 observed</dd></div>
              <div><dt className="text-slate-300">Confidence</dt><dd className="mt-1 font-bold capitalize text-white">{confidence}</dd></div>
            </dl>
            <h2 className="mt-2 text-xl font-bold tracking-tight">Submit the field record</h2>
            <p className="mt-2 text-[12px] leading-5 text-slate-300">Unknown is an acceptable answer. A reviewer must accept this evidence before the decision can advance to v2.</p>
            <button type="button" onClick={submit} className="mt-5 min-h-12 w-full rounded-xl bg-heat-500 px-4 py-3 text-[14px] font-bold text-white shadow-lg transition-colors hover:bg-heat-600">Submit demo observation</button>
            <p className="mt-3 truncate text-center font-mono text-[9px] leading-4 text-slate-300">Run {run?.runId ?? 'loading'} · no silent ranking change</p>
          </section>
        </aside>
      </div>
    </div>
  )
}
