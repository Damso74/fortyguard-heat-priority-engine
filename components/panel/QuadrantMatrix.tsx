'use client'

import { useMemo, useState } from 'react'
import type { SummaryStopResult } from '@/lib/agent/summary'
import { INK, QUADRANT_COLOR, QUADRANT_LABEL, QUADRANT_ORDER } from '@/lib/viz/palette'

/**
 * The exposure × anomaly matrix.
 *
 * A scatter, because the job is to show *identity and position on two
 * independent axes at once* — which is the whole argument for not collapsing
 * them into one number. Quadrant boundaries sit at the median of each axis, so
 * they need no tuning parameter.
 *
 * Marks are 8px minimum with a 2px surface ring so overlapping points stay
 * separable, the legend is always present with direct labels (colour never
 * carries identity alone), and a table view is available underneath.
 */
export function QuadrantMatrix({
  results,
  selectedIds,
  activeId,
  onSelect,
}: {
  results: readonly SummaryStopResult[]
  selectedIds: readonly string[]
  activeId: string | null
  onSelect: (id: string) => void
}) {
  const [showTable, setShowTable] = useState(false)
  const selected = useMemo(() => new Set(selectedIds), [selectedIds])

  const points = useMemo(
    () =>
      results
        .filter(
          (entry) => entry.exposurePercentile !== null && entry.anomalyPercentile !== null,
        )
        .map((entry) => ({
          id: String(entry.stop.id),
          name: entry.stop.name,
          x: entry.exposurePercentile ?? 0,
          y: entry.anomalyPercentile ?? 0,
          quadrant: entry.quadrant ?? 'NEITHER',
          selected: selected.has(String(entry.stop.id)),
          exposure: entry.exposure,
          anomalyZ: entry.anomalyZ,
        })),
    [results, selected],
  )

  const counts = useMemo(() => {
    const out: Record<string, number> = {}
    for (const point of points) out[point.quadrant] = (out[point.quadrant] ?? 0) + 1
    return out
  }, [points])

  const W = 260
  const H = 200
  const PAD = { top: 8, right: 8, bottom: 26, left: 30 }
  const plotW = W - PAD.left - PAD.right
  const plotH = H - PAD.top - PAD.bottom
  const sx = (v: number) => PAD.left + (v / 100) * plotW
  const sy = (v: number) => PAD.top + plotH - (v / 100) * plotH

  return (
    <section className="border-t border-ink-200 p-3" aria-labelledby="matrix-heading">
      <div className="flex items-baseline justify-between gap-2">
        <h2 id="matrix-heading" className="text-[13px] font-semibold text-ink-900">
          Exposure × anomaly
        </h2>
        <button
          type="button"
          onClick={() => setShowTable((value) => !value)}
          className="text-[11px] font-medium text-brand-700 underline underline-offset-2"
        >
          {showTable ? 'Hide table' : 'Table view'}
        </button>
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="mt-1 w-full"
        role="img"
        aria-label={`Scatter of ${points.length} stops by exposure percentile and heat anomaly percentile, split into four quadrants at the median of each axis.`}
      >
        <rect
          x={sx(50)}
          y={sy(100)}
          width={plotW / 2}
          height={plotH / 2}
          fill={QUADRANT_COLOR.BOTH_HIGH}
          opacity={0.06}
        />
        <line x1={sx(50)} y1={sy(0)} x2={sx(50)} y2={sy(100)} stroke={INK.grid} strokeWidth={1} />
        <line x1={sx(0)} y1={sy(50)} x2={sx(100)} y2={sy(50)} stroke={INK.grid} strokeWidth={1} />
        <line x1={sx(0)} y1={sy(0)} x2={sx(100)} y2={sy(0)} stroke={INK.axis} strokeWidth={1} />
        <line x1={sx(0)} y1={sy(0)} x2={sx(0)} y2={sy(100)} stroke={INK.axis} strokeWidth={1} />

        {points.map((point) => (
          <circle
            key={point.id}
            cx={sx(point.x)}
            cy={sy(point.y)}
            r={point.id === activeId ? 6 : point.selected ? 4.5 : 2.4}
            fill={QUADRANT_COLOR[point.quadrant]}
            fillOpacity={point.selected ? 0.95 : 0.45}
            stroke={point.id === activeId ? INK.primary : '#ffffff'}
            strokeWidth={point.selected || point.id === activeId ? 2 : 0.5}
            style={{ cursor: 'pointer' }}
            onClick={() => onSelect(point.id)}
          >
            <title>
              {point.name} — scenario exposure load {point.x.toFixed(0)}th pct, anomaly{' '}
              {point.y.toFixed(0)}th pct
            </title>
          </circle>
        ))}

        <text x={sx(50)} y={H - 6} textAnchor="middle" fontSize={9} fill={INK.muted}>
          Estimated scenario exposure load →
        </text>
        <text
          x={10}
          y={PAD.top + plotH / 2}
          fontSize={9}
          fill={INK.muted}
          transform={`rotate(-90 10 ${PAD.top + plotH / 2})`}
          textAnchor="middle"
        >
          Heat anomaly →
        </text>
      </svg>

      <ul className="mt-1.5 space-y-0.5">
        {QUADRANT_ORDER.map((quadrant) => (
          <li key={quadrant} className="flex items-center gap-1.5 text-[11px] text-ink-700">
            <span
              className="inline-block h-2.5 w-2.5 shrink-0 rounded-full ring-1 ring-white"
              style={{ background: QUADRANT_COLOR[quadrant] }}
            />
            <span className="flex-1">{QUADRANT_LABEL[quadrant]}</span>
            <span className="hpe-num text-ink-500">{counts[quadrant] ?? 0}</span>
          </li>
        ))}
      </ul>

      {showTable && (
        <div className="mt-2 max-h-48 overflow-auto rounded border border-ink-200">
          <table className="w-full text-[11px]">
            <caption className="sr-only">Stops by quadrant, exposure and anomaly</caption>
            <thead className="sticky top-0 bg-ink-50 text-ink-500">
              <tr>
                <th scope="col" className="px-1.5 py-1 text-left">
                  Stop
                </th>
                <th scope="col" className="px-1.5 py-1 text-right">
                  Exp. pct
                </th>
                <th scope="col" className="px-1.5 py-1 text-right">
                  Anom. pct
                </th>
                <th scope="col" className="px-1.5 py-1 text-left">
                  Quadrant
                </th>
              </tr>
            </thead>
            <tbody>
              {points
                .filter((point) => point.selected)
                .map((point) => (
                  <tr key={point.id} className="border-t border-ink-100">
                    <td className="px-1.5 py-1">{point.name}</td>
                    <td className="hpe-num px-1.5 py-1 text-right">{point.x.toFixed(0)}</td>
                    <td className="hpe-num px-1.5 py-1 text-right">{point.y.toFixed(0)}</td>
                    <td className="px-1.5 py-1">{QUADRANT_LABEL[point.quadrant]}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
