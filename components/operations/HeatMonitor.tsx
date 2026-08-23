'use client'

import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { ModuleHeader, EvidencePill } from '@/components/operations/ModuleHeader'
import { useOperations } from '@/components/operations/OperationsProvider'
import { expandHeatCells, type CompactHeatCells } from '@/lib/agent/summary'
import type { RunResult } from '@/lib/types'

const PriorityMap = dynamic(
  () => import('@/components/map/PriorityMap').then((module) => module.PriorityMap),
  {
    ssr: false,
    loading: () => <div className="grid h-full place-items-center text-[13px] text-ink-500">Loading thermal surface…</div>,
  },
)

function toFahrenheit(celsius: number): number {
  return (celsius * 9) / 5 + 32
}

interface ThermalSnapshotPayload {
  time: string
  cellCount: number
  granularityMeters: number
  valueField: string | null
  temperatureUnit: string | null
  attestationSha256: string
  heatCells: CompactHeatCells
}

interface ExpandedThermalSnapshot extends Omit<ThermalSnapshotPayload, 'heatCells'> {
  heatCells: RunResult['heatCells']
}

const snapshotCache = new Map<string, ExpandedThermalSnapshot>()

export function HeatMonitor({ mapStyleUrl }: { mapStyleUrl: string }) {
  const { run, defaults } = useOperations()
  const times = run?.request.snapshotTimes ?? defaults.snapshotTimes
  const [activeTime, setActiveTime] = useState(times[0] ?? '08:00')
  const [snapshot, setSnapshot] = useState<ExpandedThermalSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [mapExpanded, setMapExpanded] = useState(false)

  useEffect(() => {
    if (!times.includes(activeTime)) setActiveTime(times[0] ?? '08:00')
  }, [activeTime, times])

  useEffect(() => {
    const cached = snapshotCache.get(activeTime)
    if (cached) {
      setSnapshot(cached)
      setLoading(false)
      setError(null)
      return
    }

    const controller = new AbortController()
    setLoading(true)
    setError(null)
    void fetch(`/api/thermal-snapshot?time=${encodeURIComponent(activeTime)}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = await response.json()
        if (!response.ok) throw new Error(payload?.error ?? 'Unable to load this snapshot.')
        const thermal = payload as ThermalSnapshotPayload
        return { ...thermal, heatCells: expandHeatCells(thermal.heatCells) }
      })
      .then((nextSnapshot) => {
        snapshotCache.set(activeTime, nextSnapshot)
        setSnapshot(nextSnapshot)
      })
      .catch((cause) => {
        if (cause instanceof DOMException && cause.name === 'AbortError') return
        setError(cause instanceof Error ? cause.message : 'Unable to load this snapshot.')
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
    })
    return () => controller.abort()
  }, [activeTime])

  const activeSnapshot = snapshot?.time === activeTime ? snapshot : null
  const displayedCells = activeSnapshot?.heatCells ?? run?.heatCells ?? []
  const selectedIds = useMemo(() => new Set(run?.plan.selectedIds ?? []), [run])
  const mapStops = useMemo(() => {
    if (!run) return []
    const entryById = new Map(run?.plan.entries.map((candidate) => [candidate.candidateId, candidate]) ?? [])
    return run.results.map((result) => {
      const id = String(result.stop.id)
      const entry = entryById.get(id)
      return {
        id,
        lon: result.stop.lon,
        lat: result.stop.lat,
        name: result.stop.name,
        rank: entry?.selected ? entry.rank : null,
        selected: selectedIds.has(id),
        complete: result.complete,
        exposure: result.exposure,
        exposurePercentile: result.exposurePercentile,
        anomalyZ: result.anomalyZ,
        quadrant: result.quadrant,
      }
    })
  }, [run, selectedIds])

  const thermalRange = useMemo(() => {
    if (!displayedCells.length) return null
    const values = displayedCells.map((cell) => cell.value)
    return { min: Math.min(...values), max: Math.max(...values) }
  }, [displayedCells])

  return (
    <div className="space-y-5">
      <ModuleHeader
        eyebrow="Plan & prioritize"
        title="Heat monitor"
        description="Inspect the stored FortyGuard surface by local time, verify what the API returned, and see exactly which claims the evidence supports."
        actions={
          <>
            <EvidencePill tone="real">Real stored data</EvidencePill>
            <Link href="/planner" className="rounded-md bg-brand-600 px-3 py-2 text-[12px] font-semibold text-white hover:bg-brand-700">
              Open priority plan →
            </Link>
          </>
        }
      />

      <section className={`grid gap-4 ${mapExpanded ? '' : 'xl:grid-cols-[minmax(0,1fr)_320px]'}`}>
        <article className="hpe-card overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-100 px-4 py-3">
            <div className="flex items-center gap-2" role="tablist" aria-label="Thermal snapshot time">
              {times.map((time) => (
                <button
                  key={time}
                  type="button"
                  role="tab"
                  aria-selected={activeTime === time}
                  onClick={() => setActiveTime(time)}
                  className={`rounded-md px-3 py-2 text-[12px] font-bold ${activeTime === time ? 'bg-brand-600 text-white' : 'bg-ink-50 text-ink-700 hover:bg-ink-100'}`}
                >
                  {time}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2 text-[12px] text-ink-500">
              {loading && <span>Loading snapshot…</span>}
              <span>Fixed local-time comparison</span>
              <button
                type="button"
                aria-pressed={mapExpanded}
                onClick={() => setMapExpanded((value) => !value)}
                className="rounded-md border border-ink-200 bg-white px-3 py-2 font-semibold text-ink-700 hover:border-brand-300 hover:text-brand-700"
              >
                {mapExpanded ? 'Restore layout' : 'Expand map'}
              </button>
            </div>
          </div>
          <div className={`relative bg-ink-50 ${mapExpanded ? 'h-[min(76vh,760px)]' : 'h-[560px]'}`}>
            {error ? (
              <div className="grid h-full place-items-center p-6 text-center text-[13px] text-stop-700" role="alert">{error}</div>
            ) : run ? (
              <PriorityMap
                cells={displayedCells}
                stops={mapStops}
                bbox={run.aoi.bbox}
                layerMode="temperature"
                valueFieldLabel="Temperature"
                anomalyLabel="Local anomaly unavailable"
                activeId={activeId}
                temperatureUnit={activeSnapshot?.temperatureUnit ?? run.methodology.exposure.thermalUnitLabel}
                loadUnitShort={run.methodology.exposure.loadUnitShort}
                onSelect={setActiveId}
                styleUrl={mapStyleUrl}
              />
            ) : (
              <div className="grid h-full place-items-center text-[13px] text-ink-500">Preparing verified surface…</div>
            )}
          </div>
        </article>

        <aside className={mapExpanded ? 'grid gap-4 md:grid-cols-3' : 'space-y-4'}>
          <article className="hpe-card p-4">
            <p className="hpe-label">Snapshot</p>
            <dl className="mt-3 space-y-3 text-[13px]">
              <div className="flex justify-between gap-4"><dt className="text-ink-500">Local time</dt><dd className="font-semibold text-ink-900">{activeTime} America/Phoenix</dd></div>
              <div className="flex justify-between gap-4"><dt className="text-ink-500">Thermal cells</dt><dd className="hpe-num font-semibold text-ink-900">{activeSnapshot?.cellCount ?? (run ? Math.round(run.thermal.cellCount / times.length) : '—')}</dd></div>
              <div className="flex justify-between gap-4"><dt className="text-ink-500">API field</dt><dd className="font-mono text-[11px] text-ink-900">{activeSnapshot?.valueField ?? run?.thermal.valueField ?? '—'}</dd></div>
              <div className="flex justify-between gap-4"><dt className="text-ink-500">Resolution</dt><dd className="font-semibold text-ink-900">{activeSnapshot?.granularityMeters ? `${activeSnapshot.granularityMeters} m` : run?.thermal.granularityMeters ? `${run.thermal.granularityMeters} m` : 'Reported in audit'}</dd></div>
            </dl>
          </article>

          <article className="hpe-card p-4">
            <p className="hpe-label">Observed surface range</p>
            {thermalRange ? (
              <div className="mt-3 grid grid-cols-2 gap-3">
                <div className="rounded-lg bg-brand-50 p-3"><p className="text-[10px] text-ink-500">Minimum</p><p className="hpe-num mt-1 text-lg font-bold text-ink-900">{toFahrenheit(thermalRange.min).toFixed(1)}°F</p><p className="text-[10px] text-ink-500">{thermalRange.min.toFixed(1)}°C source</p></div>
                <div className="rounded-lg bg-heat-100 p-3"><p className="text-[10px] text-ink-500">Maximum</p><p className="hpe-num mt-1 text-lg font-bold text-heat-700">{toFahrenheit(thermalRange.max).toFixed(1)}°F</p><p className="text-[10px] text-ink-500">{thermalRange.max.toFixed(1)}°C source</p></div>
              </div>
            ) : <p className="mt-3 text-[12px] text-ink-500">Waiting for the snapshot.</p>}
          </article>

          <article className="hpe-card border-l-4 border-l-flag-700 p-4">
            <p className="text-[12px] font-bold text-ink-900">What can be claimed</p>
            <div className="mt-3 space-y-3 text-[12px] leading-relaxed">
              <div><EvidencePill tone="verified">Available</EvidencePill><p className="mt-1 text-ink-700">Absolute heat values returned by the verified API pilot.</p></div>
              <div><EvidencePill tone="blocked">Unavailable</EvidencePill><p className="mt-1 text-ink-700">Persistent local-hotspot anomaly. The held-out spatial test did not pass.</p></div>
            </div>
          </article>
        </aside>
      </section>
    </div>
  )
}
