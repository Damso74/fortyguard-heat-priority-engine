'use client'

import dynamic from 'next/dynamic'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ModuleHeader } from '@/components/operations/ModuleHeader'
import {
  RIDERSHIP_QUARTERS,
  quarterDetails,
  type RidershipDayCategory,
  type RidershipQuarter,
  type RidershipResponse,
  type RidershipStop,
} from '@/lib/ridership/source'

const RidershipMap = dynamic(
  () => import('@/components/map/RidershipMap').then((module) => module.RidershipMap),
  {
    ssr: false,
    loading: () => <div className="grid h-full place-items-center text-[13px] text-ink-500">Loading map…</div>,
  },
)

const responseCache = new Map<string, RidershipResponse>()

function percentile(values: readonly number[], share: number): number | null {
  if (values.length === 0) return null
  const ordered = [...values].sort((a, b) => a - b)
  return ordered[Math.floor((ordered.length - 1) * share)] ?? null
}

function formatValue(value: number | null, digits = 1): string {
  return value === null ? 'Not published' : value.toLocaleString('en-US', { maximumFractionDigits: digits })
}

export function RidershipExplorer({ mapStyleUrl }: { mapStyleUrl: string }) {
  const [quarter, setQuarter] = useState<RidershipQuarter>('2024_4')
  const [dayCategory, setDayCategory] = useState<RidershipDayCategory>('Weekday')
  const [data, setData] = useState<RidershipResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeId, setActiveId] = useState<number | null>(null)
  const [requestVersion, setRequestVersion] = useState(0)

  const load = useCallback(() => setRequestVersion((value) => value + 1), [])

  useEffect(() => {
    const cacheKey = `${quarter}:${dayCategory}`
    const cached = responseCache.get(cacheKey)
    if (cached) {
      setData(cached)
      setLoading(false)
      setError(null)
      return
    }

    const controller = new AbortController()
    setLoading(true)
    setError(null)
    void fetch(`/api/ridership?quarter=${quarter}&day=${dayCategory}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = await response.json()
        if (!response.ok) throw new Error(payload?.error ?? 'Unable to load Valley Metro ridership.')
        return payload as RidershipResponse
      })
      .then((payload) => {
        responseCache.set(cacheKey, payload)
        setData(payload)
        setActiveId((current) =>
          current !== null && payload.stops.some((stop) => stop.stopId === current) ? current : null,
        )
      })
      .catch((cause) => {
        if (cause instanceof DOMException && cause.name === 'AbortError') return
        setError(cause instanceof Error ? cause.message : 'Unable to load Valley Metro ridership.')
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })

    return () => controller.abort()
  }, [dayCategory, quarter, requestVersion])

  // Never relabel a previous response with the newly selected period. The old
  // payload may remain cached, but only an exact filter match can reach the UI.
  const currentData = data?.quarter === quarter && data.dayCategory === dayCategory ? data : null
  const stops = currentData?.stops ?? []
  const values = useMemo(
    () => stops.flatMap((stop) => (stop.publishedAverage === null ? [] : [stop.publishedAverage])),
    [stops],
  )
  const ranked = useMemo(
    () =>
      [...stops]
        .filter((stop) => stop.publishedAverage !== null)
        .sort((a, b) => (b.publishedAverage ?? -1) - (a.publishedAverage ?? -1)),
    [stops],
  )
  const selected = useMemo(
    () => stops.find((stop) => stop.stopId === activeId) ?? ranked[0] ?? null,
    [activeId, ranked, stops],
  )
  const selectedRank = selected ? ranked.findIndex((stop) => stop.stopId === selected.stopId) + 1 : 0
  const details = quarterDetails(quarter)
  const sum = values.reduce((total, value) => total + value, 0)
  const incomplete = details.status === 'incomplete'

  return (
    <div className="space-y-5">
      <ModuleHeader
        eyebrow="Transit use"
        title="Ridership explorer"
        description="Explore Valley Metro’s published stop averages by quarter and day type."
        actions={<a href={currentData?.source.mapViewerUrl ?? 'https://www.arcgis.com/apps/mapviewer/index.html?layers=3f5363e04eb74869aa9c67079318719f'} target="_blank" rel="noreferrer" className="hpe-button-secondary">Original ArcGIS map ↗</a>}
      />

      <section className="hpe-card p-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="hpe-label">Published quarter</span>
            <select
              value={quarter}
              onChange={(event) => setQuarter(event.target.value as RidershipQuarter)}
              className="mt-1.5 block min-h-11 w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-[13px] font-semibold text-ink-900 sm:min-w-64"
            >
              {RIDERSHIP_QUARTERS.map((entry) => (
                <option key={entry.key} value={entry.key}>
                  {entry.label} · {entry.period}{entry.status === 'incomplete' ? ' · incomplete' : ''}
                </option>
              ))}
            </select>
          </label>
          <fieldset>
            <legend className="hpe-label">Day category</legend>
            <div className="mt-1.5 inline-flex rounded-md border border-ink-200 bg-ink-50 p-1">
              {(['Weekday', 'Weekend'] as const).map((day) => (
                <button
                  key={day}
                  type="button"
                  aria-pressed={dayCategory === day}
                  onClick={() => setDayCategory(day)}
                  className={`min-h-11 rounded px-4 py-1.5 text-[12px] font-bold ${dayCategory === day ? 'bg-brand-600 text-white shadow-sm' : 'text-ink-600 hover:text-ink-900'}`}
                >
                  {day}
                </button>
              ))}
            </div>
          </fieldset>
        </div>
      </section>

      {incomplete ? (
        <section className="rounded-lg border border-flag-700/25 bg-flag-100/60 px-4 py-3 text-[12px] leading-relaxed text-ink-700" role="status">
          <strong className="text-flag-700">Completeness warning.</strong> This period fails FortyGuard’s internal completeness checks and is shown only for source inspection. It is not used by the priority engine.
        </section>
      ) : null}

      {error ? (
        <section className="hpe-card mx-auto max-w-xl p-6 text-center" role="alert">
          <p className="font-bold text-ink-900">The Valley Metro layer could not be loaded.</p>
          <p className="mt-2 text-[13px] text-ink-600">{error}</p>
          <button type="button" onClick={load} className="hpe-button-primary mt-4">Try again</button>
        </section>
      ) : (
        <>
          <section aria-label="Ridership summary" className="hpe-card flex flex-wrap gap-x-8 gap-y-3 px-4 py-3 text-[12px]">
            <p><span className="text-ink-500">Published values</span> <strong className="hpe-num ml-1 text-ink-900">{loading ? '—' : `${values.length.toLocaleString('en-US')} / ${stops.length.toLocaleString('en-US')}`}</strong></p>
            <p><span className="text-ink-500">Sum of stop averages</span> <strong className="hpe-num ml-1 text-ink-900">{loading ? '—' : formatValue(sum, 0)}</strong></p>
            <p><span className="text-ink-500">Median</span> <strong className="hpe-num ml-1 text-ink-900">{loading ? '—' : formatValue(percentile(values, 0.5))}</strong></p>
          </section>

          <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
            <article className="hpe-card overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ink-100 px-4 py-3">
                <div>
                  <p className="hpe-label">Phoenix · active stops</p>
                  <h2 className="mt-1 text-[15px] font-bold text-ink-900">Published ridership pattern</h2>
                </div>
                <span className="text-[11px] text-ink-500">{loading ? 'Updating source slice…' : 'Clusters separate as you zoom'}</span>
              </div>
              <div className="relative h-[65dvh] min-h-[460px] max-h-[720px] bg-ink-50" aria-busy={loading}>
                {loading && !currentData ? (
                  <div className="grid h-full place-items-center text-[13px] text-ink-500">Loading Phoenix stops from Valley Metro…</div>
                ) : (
                  <RidershipMap stops={stops} activeId={activeId} onSelect={setActiveId} styleUrl={mapStyleUrl} />
                )}
              </div>
            </article>

            <aside className="space-y-4">
              <SelectedStop stop={selected} rank={selectedRank} quarter={details.label} />
              <article className="hpe-card overflow-hidden">
                <div className="border-b border-ink-100 px-4 py-3">
                  <p className="hpe-label">Highest published values</p>
                  <p className="mt-1 text-[12px] text-ink-600">Select a stop to locate it on the map.</p>
                </div>
                <ol className="max-h-[372px] divide-y divide-ink-100 overflow-y-auto">
                  {ranked.slice(0, 20).map((stop, index) => (
                    <li key={stop.stopId}>
                      <button
                        type="button"
                        onClick={() => setActiveId(stop.stopId)}
                        className={`grid min-h-11 w-full grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-2 px-4 py-2.5 text-left hover:bg-ink-50 ${selected?.stopId === stop.stopId ? 'bg-brand-50' : ''}`}
                      >
                        <span className="hpe-num text-[10px] font-bold text-ink-400">#{index + 1}</span>
                        <span className="truncate text-[12px] font-semibold text-ink-800">{stop.name}</span>
                        <span className="hpe-num text-[12px] font-bold text-ink-900">{formatValue(stop.publishedAverage)}</span>
                      </button>
                    </li>
                  ))}
                </ol>
              </article>
            </aside>
          </section>
        </>
      )}

      <details className="hpe-card p-4 text-[12px] text-ink-600">
        <summary className="min-h-11 cursor-pointer py-2 font-semibold text-brand-700">Source details and licence limits</summary>
        <p className="mt-2 font-semibold text-ink-900">Valley Metro · Bus Ridership By Quarter · {details.label}</p>
        <p className="mt-2 max-w-3xl leading-5">The application queries the public ArcGIS service at runtime. Missing values stay missing, and public access is not presented as a redistribution licence.</p>
        <div className="mt-3 flex flex-wrap gap-4 text-[11px] font-semibold"><a href={currentData?.source.layerUrl} target="_blank" rel="noreferrer" className="text-brand-700 underline underline-offset-4">REST layer ↗</a><a href={currentData?.source.itemUrl} target="_blank" rel="noreferrer" className="text-brand-700 underline underline-offset-4">ArcGIS item ↗</a></div>
      </details>
    </div>
  )
}

function SelectedStop({
  stop,
  rank,
  quarter,
}: {
  stop: RidershipStop | null
  rank: number
  quarter: string
}) {
  return (
    <article className="hpe-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="hpe-label">Selected stop</p>
          <h2 className="mt-2 text-base font-bold leading-snug text-ink-900">{stop?.name ?? 'No published stop selected'}</h2>
        </div>
        {rank > 0 ? <span className="hpe-num rounded-full bg-brand-50 px-2.5 py-1 text-[10px] font-bold text-brand-700">#{rank}</span> : null}
      </div>
      {stop ? (
        <dl className="mt-4 space-y-3 border-t border-ink-100 pt-4 text-[12px]">
          <div className="flex justify-between gap-4"><dt className="text-ink-500">Published average</dt><dd className="hpe-num font-bold text-ink-900">{formatValue(stop.publishedAverage)}</dd></div>
          <div className="flex justify-between gap-4"><dt className="text-ink-500">Published total field</dt><dd className="hpe-num font-semibold text-ink-900">{formatValue(stop.publishedQuarterTotal, 0)}</dd></div>
          <div className="flex justify-between gap-4"><dt className="text-ink-500">Period</dt><dd className="font-semibold text-ink-900">{quarter}</dd></div>
          <div className="flex justify-between gap-4"><dt className="text-ink-500">Stop ID</dt><dd className="hpe-num font-semibold text-ink-900">{stop.stopId}</dd></div>
          <div className="flex justify-between gap-4"><dt className="text-ink-500">Status</dt><dd className="font-semibold text-ink-900">{stop.status}</dd></div>
        </dl>
      ) : <p className="mt-3 text-[12px] text-ink-500">Waiting for the source layer.</p>}
    </article>
  )
}
