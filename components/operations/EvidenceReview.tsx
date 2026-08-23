'use client'

import Link from 'next/link'
import { EvidencePill, ModuleHeader } from '@/components/operations/ModuleHeader'
import { useOperations } from '@/components/operations/OperationsProvider'

export function EvidenceReview() {
  const { missions, planVersion, reviewObservation } = useOperations()
  const submitted = missions.filter((mission) => mission.observation)
  const pending = submitted.filter((mission) => mission.observation?.review === 'pending')
  const accepted = submitted.filter((mission) => mission.observation?.review === 'accepted')

  return (
    <div className="space-y-5">
      <ModuleHeader
        eyebrow="Inspect & validate"
        title="Evidence review"
        description="Validate field observations before they influence operational readiness. The original ranking stays preserved and every review decision is visible."
        actions={
          <>
            <EvidencePill tone={planVersion > 1 ? 'verified' : 'warn'}>Plan v{planVersion}</EvidencePill>
            <Link href="/scenarios" className="rounded-md bg-brand-600 px-3 py-2 text-[12px] font-semibold text-white hover:bg-brand-700">
              Compare scenarios →
            </Link>
          </>
        }
      />

      <section className="grid gap-3 sm:grid-cols-3">
        <article className="hpe-card p-4"><p className="hpe-label">Pending review</p><p className="hpe-num mt-2 text-2xl font-bold">{pending.length}</p><p className="mt-1 text-[11px] text-ink-500">Cannot influence a revision yet.</p></article>
        <article className="hpe-card p-4"><p className="hpe-label">Accepted evidence</p><p className="hpe-num mt-2 text-2xl font-bold text-ok-700">{accepted.length}</p><p className="mt-1 text-[11px] text-ink-500">Human-verified in this demo workspace.</p></article>
        <article className="hpe-card p-4"><p className="hpe-label">Current decision version</p><p className="hpe-num mt-2 text-2xl font-bold">v{planVersion}</p><p className="mt-1 text-[11px] text-ink-500">Plan v1 is never overwritten.</p></article>
      </section>

      {submitted.length === 0 ? (
        <section className="hpe-card p-10 text-center">
          <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-ink-50 text-lg font-bold text-ink-400">0</span>
          <h2 className="mt-4 text-lg font-bold text-ink-900">No observations submitted</h2>
          <p className="mx-auto mt-2 max-w-md text-[13px] leading-relaxed text-ink-600">Open a field mission and submit a session-isolated demo observation. It will appear here for explicit human review.</p>
          <Link href="/missions" className="mt-5 inline-flex rounded-md bg-brand-600 px-4 py-2.5 text-[12px] font-semibold text-white">Open inspection missions</Link>
        </section>
      ) : (
        <section className="space-y-4">
          {submitted.map((mission) => {
            const observation = mission.observation!
            return (
              <article key={mission.id} className="hpe-card overflow-hidden">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-100 px-5 py-4">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-[14px] font-bold text-ink-900">#{mission.rank} · {mission.stopName}</h2>
                      <EvidencePill tone="demo">Demo input</EvidencePill>
                      <EvidencePill tone={observation.review === 'accepted' ? 'verified' : observation.review === 'pending' ? 'warn' : 'neutral'}>{observation.review}</EvidencePill>
                    </div>
                    <p className="mt-1 text-[11px] text-ink-500">Submitted {new Date(observation.createdAtUtc).toLocaleString('en-US', { timeZone: 'America/Phoenix' })} Phoenix time</p>
                  </div>
                  {observation.review === 'pending' && (
                    <div className="flex flex-wrap gap-2">
                      <button type="button" onClick={() => reviewObservation(mission.id, 'reinspect')} className="rounded-md border border-ink-200 bg-white px-3 py-2 text-[11px] font-semibold text-ink-700">Request reinspection</button>
                      <button type="button" onClick={() => reviewObservation(mission.id, 'rejected')} className="rounded-md border border-stop-700/25 bg-stop-100 px-3 py-2 text-[11px] font-semibold text-stop-700">Reject</button>
                      <button type="button" onClick={() => reviewObservation(mission.id, 'accepted')} className="rounded-md bg-ok-700 px-3 py-2 text-[11px] font-semibold text-white">Accept evidence</button>
                    </div>
                  )}
                </div>
                <div className="grid gap-4 p-5 md:grid-cols-[minmax(0,1fr)_320px]">
                  <dl className="grid grid-cols-2 gap-3 text-[12px] sm:grid-cols-4">
                    <div className="rounded-lg bg-ink-50 p-3"><dt className="text-[10px] text-ink-500">Shade</dt><dd className="mt-1 font-bold text-ink-900">{observation.shade}</dd></div>
                    <div className="rounded-lg bg-ink-50 p-3"><dt className="text-[10px] text-ink-500">Shelter</dt><dd className="mt-1 font-bold text-ink-900">{observation.shelter}</dd></div>
                    <div className="rounded-lg bg-ink-50 p-3"><dt className="text-[10px] text-ink-500">Accessibility</dt><dd className="mt-1 font-bold text-ink-900">{observation.accessibility}</dd></div>
                    <div className="rounded-lg bg-ink-50 p-3"><dt className="text-[10px] text-ink-500">Confidence</dt><dd className="mt-1 font-bold text-ink-900">{observation.confidence}</dd></div>
                    {observation.note && <div className="col-span-2 rounded-lg border border-ink-100 p-3 sm:col-span-4"><dt className="text-[10px] text-ink-500">Field note</dt><dd className="mt-1 leading-relaxed text-ink-700">{observation.note}</dd></div>}
                  </dl>
                  <div className="rounded-lg border border-flag-700/20 bg-flag-100/40 p-4">
                    <p className="text-[11px] font-bold text-ink-900">Effect on the decision</p>
                    <p className="mt-2 text-[11px] leading-relaxed text-ink-700">
                      Accepted evidence creates plan v2 and updates evidence readiness. It does not silently alter the thermal ranking because shade is not yet a validated scoring input.
                    </p>
                  </div>
                </div>
              </article>
            )
          })}
        </section>
      )}
    </div>
  )
}
