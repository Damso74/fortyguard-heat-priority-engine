'use client'

import { useMemo, useState } from 'react'
import type { PlanEntry } from '@/lib/types'
import type { SummaryStopResult } from '@/lib/agent/summary'
import {
  ANOMALY_RAMP,
  ANOMALY_STOPS,
  QUADRANT_COLOR,
  QUADRANT_SHORT,
  sampleRamp,
} from '@/lib/viz/palette'

type SortKey = 'rank' | 'exposure' | 'anomaly'
type Filter = 'selected' | 'all' | 'incomplete'

export function ResultList({
  results,
  entries,
  activeId,
  loadUnitShort,
  scenarioSweepApplies,
  onSelect,
}: {
  results: readonly SummaryStopResult[]
  entries: readonly PlanEntry[]
  activeId: string | null
  /** Resolved by the run. Never a literal: the layer may not be Celsius. */
  loadUnitShort: string
  /**
   * Whether the scenario envelope was re-selected at all.
   *
   * False when the run excludes exposure: the envelope varies only the exposure
   * model, so a robustness chip would describe a test nobody performed.
   */
  scenarioSweepApplies: boolean
  onSelect: (id: string) => void
}) {
  const [filter, setFilter] = useState<Filter>('selected')
  const [sortKey, setSortKey] = useState<SortKey>('rank')
  const [ascending, setAscending] = useState(false)
  const [query, setQuery] = useState('')

  const byId = useMemo(
    () => new Map(results.map((entry) => [String(entry.stop.id), entry])),
    [results],
  )

  const rows = useMemo(() => {
    const text = query.trim().toLowerCase()
    let list = entries.filter((entry) => {
      const result = byId.get(entry.candidateId)
      if (!result) return false
      if (filter === 'selected') return entry.selected
      if (filter === 'incomplete') return !result.complete
      return true
    })

    if (text) {
      list = list.filter((entry) => {
        const result = byId.get(entry.candidateId)
        if (!result) return false
        return (
          result.stop.name.toLowerCase().includes(text) ||
          String(result.stop.id).includes(text) ||
          result.stop.routes.some((route) => route.toLowerCase().includes(text))
        )
      })
    }

    const pick = (entry: SummaryStopResult | undefined) =>
      entry ? (sortKey === 'exposure' ? (entry.exposure ?? -1) : (entry.anomalyZ ?? -99)) : -99

    return [...list].sort((a, b) => {
      // Rank reads best ascending (1 first); the metrics read best descending
      // (largest first). The toggle reverses whichever is in force.
      const base =
        sortKey === 'rank'
          ? a.rank - b.rank
          : pick(byId.get(b.candidateId)) - pick(byId.get(a.candidateId))
      return ascending ? -base : base
    })
  }, [entries, byId, filter, query, sortKey, ascending])

  const sortButton = (key: SortKey, label: string) => (
    <button
      type="button"
      data-testid={`sort-${key}`}
      onClick={() => {
        if (sortKey === key) setAscending((value) => !value)
        else {
          setSortKey(key)
          setAscending(false)
        }
      }}
      aria-sort={sortKey === key ? (ascending ? 'ascending' : 'descending') : 'none'}
      className={`rounded px-1.5 py-0.5 text-[11px] ${
        sortKey === key ? 'bg-ink-100 font-semibold text-ink-900' : 'text-ink-500 hover:bg-ink-50'
      }`}
    >
      {label}
      {sortKey === key ? (ascending ? ' ↑' : ' ↓') : ''}
    </button>
  )

  return (
    /*
     * The panel as a whole is the scroll container, so this section must take
     * its natural height. An earlier version used `flex-1` here: inside a
     * scrolling parent that resolves to zero, the list rendered with no height
     * at all, and the matrix below it drew over the sort controls. The list gets
     * an explicit bounded height instead — no flex ambiguity.
     */
    <section className="flex flex-col border-t border-ink-200" aria-labelledby="list-heading">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-ink-200 p-2">
        <h2 id="list-heading" className="sr-only">
          Prioritised stops
        </h2>
        {(['selected', 'all', 'incomplete'] as const).map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={filter === option}
            data-testid={`filter-${option}`}
            onClick={() => setFilter(option)}
            className={`rounded border px-1.5 py-0.5 text-[11px] capitalize ${
              filter === option
                ? 'border-brand-600 bg-brand-600 font-semibold text-white'
                : 'border-ink-300 bg-white text-ink-700 hover:bg-ink-50'
            }`}
          >
            {option}
          </button>
        ))}
        <input
          type="search"
          value={query}
          aria-label="Search stops"
          placeholder="Search stop or route"
          onChange={(event) => setQuery(event.target.value)}
          className="ml-auto h-7 w-32 rounded border border-ink-300 px-1.5 text-[12px]"
        />
      </div>

      <div className="flex items-center gap-1 border-b border-ink-200 bg-ink-50 px-2 py-1">
        <span className="hpe-label">Sort</span>
        {sortButton('rank', 'Rank')}
        {sortButton('exposure', 'Exposure')}
        {sortButton('anomaly', 'Anomaly')}
      </div>

      <ol className="max-h-[42vh] min-h-[8rem] overflow-y-auto">
        {rows.length === 0 && (
          <li className="p-4 text-center text-[13px] text-ink-500">No stops match this filter.</li>
        )}
        {rows.map((entry) => {
          const result = byId.get(entry.candidateId)
          if (!result) return null
          const active = activeId === entry.candidateId
          return (
            <li key={entry.candidateId}>
              <button
                type="button"
                data-testid="result-row"
                data-stop-id={entry.candidateId}
                onClick={() => onSelect(entry.candidateId)}
                aria-current={active}
                className={`w-full border-b border-ink-100 px-2 py-1.5 text-left transition ${
                  active ? 'bg-brand-50' : 'hover:bg-ink-50'
                }`}
              >
                <div className="flex items-baseline gap-1.5">
                  <span className="hpe-num w-6 shrink-0 text-[12px] font-semibold text-ink-900">
                    {entry.selected ? entry.rank : '—'}
                  </span>
                  <span className="flex-1 truncate text-[13px] font-medium text-ink-900">
                    {result.stop.name}
                  </span>
                  {result.quadrant && (
                    <span className="flex shrink-0 items-center gap-1 text-[10px] text-ink-500">
                      <span
                        className="inline-block h-2 w-2 rounded-full ring-1 ring-white"
                        style={{ background: QUADRANT_COLOR[result.quadrant] }}
                      />
                      {QUADRANT_SHORT[result.quadrant]}
                    </span>
                  )}
                </div>
                {/*
                 * The two metrics scan visually first — a percentile bar for
                 * exposure, the anomaly ramp behind the σ chip — with the exact
                 * figures beside them. Numbers stay because a bar is not a
                 * value; the bar exists because fifty rows of values are not a
                 * ranking anyone can see.
                 */}
                <div className="mt-1 flex items-center gap-2 pl-7">
                  <span
                    className="h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-ink-100"
                    aria-hidden="true"
                  >
                    <span
                      className="block h-full rounded-full bg-heat-500"
                      style={{ width: `${Math.max(2, result.exposurePercentile ?? 0)}%` }}
                    />
                  </span>
                  <span className="hpe-num text-[11px] text-ink-500">
                    {result.exposure === null
                      ? 'load n/a'
                      : `${Math.round(result.exposure).toLocaleString('en-US')} ${loadUnitShort}`}
                  </span>
                  <span className="ml-auto flex items-center gap-1">
                    {result.anomalyZ !== null && (
                      <span
                        aria-hidden="true"
                        className="inline-block h-2.5 w-2.5 rounded-sm ring-1 ring-ink-200"
                        style={{
                          background: sampleRamp(result.anomalyZ, [...ANOMALY_STOPS], ANOMALY_RAMP),
                        }}
                      />
                    )}
                    <span className="hpe-num text-[11px] text-ink-500">
                      {result.anomalyZ === null
                        ? 'anomaly n/a'
                        : `${result.anomalyZ > 0 ? '+' : ''}${result.anomalyZ.toFixed(2)}σ`}
                    </span>
                  </span>
                </div>
                {/*
                 * Selection frequency and rank range travel with every selected
                 * row, not just with the ones flagged fragile. A reader
                 * comparing two rows needs both numbers on both, or the flag
                 * becomes the only thing they can compare.
                 */}
                {entry.selected && (
                  <div className="hpe-num mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-7 text-[10px]">
                    {/*
                      The robustness chip and the scenario count only mean
                      something when the scenario sweep ran. It varies the
                      EXPOSURE model, so on a run that excludes exposure every
                      candidate read "assumption-dependent, 0/0 scenarios" — a
                      badge and a denominator describing a test nobody performed.

                      Same chip grammar as the evidence badges otherwise: colour
                      paired with a word, ring-inset, never colour alone.
                    */}
                    {scenarioSweepApplies ? (
                      <>
                        <span
                          className={`rounded px-1 py-px text-[9px] font-semibold uppercase tracking-wide ring-1 ring-inset ${
                            result.assumptionSensitive
                              ? 'bg-flag-100 text-flag-700 ring-flag-700/25'
                              : 'bg-ok-100 text-ok-700 ring-ok-700/20'
                          }`}
                        >
                          {result.assumptionSensitive ? 'assumption-dependent' : 'robust'}
                        </span>
                        <span className="text-ink-500">
                          {result.scenarioSelectionCount}/{result.scenarioCount} scenarios
                        </span>
                      </>
                    ) : (
                      <span className="text-ink-500">
                        no scenario sweep on this run — the envelope varies the exposure model,
                        which this run does not use
                      </span>
                    )}
                    {result.scenarioRankBest !== null && result.scenarioRankWorst !== null && (
                      <span className="text-ink-500">
                        rank{' '}
                        {result.scenarioRankBest === result.scenarioRankWorst
                          ? result.scenarioRankBest
                          : `${result.scenarioRankBest}–${result.scenarioRankWorst}`}
                      </span>
                    )}
                  </div>
                )}
              </button>
            </li>
          )
        })}
      </ol>

      <p className="border-t border-ink-200 px-2 py-1 text-[10px] text-ink-500">
        {rows.length} shown · estimated scenario exposure load in {loadUnitShort} over the analysed
        hours, modelled not measured · anomaly in robust σ against the surrounding kilometre · rank
        range is the span of positions the stop takes across the scenarios that select it
      </p>
    </section>
  )
}
