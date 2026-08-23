'use client'

import { useState } from 'react'
import type { ExpandedPlanSummary } from '@/lib/agent/summary'
import { GateBadge } from '@/components/evidence/Badge'
import { claim } from '@/lib/claims/registry'

/** The metrics the ranking used, named rather than implied by the mode string. */
function axesLabel(axes: { exposure: boolean; anomaly: boolean }): string {
  if (axes.exposure && axes.anomaly) return 'exposure and local anomaly, on separate axes'
  if (axes.exposure) return 'exposure alone — the anomaly took no part in the ordering'
  if (axes.anomaly) return 'the local anomaly alone — exposure took no part in the ordering'
  return 'neither axis — this run offers no ranked recommendation'
}

function selectionLabel(axes: { exposure: boolean; anomaly: boolean }, frontsUsed: number): string {
  if (axes.exposure && axes.anomaly) {
    return `Pareto layering, ${frontsUsed} front(s), no weights`
  }
  if (axes.exposure) return 'Exposure-only ordering, no weights'
  if (axes.anomaly) return 'Local-anomaly-only ordering, no weights'
  return 'No ranked recommendation'
}

export function RunSummary({
  run,
  requestBody,
}: {
  run: ExpandedPlanSummary
  requestBody: unknown
}) {
  const [open, setOpen] = useState(false)
  const [attestor, setAttestor] = useState('')
  const [attested, setAttested] = useState(false)
  const [busy, setBusy] = useState<'csv' | 'json' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const selected = run.results.filter((entry) =>
    run.plan.selectedIds.includes(String(entry.stop.id)),
  )
  const ridersModelled = selected.reduce((sum, entry) => sum + entry.ridersInWindow, 0)
  const loadInPlan = selected.reduce((sum, entry) => sum + (entry.exposure ?? 0), 0)
  const robust = run.plan.robustIds.length
  const dependent = run.plan.assumptionDependentIds.length

  const download = async (format: 'csv' | 'json') => {
    setBusy(format)
    setError(null)
    try {
      const response = await fetch('/api/plans/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // expectedRunId binds the attestation to the plan on screen. If the
        // server re-derives a different run, the export is refused rather than
        // silently carrying a name against a plan nobody saw.
        body: JSON.stringify({
          request: requestBody,
          format,
          attestedBy: attestor,
          expectedRunId: run.runId,
          // The run id covers the inputs; the digest covers the record. Both,
          // so the attestation names a specific sequence of events.
          expectedAuditSha256: run.audit.sha256,
        }),
      })
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string }
        throw new Error(payload.error ?? `Export failed (${response.status})`)
      }
      const blob = await response.blob()
      const match = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '')
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = match?.[1] ?? `heat-priority-plan.${format}`
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(url)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Export failed.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="border-t border-ink-200 p-3" aria-labelledby="summary-heading">
      <h2 id="summary-heading" className="text-[13px] font-semibold text-ink-900">
        Result
      </h2>

      {/* The headline split reads at the top of the panel; this section keeps
          the quantities, the settings, the gates and the export. */}
      <p className="mt-0.5 text-[10px] leading-tight text-ink-500">
        {run.plan.scenarioSweepApplies ? (
          <>
            <span className="hpe-num">{robust}</span> robust +{' '}
            <span className="hpe-num">{dependent}</span> assumption-dependent · every candidate
            carries its selection frequency and the range of ranks it takes.
          </>
        ) : (
          run.plan.robustRule
        )}
      </p>

      {/* Which product this run is, and which metrics it was allowed to use.
          The mode used to be a label printed beside a ranking that had always
          used both axes; it now names what the selection actually did. */}
      <p
        data-testid="effective-mode"
        className="mt-1 text-[10px] leading-tight text-ink-700"
      >
        <span className="text-ink-500">Product mode:</span>{' '}
        <span className="font-semibold">{run.manifest.mode}</span>{' '}
        <span className="text-ink-500">
          (evidence permits {run.manifest.evidenceMode}
          {run.manifest.requestedMode !== 'auto'
            ? `; PRODUCT_MODE requested ${run.manifest.requestedMode}`
            : ''}
          {run.manifest.promotionRefused ? ' — promotion refused' : ''}
          {run.manifest.downgraded ? ' — narrowed by configuration' : ''})
        </span>
        <br />
        <span className="text-ink-500">Ranked on:</span>{' '}
        {axesLabel(run.manifest.axes)}
        <br />
        <span className="text-ink-500">Values are:</span> {run.dataResolution.valuesAre}{' '}
        <span className="text-ink-500">
          (DATA_MODE={run.dataResolution.configured} → {run.dataResolution.resolved})
        </span>
      </p>

      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5">
        <div>
          <dt className="hpe-label">Modelled riders in window</dt>
          <dd className="hpe-num text-base font-semibold leading-none text-ink-900">
            {Math.round(ridersModelled).toLocaleString('en-US')}
          </dd>
          <p className="text-[10px] leading-tight text-ink-500">
            allocated from the published {run.methodology.exposure.ridershipCategory} average onto
            the {run.request.dayType} timetable — not counted riders
          </p>
        </div>
        <div>
          <dt className="hpe-label">Scenario exposure load in plan</dt>
          <dd className="hpe-num text-base font-semibold leading-none text-ink-900">
            {Math.round(loadInPlan).toLocaleString('en-US')}
          </dd>
          <p className="text-[10px] leading-tight text-ink-500">
            {run.methodology.exposure.unit} — a modelled quantity, not measured exposure
          </p>
        </div>
      </dl>

      <div className="mt-2 space-y-0.5 text-[11px] text-ink-700">
        <p>
          <span className="text-ink-500">Capacity:</span> {run.plan.selectedIds.length} of{' '}
          {run.plan.capacity} slots filled
        </p>
        <p>
          <span className="text-ink-500">Selection:</span>{' '}
          {selectionLabel(run.plan.axesUsed, run.plan.frontsUsed)}
        </p>
        <p>
          <span className="text-ink-500">Separation:</span>{' '}
          {run.plan.minimumSeparationMeters} m minimum between selected stops
        </p>
        <p>
          <span className="text-ink-500">Area:</span> {run.aoi.label} ·{' '}
          {run.tilePlan.tiles.length} tiles ≤ {run.tilePlan.maxTileSqMi} mi²
        </p>
        <p className="font-mono text-[10px] text-ink-500">{run.runId}</p>
      </div>

      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="mt-2 text-[11px] font-medium text-brand-700 underline underline-offset-2"
      >
        {open ? 'Hide gates and limits' : `Gates and limits (${run.limitations.length})`}
      </button>

      {open && (
        <div className="mt-2 space-y-2">
          <ul className="flex flex-wrap gap-x-2 gap-y-1">
            {Object.entries(run.manifest.gates).map(([id, status]) => (
              <li key={id} className="flex items-center gap-1 text-[10px] text-ink-700">
                {id}
                <GateBadge status={status} />
              </li>
            ))}
          </ul>
          {run.manifest.blockingReasons.length > 0 && (
            <div data-testid="blocking-reasons">
              <p className="hpe-label">Why an axis is unavailable</p>
              <ul className="list-disc space-y-1 pl-4 text-[10px] text-ink-700">
                {run.manifest.blockingReasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </div>
          )}
          {/*
            The claim registry, resolved for THIS run.
            `docs/limitations-and-claims.md` is the prose; lib/claims/registry.ts
            is the table the engine actually resolves against, and the manifest
            carries the answer. Rendering it here means the screen showing the
            numbers is the screen that says what they may not be used to claim —
            rather than that living one page away, in a document nobody opens
            while reading a plan.
          */}
          <div data-testid="blocked-claims">
            <p className="hpe-label">
              What this run may NOT be used to claim ({run.manifest.claimsBlocked.length})
            </p>
            <ul className="list-disc space-y-1 pl-4 text-[10px] text-ink-700">
              {run.manifest.claimsBlocked.map((id) => {
                const definition = claim(id)
                return (
                  <li key={id}>
                    {definition.statement}{' '}
                    <span className="text-ink-500">
                      {definition.because ?? definition.requires ?? ''}
                    </span>
                  </li>
                )
              })}
            </ul>
          </div>
          {run.dataResolution.rejectedSnapshots.length > 0 && (
            <div>
              <p className="hpe-label">Committed snapshots that could not be served</p>
              <ul className="list-disc space-y-1 pl-4 text-[10px] text-ink-700">
                {run.dataResolution.rejectedSnapshots.map((entry) => (
                  <li key={entry.file}>
                    <span className="font-mono">{entry.file}</span> — {entry.reasons.join(' ')}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <ul className="list-disc space-y-1 pl-4 text-[10px] text-ink-700">
            {run.limitations.map((limitation) => (
              <li key={limitation}>{limitation}</li>
            ))}
          </ul>
        </div>
      )}

      {/* ------------------------------ export ------------------------------ */}
      <div className="mt-3 border-t border-ink-200 pt-2">
        <label htmlFor="attestor" className="hpe-label">
          Reviewed by (self-attestation)
        </label>
        <input
          id="attestor"
          data-testid="approver-input"
          value={attestor}
          onChange={(event) => {
            setAttestor(event.target.value)
            setAttested(false)
          }}
          placeholder="Name or role"
          maxLength={120}
          className="mt-1 h-8 w-full rounded border border-ink-300 px-2 text-[13px]"
        />
        <p className="mt-1 text-[10px] leading-tight text-ink-500">
          This product has no authentication, so this name is unverified. It is recorded as a
          claim that you reviewed this plan, bound to run {run.runId}, and is not an approval.
        </p>
        <div className="mt-1.5 flex gap-1.5">
          <button
            type="button"
            data-testid="approve-plan"
            disabled={attestor.trim().length === 0}
            onClick={() => setAttested(true)}
            className="h-8 flex-1 rounded bg-ok-700 text-[12px] font-semibold text-white disabled:cursor-not-allowed disabled:bg-ink-300"
          >
            {attested ? 'Attested ✓' : 'Attest'}
          </button>
          <button
            type="button"
            data-testid="export-csv"
            disabled={!attested || busy !== null}
            onClick={() => void download('csv')}
            className="h-8 flex-1 rounded border border-ink-300 bg-white text-[12px] font-medium text-ink-900 hover:bg-ink-50 disabled:cursor-not-allowed disabled:text-ink-300"
          >
            {busy === 'csv' ? '…' : 'CSV'}
          </button>
          <button
            type="button"
            data-testid="export-json"
            disabled={!attested || busy !== null}
            onClick={() => void download('json')}
            className="h-8 flex-1 rounded border border-ink-300 bg-white text-[12px] font-medium text-ink-900 hover:bg-ink-50 disabled:cursor-not-allowed disabled:text-ink-300"
          >
            {busy === 'json' ? '…' : 'JSON'}
          </button>
        </div>
        {error && (
          <p role="alert" className="mt-1 text-[11px] text-stop-700">
            {error}
          </p>
        )}
      </div>
    </section>
  )
}
