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
  const { run, missions, planVersion } = useOperations()
  const accepted = missions.filter((mission) => mission.observation?.review === 'accepted')
  const pending = missions.filter((mission) => mission.observation?.review === 'pending')
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
        eyebrow="Govern & document"
        title="Reports & audit"
        description="Create a decision brief for leadership and a machine-readable evidence package tied to one exact run and operational revision."
        actions={
          <>
            <button type="button" onClick={() => window.print()} className="rounded-md border border-ink-200 bg-white px-3 py-2 text-[12px] font-semibold text-ink-700">Print decision brief</button>
            <button type="button" onClick={exportCsv} className="rounded-md border border-ink-200 bg-white px-3 py-2 text-[12px] font-semibold text-ink-700">Export missions CSV</button>
            <button type="button" onClick={exportJson} disabled={!run} className="rounded-md bg-brand-600 px-3 py-2 text-[12px] font-semibold text-white disabled:opacity-50">Download evidence JSON</button>
          </>
        }
      />

      <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <article className="hpe-card overflow-hidden" aria-labelledby="decision-brief-title">
          <div className="border-b border-ink-100 bg-[#0f2238] px-6 py-5 text-white">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div><p className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-300">Decision brief · plan v{planVersion}</p><h2 id="decision-brief-title" className="mt-2 text-xl font-bold">Phoenix transit heat inspection priorities</h2></div>
              <EvidencePill tone="real">Real FortyGuard pilot</EvidencePill>
            </div>
          </div>
          <div className="space-y-5 p-6">
            <section><p className="hpe-label">Decision</p><p className="mt-2 text-lg font-bold text-ink-900">Inspect {run?.plan.capacity ?? 10} selected transit stops before making an infrastructure claim.</p><p className="mt-2 text-[12px] leading-relaxed text-ink-600">The current plan contains {run?.plan.robustIds.length ?? 0} robust priorities and {run?.plan.assumptionDependentIds.length ?? 0} assumption-dependent candidates.</p></section>
            <section className="grid gap-3 sm:grid-cols-4"><div className="rounded-lg bg-ink-50 p-3"><p className="text-[10px] text-ink-500">AOI</p><p className="mt-1 text-[12px] font-bold">Downtown Phoenix</p></div><div className="rounded-lg bg-ink-50 p-3"><p className="text-[10px] text-ink-500">Thermal cells</p><p className="hpe-num mt-1 text-[12px] font-bold">{run?.thermal.cellCount ?? '—'}</p></div><div className="rounded-lg bg-ink-50 p-3"><p className="text-[10px] text-ink-500">Snapshots</p><p className="hpe-num mt-1 text-[12px] font-bold">{run?.request.snapshotTimes.length ?? '—'}</p></div><div className="rounded-lg bg-ink-50 p-3"><p className="text-[10px] text-ink-500">Scenarios</p><p className="hpe-num mt-1 text-[12px] font-bold">{run?.plan.scenarioCount ?? '—'}</p></div></section>
            <section><p className="hpe-label">Evidence readiness</p><div className="mt-3 flex flex-wrap gap-2"><EvidencePill tone="verified">{accepted.length} accepted field observations</EvidencePill><EvidencePill tone={pending.length ? 'warn' : 'neutral'}>{pending.length} awaiting review</EvidencePill><EvidencePill tone="blocked">No local hotspot claim</EvidencePill></div></section>
            <section className="rounded-lg border border-flag-700/20 bg-flag-100/40 p-4"><p className="text-[12px] font-bold text-ink-900">What this brief does not claim</p><p className="mt-2 text-[11px] leading-relaxed text-ink-700">It does not claim an official endorsement, people protected, temperature reduction, construction feasibility, dollar savings or causal impact.</p></section>
          </div>
        </article>

        <aside className="space-y-4">
          <article className="hpe-card p-4"><p className="hpe-label">Package readiness</p><div className="mt-3 space-y-3 text-[11px]"><div className="flex justify-between gap-3"><span className="text-ink-600">Thermal provenance</span><strong className="text-ok-700">Ready</strong></div><div className="flex justify-between gap-3"><span className="text-ink-600">Plan version</span><strong>v{planVersion}</strong></div><div className="flex justify-between gap-3"><span className="text-ink-600">Field review</span><strong className={pending.length ? 'text-flag-700' : 'text-ok-700'}>{pending.length ? 'Pending' : 'Clear'}</strong></div><div className="flex justify-between gap-3"><span className="text-ink-600">Submission licensing</span><strong className={licensingBlocked ? 'text-stop-700' : 'text-ok-700'}>{licensingBlocked ? 'Blocked' : 'Ready'}</strong></div></div></article>
          <article className="hpe-card p-4"><p className="hpe-label">Audit identity</p><dl className="mt-3 space-y-2 text-[10px]"><div><dt className="text-ink-500">Run ID</dt><dd className="mt-1 break-all font-mono text-ink-900">{run?.runId ?? 'Loading…'}</dd></div><div><dt className="text-ink-500">Audit SHA-256</dt><dd className="mt-1 break-all font-mono text-ink-900">{run?.audit.sha256 ?? 'Loading…'}</dd></div></dl></article>
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
