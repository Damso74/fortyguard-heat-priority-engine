'use client'

import Link from 'next/link'
import { EvidencePill, ModuleHeader } from '@/components/operations/ModuleHeader'
import { useOperations } from '@/components/operations/OperationsProvider'

function download(name: string, type: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  URL.revokeObjectURL(url)
}

function csvCell(value: unknown): string {
  const text = String(value ?? '')
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

export function ReportsAudit() {
  const { run, loading, error, refresh, missions, planVersion } = useOperations()
  const accepted = missions.filter((mission) => mission.observation?.review === 'accepted')
  const pending = missions.filter((mission) => mission.observation?.review === 'pending')
  const observations = missions.filter((mission) => mission.observation)
  const fieldReview = pending.length > 0
    ? { label: 'Pending', className: 'text-flag-700' }
    : accepted.length > 0
      ? { label: 'Reviewed', className: 'text-ok-700' }
      : { label: 'Not started', className: 'text-ink-500' }
  const licensingBlocked =
    run?.manifest.claimsBlocked.includes('raw_layer_redistribution_permitted') ?? true

  const exportJson = () => {
    if (!run) return
    download(
      `heat-priority-engine-${run.runId.slice(0, 12)}-plan-v${planVersion}.json`,
      'application/json',
      JSON.stringify(
        {
          generatedAtUtc: new Date().toISOString(),
          label: 'Independent decision-support pilot',
          run: {
            runId: run.runId,
            request: run.request,
            dataMode: run.manifest.dataMode,
            productMode: run.manifest.mode,
            thermal: run.thermal,
            plan: run.plan,
            audit: run.audit,
          },
          operationalRevision: { version: planVersion, missions },
          limitations: [
            'No persistent local-hotspot claim is supported by this run.',
            'Field observations in this package are session-isolated demo inputs.',
            'No causal, cooling, cost, feasibility or people-protected outcome is claimed.',
          ],
        },
        null,
        2,
      ),
    )
  }

  const exportCsv = () => {
    const rows = [
      ['mission_id', 'stop_id', 'stop_name', 'rank', 'robust', 'status', 'shade', 'shelter', 'accessibility', 'confidence', 'review'],
      ...missions.map((mission) => [mission.id, mission.stopId, mission.stopName, mission.rank, mission.robust, mission.status, mission.observation?.shade, mission.observation?.shelter, mission.observation?.accessibility, mission.observation?.confidence, mission.observation?.review]),
    ]
    download('heat-priority-engine-missions.csv', 'text/csv;charset=utf-8', rows.map((row) => row.map(csvCell).join(',')).join('\n'))
  }

  return (
    <div className="space-y-5">
      <ModuleHeader
        eyebrow="Reviewed decision"
        title="Reports & audit"
        description="Print the decision, its review status and its limits."
        actions={<button type="button" onClick={() => window.print()} disabled={!run} className="hpe-button-primary">Print or save PDF</button>}
      />

      {loading && !run ? (
        <section className="hpe-card p-8 text-center" aria-busy="true"><p className="text-base font-bold text-ink-900">Preparing the audit package</p><p className="mt-2 text-[13px] text-ink-600">Loading the exact run identity and decision evidence…</p></section>
      ) : error && !run ? (
        <section className="hpe-card p-8 text-center" role="alert"><p className="text-base font-bold text-stop-700">The audit package could not be prepared</p><p className="mt-2 text-[13px] text-ink-600">{error}</p><button type="button" onClick={refresh} className="hpe-button-primary mt-5">Try again</button></section>
      ) : null}

      <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]" aria-busy={!run}>
        <article className="hpe-card overflow-hidden" aria-labelledby="decision-brief-title">
          <div className="border-b border-ink-100 bg-ink-900 px-6 py-5 text-white">
            <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-300">Decision brief · {planVersion > 1 ? `revision v${planVersion}` : 'initial decision'}</p><h2 id="decision-brief-title" className="mt-2 text-xl font-bold">Phoenix transit heat inspection priorities</h2>
          </div>
          <div className="space-y-5 p-6">
            <section><p className="hpe-label">Decision</p><p className="mt-2 text-lg font-bold text-ink-900">Prepare {run?.plan.capacity ?? 10} inspection candidates.</p><p className="mt-2 text-[12px] text-ink-600">{run?.plan.robustIds.length ?? 0} remain selected in every test · {run?.plan.assumptionDependentIds.length ?? 0} change with assumptions.</p></section>
            <section className="grid gap-3 sm:grid-cols-3"><div className="rounded-lg bg-ink-50 p-3"><p className="text-[10px] text-ink-500">Area</p><p className="mt-1 text-[12px] font-bold">Downtown Phoenix</p></div><div className="rounded-lg bg-ink-50 p-3"><p className="text-[10px] text-ink-500">Measurements</p><p className="hpe-num mt-1 text-[12px] font-bold">{run?.thermal.cellCount ?? '—'}</p></div><div className="rounded-lg bg-ink-50 p-3"><p className="text-[10px] text-ink-500">Tested combinations</p><p className="hpe-num mt-1 text-[12px] font-bold">{run?.plan.scenarioCount ?? '—'}</p></div></section>
            <section><p className="hpe-label">Review status</p><div className="mt-3 flex flex-wrap gap-2"><EvidencePill tone="verified">{accepted.length} accepted</EvidencePill><EvidencePill tone={pending.length ? 'warn' : 'neutral'}>{pending.length} awaiting review</EvidencePill>{observations.length === 0 ? <EvidencePill tone="neutral">No field evidence</EvidencePill> : null}</div></section>
            <p className="border-t border-ink-100 pt-4 text-[11px] leading-5 text-ink-500">Prioritization only. No official endorsement, health impact, temperature reduction, feasibility or savings claim.</p>
          </div>
        </article>

        <aside className="space-y-4">
          <article className="hpe-card p-4"><p className="hpe-label">Package status</p><div className="mt-3 space-y-3 text-[11px]"><div className="flex justify-between gap-3"><span className="text-ink-600">Measurements</span><strong className="text-ok-700">Verified</strong></div><div className="flex justify-between gap-3"><span className="text-ink-600">Field review</span><strong className={fieldReview.className}>{fieldReview.label}</strong></div><div className="flex justify-between gap-3"><span className="text-ink-600">Data licence check</span><strong className={licensingBlocked ? 'text-stop-700' : 'text-ok-700'}>{licensingBlocked ? 'Blocked' : 'Ready'}</strong></div></div><details className="mt-4 border-t border-ink-100 pt-3"><summary className="min-h-11 cursor-pointer py-2 font-semibold text-brand-700">Other export formats</summary><div className="mt-2 flex flex-wrap gap-2"><button type="button" onClick={exportCsv} disabled={!run} className="hpe-button-secondary">Missions CSV</button><button type="button" onClick={exportJson} disabled={!run} className="hpe-button-secondary">Evidence JSON</button></div></details></article>
          <details className="hpe-card p-4"><summary className="min-h-11 cursor-pointer py-2 text-[11px] font-semibold text-brand-700">Audit identifiers</summary><dl className="mt-3 space-y-2 text-[10px]"><div><dt className="text-ink-500">Run ID</dt><dd className="mt-1 break-all font-mono text-ink-900">{run?.runId ?? 'Loading…'}</dd></div><div><dt className="text-ink-500">Audit SHA-256</dt><dd className="mt-1 break-all font-mono text-ink-900">{run?.audit.sha256 ?? 'Loading…'}</dd></div></dl></details>
          {licensingBlocked ? (
            <article className="hpe-card border-l-4 border-l-stop-700 p-4"><p className="text-[12px] font-bold text-stop-700">Submission blocker</p><p className="mt-2 text-[11px] leading-relaxed text-ink-600">Raw-layer redistribution permission remains unresolved. The evidence package reports the block rather than hiding it.</p><Link href="/methodology#provenance" className="mt-3 inline-flex text-[11px] font-semibold text-brand-700 underline underline-offset-4">Review provenance</Link></article>
          ) : (
            <article className="hpe-card border-l-4 border-l-ok-700 p-4"><p className="text-[12px] font-bold text-ok-700">Submission licensing ready</p><p className="mt-2 text-[11px] leading-relaxed text-ink-600">The two raw extracts without redistribution terms are excluded. The remaining transit files have exact-source grants or ODC-BY terms.</p><Link href="/methodology#provenance" className="mt-3 inline-flex text-[11px] font-semibold text-brand-700 underline underline-offset-4">Review provenance</Link></article>
          )}
        </aside>
      </section>
    </div>
  )
}
