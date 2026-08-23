'use client'

import { useId } from 'react'
import type { AreaOfInterest, DayType } from '@/lib/types'
import { CAPACITY_OPTIONS } from '@/lib/agent/request'

export interface ControlsValue {
  aoiId: string
  capacity: number
  analysisDate: string
  snapshotTimes: string[]
  /**
   * The day whose *timetable* is analysed. Saturday and Sunday are separate
   * because the feed runs 5,476 and 4,815 trips on them; both draw the same
   * published Weekend ridership average, which is all the source splits.
   */
  dayType: DayType
}

const SNAPSHOT_CHOICES = ['08:00', '11:00', '14:00', '17:00', '20:00'] as const

/**
 * No weight sliders. The product takes an analytical position — two metrics,
 * reported separately, combined by a Pareto rule with no exchange rate — so
 * there is nothing here for a user to tune their way to a preferred answer.
 */
export function RunControls({
  value,
  areas,
  running,
  onChange,
  onRun,
}: {
  value: ControlsValue
  areas: readonly AreaOfInterest[]
  running: boolean
  onChange: (next: ControlsValue) => void
  onRun: () => void
}) {
  const ids = useId()
  const patch = (next: Partial<ControlsValue>) => onChange({ ...value, ...next })

  const toggleSnapshot = (time: string) => {
    const next = value.snapshotTimes.includes(time)
      ? value.snapshotTimes.filter((entry) => entry !== time)
      : [...value.snapshotTimes, time].sort()
    // Two snapshots are the minimum: the anomaly validation holds one out.
    if (next.length < 2) return
    patch({ snapshotTimes: next })
  }

  return (
    <section aria-labelledby={`${ids}-h`} className="border-b border-ink-200 p-3">
      <h2 id={`${ids}-h`} className="sr-only">
        Analysis settings
      </h2>

      <div className="grid grid-cols-2 gap-2">
        <label className="col-span-2 flex flex-col gap-1">
          <span className="hpe-label">Area</span>
          <select
            data-testid="aoi-select"
            value={value.aoiId}
            onChange={(event) => patch({ aoiId: event.target.value })}
            className="h-8 rounded border border-ink-300 bg-white px-2 text-[13px]"
          >
            {areas.map((area) => (
              <option key={area.id} value={area.id}>
                {area.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="hpe-label">Date</span>
          <input
            type="date"
            value={value.analysisDate}
            min="2021-01-01"
            onChange={(event) => patch({ analysisDate: event.target.value })}
            className="h-8 rounded border border-ink-300 bg-white px-2 text-[13px]"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="hpe-label">Day type</span>
          <select
            data-testid="day-type"
            value={value.dayType}
            onChange={(event) => patch({ dayType: event.target.value as DayType })}
            className="h-8 rounded border border-ink-300 bg-white px-2 text-[13px]"
          >
            <option value="weekday">Weekday</option>
            <option value="saturday">Saturday</option>
            <option value="sunday">Sunday</option>
          </select>
        </label>
      </div>

      <fieldset className="mt-2">
        <legend className="hpe-label">
          Hours <span className="normal-case tracking-normal text-ink-400">(America/Phoenix)</span>
        </legend>
        <div className="mt-1 flex gap-1" role="group">
          {SNAPSHOT_CHOICES.map((time) => {
            const active = value.snapshotTimes.includes(time)
            return (
              <button
                key={time}
                type="button"
                aria-pressed={active}
                onClick={() => toggleSnapshot(time)}
                className={`hpe-num h-7 flex-1 rounded border text-[11px] ${
                  active
                    ? 'border-brand-600 bg-brand-600 font-semibold text-white'
                    : 'border-ink-300 bg-white text-ink-700 hover:bg-ink-50'
                }`}
              >
                {time}
              </button>
            )
          })}
        </div>
        <p className="mt-1 text-[11px] leading-snug text-ink-400">
          The clock hours heat and waiting are analysed over — at least two, so the anomaly
          validation can hold one out.
        </p>
      </fieldset>

      <fieldset className="mt-2">
        <legend className="hpe-label">Capacity to allocate</legend>
        <div className="mt-1 flex gap-1" role="group">
          {CAPACITY_OPTIONS.map((capacity) => {
            const active = value.capacity === capacity
            return (
              <button
                key={capacity}
                type="button"
                aria-pressed={active}
                data-testid={`capacity-${capacity}`}
                onClick={() => patch({ capacity })}
                className={`hpe-num h-7 flex-1 rounded border text-[12px] ${
                  active
                    ? 'border-brand-600 bg-brand-600 font-semibold text-white'
                    : 'border-ink-300 bg-white text-ink-700 hover:bg-ink-50'
                }`}
              >
                {capacity}
              </button>
            )
          })}
        </div>
        <p className="mt-1 text-[11px] leading-snug text-ink-400">
          How many stops the plan may select — the capacity a team could actually inspect.
        </p>
      </fieldset>

      <button
        type="button"
        data-testid="run-analysis"
        onClick={onRun}
        disabled={running}
        className="mt-3 h-9 w-full rounded bg-brand-600 text-[13px] font-semibold text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-ink-300"
      >
        {running ? 'Analysing…' : 'Run analysis'}
      </button>
    </section>
  )
}
