'use client'

import Link from 'next/link'
import { EvidencePill, ModuleHeader } from '@/components/operations/ModuleHeader'
import { useOperations } from '@/components/operations/OperationsProvider'

export function EvidenceReview() {
  const { missions, run, loading, error, refresh, planVersion, reviewObservation } = useOperations()
  const submitted = missions.filter((mission) => mission.observation)
  const pending = submitted.filter((mission) => mission.observation?.review === 'pending')
  const accepted = submitted.filter((mission) => mission.observation?.review === 'accepted')

  return (
    <div className="space-y-5">
      <ModuleHeader
        eyebrow="Human review"
        title="Evidence review"
        description="Accept, reject or return each submitted field observation."
        actions={<Link href="/missions" className="hpe-button-secondary">Back to missions</Link>}
      />

      {loading && !run ? (
        <section className="hpe-card p-8 text-center" aria-busy="true"><p className="text-base font-bold text-ink-900">Preparing the evidence register</p><p className="mt-2 text-[13px] text-ink-600">Loading the frozen plan and session observations…</p></section>
      ) : error && !run ? (
        <section className="hpe-card p-8 text-center" role="alert"><p className="text-base font-bold text-stop-700">The evidence register could not be loaded</p><p className="mt-2 text-[13px] text-ink-600">{error}</p><button type="button" onClick={refresh} className="hpe-button-primary mt-5">Try again</button></section>
      ) : null}

      <p className="text-[12px] font-semibold text-ink-700">{pending.length} awaiting review · {accepted.length} accepted{planVersion > 1 ? ` · Decision v${planVersion}` : ''}</p>

      {submitted.length === 0 ? (
        <section className="hpe-card p-10 text-center">
          <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-ink-50 text-lg font-bold text-ink-400">0</span>
          <h2 className="mt-4 text-lg font-bold text-ink-900">No observations submitted</h2>
          <p className="mx-auto mt-2 max-w-md text-[13px] leading-relaxed text-ink-600">Open a field mission and submit a session-isolated demo observation. It will appear here for explicit human review.</p>
          <Link href="/missions" className="hpe-button-primary mt-5">Open inspection missions</Link>
        </section>
      ) : (
        <section className="space-y-4">
          {[...submitted].sort((a, b) => Number(b.observation?.review === 'pending') - Number(a.observation?.review === 'pending')).map((mission) => {
            const observation = mission.observation!
            return (
              <article key={mission.id} className="hpe-card overflow-hidden">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-100 px-5 py-4">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-[14px] font-bold text-ink-900">#{mission.rank} · {mission.stopName}</h2>
                      <EvidencePill tone="demo">Session-only field record</EvidencePill>
                      <EvidencePill tone={observation.review === 'accepted' ? 'verified' : observation.review === 'pending' ? 'warn' : 'neutral'}>{observation.review}</EvidencePill>
                    </div>
                    <p className="mt-1 text-[11px] text-ink-500">Submitted {new Date(observation.createdAtUtc).toLocaleString('en-US', { timeZone: 'America/Phoenix' })} Phoenix time</p>
                  </div>
                  {observation.review === 'pending' && (
                    <div className="flex flex-wrap gap-2">
                      <button type="button" onClick={() => reviewObservation(mission.id, 'reinspect')} className="hpe-button-secondary">Request reinspection</button>
                      <button type="button" onClick={() => reviewObservation(mission.id, 'rejected')} className="hpe-button-danger">Reject</button>
                      <button type="button" onClick={() => reviewObservation(mission.id, 'accepted')} className="hpe-button-success">Accept evidence</button>
                    </div>
                  )}
                  {observation.review === 'rejected' && (
                    <button type="button" onClick={() => reviewObservation(mission.id, 'reinspect')} className="hpe-button-primary">
                      Reopen for inspection
                    </button>
                  )}
                </div>
                <div className="p-5">
                  <dl className="grid grid-cols-2 gap-3 text-[12px] sm:grid-cols-4">
                    <div className="rounded-lg bg-ink-50 p-3"><dt className="text-[10px] text-ink-500">Shade</dt><dd className="mt-1 font-bold text-ink-900">{observation.shade}</dd></div>
                    <div className="rounded-lg bg-ink-50 p-3"><dt className="text-[10px] text-ink-500">Shelter</dt><dd className="mt-1 font-bold text-ink-900">{observation.shelter}</dd></div>
                    <div className="rounded-lg bg-ink-50 p-3"><dt className="text-[10px] text-ink-500">Accessibility</dt><dd className="mt-1 font-bold text-ink-900">{observation.accessibility}</dd></div>
                    <div className="rounded-lg bg-ink-50 p-3"><dt className="text-[10px] text-ink-500">Confidence</dt><dd className="mt-1 font-bold text-ink-900">{observation.confidence}</dd></div>
                    {observation.note && <div className="col-span-2 rounded-lg border border-ink-100 p-3 sm:col-span-4"><dt className="text-[10px] text-ink-500">Field note</dt><dd className="mt-1 leading-relaxed text-ink-700">{observation.note}</dd></div>}
                  </dl>
                  <p className="mt-4 border-t border-ink-100 pt-3 text-[11px] leading-5 text-ink-500">Human review updates the decision record. It never changes the thermal ranking silently.</p>
                </div>
              </article>
            )
          })}
        </section>
      )}
    </div>
  )
}
