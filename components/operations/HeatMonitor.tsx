'use client'

import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { EvidencePill } from '@/components/operations/ModuleHeader'
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

function formatThermalValue(value: number, unit: string | null | undefined) {
  if (unit?.trim() === '°C') {
    return {
      primary: `${value.toFixed(1)}°C`,
      secondary: `${toFahrenheit(value).toFixed(1)}°F`,
    }
  }
  return { primary: `${value.toFixed(1)}${unit ? ` ${unit}` : ''}`, secondary: null }
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
  const [requestVersion, setRequestVersion] = useState(0)

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
  }, [activeTime, requestVersion])

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
  const thermalUnit = activeSnapshot?.temperatureUnit ?? run?.methodology.exposure.thermalUnitLabel
  const lowTemperature = thermalRange ? formatThermalValue(thermalRange.min, thermalUnit) : null
  const highTemperature = thermalRange ? formatThermalValue(thermalRange.max, thermalUnit) : null

  return (
    <div className="bg-ink-900">
      <section
        className="relative isolate h-[calc(100dvh-7.1rem)] min-h-[640px] overflow-hidden xl:h-dvh xl:min-h-[720px]"
        aria-busy={loading}
      >
        <div className="absolute inset-0 bg-ink-800">
          {error ? (
            <div className="grid h-full place-items-center p-6 text-center" role="alert">
              <div className="max-w-sm rounded-2xl bg-white p-6 shadow-2xl">
                <p className="text-[15px] font-bold text-stop-700">This thermal snapshot could not be loaded.</p>
                <p className="mt-2 text-[13px] text-ink-600">{error}</p>
                <button type="button" onClick={() => setRequestVersion((value) => value + 1)} className="hpe-button-secondary mt-4">Try again</button>
              </div>
            </div>
          ) : run ? (
            <PriorityMap
              compact
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
            <div className="grid h-full place-items-center text-[13px] text-slate-300">Preparing verified surface…</div>
          )}
        </div>

        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-72 bg-gradient-to-b from-ink-900 via-ink-900/75 to-transparent sm:h-52 sm:from-ink-900/90 sm:via-ink-900/45" />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-52 bg-gradient-to-t from-ink-900/80 via-ink-900/25 to-transparent" />

        <header className="absolute inset-x-0 top-0 z-20 flex flex-col gap-4 p-4 sm:p-6 lg:flex-row lg:items-start lg:justify-between lg:p-8">
          <div className="max-w-2xl text-white drop-shadow-sm">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-orange-200">Measured FortyGuard evidence</p>
              <span className="rounded-full border border-white/25 bg-ink-900/55 px-2 py-1 text-[9px] font-bold uppercase tracking-[0.1em] text-white backdrop-blur-sm">Historical pilot · July 2024</span>
            </div>
            <h1 className="mt-2 text-3xl font-bold tracking-[-0.04em] sm:text-4xl">Heat monitor</h1>
            <p className="mt-2 max-w-xl text-[13px] leading-5 text-slate-200 sm:text-[14px]">
              Compare the full measured surface hour by hour. Darker cells are warmer; numbered stops are in the inspection plan.
            </p>
          </div>
          <Link href="/planner" className="pointer-events-auto inline-flex min-h-11 w-fit items-center justify-center rounded-xl bg-brand-600 px-4 py-2 text-[13px] font-bold text-white shadow-xl transition-colors hover:bg-brand-700">
            Open priority plan <span className="ml-2" aria-hidden="true">→</span>
          </Link>
        </header>

        <div className="absolute bottom-4 left-4 right-4 z-20 flex flex-col gap-3 sm:bottom-6 sm:left-6 sm:right-6 lg:bottom-8 lg:left-8 lg:right-8 lg:flex-row lg:items-end lg:justify-between">
          <div className="pointer-events-auto w-fit max-w-full rounded-2xl border border-white/65 bg-white/94 p-2 shadow-2xl backdrop-blur-md">
            <div className="flex items-center gap-1.5" role="group" aria-label="Thermal snapshot time">
              {times.map((time) => (
                <button
                  key={time}
                  type="button"
                  aria-pressed={activeTime === time}
                  onClick={() => setActiveTime(time)}
                  className={`min-h-11 min-w-[58px] rounded-xl px-3 py-2 text-[12px] font-bold transition-colors ${activeTime === time ? 'bg-ink-900 text-white shadow-md' : 'text-ink-700 hover:bg-ink-100'}`}
                >
                  {time}
                </button>
              ))}
              {loading ? <span className="px-2 text-[11px] text-ink-500">Loading…</span> : null}
            </div>
          </div>

          <aside className="pointer-events-auto w-full rounded-2xl border border-white/65 bg-white/94 p-4 shadow-2xl backdrop-blur-md lg:w-[390px]">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-brand-700">{activeTime} · Phoenix</p>
                <p className="mt-1 text-[12px] font-semibold text-ink-700">
                  {activeSnapshot?.cellCount ?? (run ? Math.round(run.thermal.cellCount / times.length) : '—')} measured cells
                </p>
              </div>
              {lowTemperature && highTemperature ? (
                <dl className="flex items-center gap-5">
                  <div>
                    <dt className="text-[9px] font-bold uppercase tracking-wide text-ink-500">Low</dt>
                    <dd className="hpe-num mt-0.5 text-xl font-bold text-ink-900">{lowTemperature.primary}</dd>
                    {lowTemperature.secondary ? <dd className="hpe-num text-[10px] text-ink-500">{lowTemperature.secondary}</dd> : null}
                  </div>
                  <div className="border-l border-ink-200 pl-5">
                    <dt className="text-[9px] font-bold uppercase tracking-wide text-heat-700">High</dt>
                    <dd className="hpe-num mt-0.5 text-xl font-bold text-heat-700">{highTemperature.primary}</dd>
                    {highTemperature.secondary ? <dd className="hpe-num text-[10px] text-ink-500">{highTemperature.secondary}</dd> : null}
                  </div>
                </dl>
              ) : null}
            </div>
          </aside>
        </div>
      </section>

      <section className="grid gap-4 bg-ink-50 px-4 py-6 sm:px-6 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.55fr)] lg:px-8">
        <article className="hpe-card p-5">
          <p className="hpe-label">What this surface can support</p>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div><EvidencePill tone="verified">Available</EvidencePill><p className="mt-2 text-[13px] leading-5 text-ink-700">Measured temperature values at the selected stored hour.</p></div>
            <div><EvidencePill tone="blocked">Unavailable</EvidencePill><p className="mt-2 text-[13px] leading-5 text-ink-700">A persistent hotspot claim from a single snapshot.</p></div>
          </div>
        </article>
        <details className="hpe-card p-5 text-[12px] text-ink-600">
          <summary className="min-h-11 cursor-pointer py-2 font-semibold text-brand-700">Source details and resolution</summary>
          <dl className="mt-2 space-y-2">
            <div className="flex justify-between gap-4"><dt>API field</dt><dd className="font-mono text-[11px] text-ink-900">{activeSnapshot?.valueField ?? run?.thermal.valueField ?? '—'}</dd></div>
            <div className="flex justify-between gap-4"><dt>Resolution</dt><dd className="font-semibold text-ink-900">{activeSnapshot?.granularityMeters ? `${activeSnapshot.granularityMeters} m` : run?.thermal.granularityMeters ? `${run.thermal.granularityMeters} m` : 'Reported in audit'}</dd></div>
          </dl>
        </details>
      </section>
    </div>
  )
}
