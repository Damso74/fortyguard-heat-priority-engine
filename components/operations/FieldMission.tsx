'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { EvidencePill } from '@/components/operations/ModuleHeader'
import { useOperations, type ShadeStatus } from '@/components/operations/OperationsProvider'

export function FieldMission({ missionId }: { missionId: string }) {
  const { missions, run, setMissionStatus, submitObservation } = useOperations()
  const mission = useMemo(() => missions.find((entry) => entry.id === missionId), [missionId, missions])
  const [shade, setShade] = useState<ShadeStatus>('unknown')
  const [shelter, setShelter] = useState<'present' | 'absent' | 'unknown'>('unknown')
  const [accessibility, setAccessibility] = useState<'clear' | 'constrained' | 'unknown'>('unknown')
  const [confidence, setConfidence] = useState<'low' | 'medium' | 'high'>('medium')
  const [note, setNote] = useState('')

  useEffect(() => {
    if (mission?.status === 'assigned') setMissionStatus(mission.id, 'in_progress')
  }, [mission, setMissionStatus])

  if (!mission) {
    return (
      <section className="hpe-card mx-auto max-w-lg p-6 text-center">
        <p className="text-base font-bold text-ink-900">Mission not available</p>
        <p className="mt-2 text-[13px] text-ink-600">Open a mission from the inspection queue first.</p>
        <Link href="/missions" className="mt-4 inline-flex rounded-md bg-brand-600 px-4 py-2 text-[12px] font-semibold text-white">Back to missions</Link>
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
            <Link href="/evidence" className="rounded-md bg-brand-600 px-4 py-2 text-[12px] font-semibold text-white">Review evidence</Link>
            <Link href="/missions" className="rounded-md border border-ink-200 px-4 py-2 text-[12px] font-semibold text-ink-700">Mission queue</Link>
          </div>
        </section>
      </div>
    )
  }

  const submit = () => {
    submitObservation(mission.id, { shade, shelter, accessibility, confidence, note: note.trim() })
  }

  const choiceClass = (active: boolean) => `min-h-12 rounded-lg border px-3 py-3 text-left text-[12px] font-semibold ${active ? 'border-brand-500 bg-brand-50 text-brand-700 ring-2 ring-brand-100' : 'border-ink-200 bg-white text-ink-700'}`

  return (
    <div className="mx-auto max-w-2xl space-y-4 pb-24">
      <header className="hpe-card overflow-hidden">
        <div className="bg-[#0f2238] p-5 text-white">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-300">Mission {mission.rank} of {missions.length}</span>
            <EvidencePill tone="demo">Demo input</EvidencePill>
          </div>
          <h1 className="mt-3 text-2xl font-bold tracking-tight">{mission.stopName}</h1>
          <p className="mt-2 text-[12px] text-slate-300">Priority #{mission.rank} · {mission.robust ? 'robust across all scenarios' : 'assumption-dependent candidate'}</p>
        </div>
        <div className="p-4">
          <p className="hpe-label">Why here?</p>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-700">High modelled rider heat exposure within the verified Phoenix run. Shelter and site conditions remain unknown and require observation.</p>
          <p className="mt-2 font-mono text-[10px] text-ink-500">Run {run?.runId ?? 'loading'}</p>
        </div>
      </header>

      <section className="hpe-card p-4">
        <p className="hpe-label">1 · Confirm location</p>
        <div className="mt-3 rounded-lg bg-ink-50 p-3">
          <p className="text-[13px] font-bold text-ink-900">{mission.stopName}</p>
          <p className="mt-1 text-[11px] text-ink-500">Stop ID {mission.stopId} · Phoenix local workflow</p>
        </div>
      </section>

      <section className="hpe-card p-4">
        <p className="hpe-label">2 · Shade condition</p>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {(['present', 'partial', 'absent', 'unknown'] as const).map((value) => <button key={value} type="button" onClick={() => setShade(value)} className={choiceClass(shade === value)}>{value[0]!.toUpperCase() + value.slice(1)}</button>)}
        </div>
      </section>

      <section className="hpe-card p-4">
        <p className="hpe-label">3 · Infrastructure</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <fieldset><legend className="text-[11px] font-semibold text-ink-700">Shelter</legend><div className="mt-2 grid grid-cols-3 gap-2">{(['present', 'absent', 'unknown'] as const).map((value) => <button key={value} type="button" onClick={() => setShelter(value)} className={choiceClass(shelter === value)}>{value}</button>)}</div></fieldset>
          <fieldset><legend className="text-[11px] font-semibold text-ink-700">Accessibility</legend><div className="mt-2 grid grid-cols-3 gap-2">{(['clear', 'constrained', 'unknown'] as const).map((value) => <button key={value} type="button" onClick={() => setAccessibility(value)} className={choiceClass(accessibility === value)}>{value}</button>)}</div></fieldset>
        </div>
      </section>

      <section className="hpe-card p-4">
        <label htmlFor="field-note" className="hpe-label">4 · Optional note</label>
        <textarea id="field-note" value={note} maxLength={500} onChange={(event) => setNote(event.target.value)} placeholder="Record only observable site conditions. Do not include personal information." className="mt-3 min-h-24 w-full rounded-lg border border-ink-200 bg-white p-3 text-[16px] text-ink-900 placeholder:text-ink-400" />
        <p className="mt-1 text-right text-[10px] text-ink-400">{note.length}/500</p>
      </section>

      <section className="hpe-card p-4">
        <p className="hpe-label">5 · Confidence and submit</p>
        <div className="mt-3 grid grid-cols-3 gap-2">{(['low', 'medium', 'high'] as const).map((value) => <button key={value} type="button" onClick={() => setConfidence(value)} className={choiceClass(confidence === value)}>{value[0]!.toUpperCase() + value.slice(1)}</button>)}</div>
        <button type="button" onClick={submit} className="mt-4 min-h-12 w-full rounded-lg bg-[#e85d2a] px-4 py-3 text-[14px] font-bold text-white hover:bg-[#cf4d20]">Submit demo observation</button>
        <p className="mt-2 text-center text-[10px] leading-relaxed text-ink-500">Human review is required before this evidence can create plan v2.</p>
      </section>
    </div>
  )
}
