import { describe, expect, it } from 'vitest'
import type { ThermalCell } from '@/lib/types'
import {
  DEFAULT_ANOMALY_PARAMETERS,
  attachAnomaliesToStops,
  computeSnapshotAnomalies,
  validateAnomalies,
  type CellAnomaly,
} from '@/lib/metrics/anomaly'
import {
  paretoFronts,
  rankCandidates,
  selectUnderCapacity,
  type SelectableCandidate,
} from '@/lib/metrics/selection'
import { medianInPlace, percentileRanks } from '@/lib/metrics/stats'

/* -------------------------------------------------------------------------- */
/* Statistics                                                                 */
/* -------------------------------------------------------------------------- */

describe('quickselect median', () => {
  it('matches a sorted median on odd and even counts', () => {
    expect(medianInPlace([3, 1, 2])).toBe(2)
    expect(medianInPlace([4, 1, 3, 2])).toBe(2.5)
    expect(medianInPlace([7])).toBe(7)
    expect(medianInPlace([])).toBeNull()
  })

  it('is order-independent', () => {
    const values = [9, 2, 7, 4, 1, 8, 3]
    expect(medianInPlace([...values])).toBe(4)
    expect(medianInPlace([...values].reverse())).toBe(4)
    expect(medianInPlace([...values].sort((a, b) => a - b))).toBe(4)
  })

  it('handles already-sorted input without degenerating', () => {
    const ascending = Array.from({ length: 999 }, (_, index) => index)
    expect(medianInPlace([...ascending])).toBe(499)
    expect(medianInPlace([...ascending].reverse())).toBe(499)
  })
})

/* -------------------------------------------------------------------------- */
/* Anomaly                                                                    */
/* -------------------------------------------------------------------------- */

/** A flat lattice with optional spikes, spaced 100 m apart. */
function lattice(
  snapshot: string,
  options: {
    size?: number
    base?: number
    spikes?: Array<{ x: number; y: number; amount: number }>
    noise?: number
    /** Changing this changes the whole texture, not just the spikes. */
    noiseSeed?: number
  } = {},
): ThermalCell[] {
  const size = options.size ?? 24
  const base = options.base ?? 40
  const seed = options.noiseSeed ?? 1
  const cells: ThermalCell[] = []
  const step = 0.001 // ~100 m
  for (let x = 0; x < size; x += 1) {
    for (let y = 0; y < size; y += 1) {
      const spike = (options.spikes ?? []).find((entry) => entry.x === x && entry.y === y)
      // Deterministic pseudo-noise so the neighbourhood is not perfectly flat.
      const noise = options.noise
        ? ((x * 37 + y * 61 + seed * 4099) % 11) * (options.noise / 11)
        : 0
      const lon = -112.1 + x * step
      const lat = 33.4 + y * step
      // Real geometry: cells are ~100 m squares, so containment and the half
      // diagonal are both meaningful. A cell with no ring cannot be matched to
      // a stop at all, which is the point of carrying one.
      const half = step / 2
      cells.push({
        id: `${snapshot}|${x}|${y}`,
        centroidLon: lon,
        centroidLat: lat,
        ring: [
          [lon - half, lat - half],
          [lon + half, lat - half],
          [lon + half, lat + half],
          [lon - half, lat + half],
        ],
        value: base + noise + (spike?.amount ?? 0),
        snapshot,
      })
    }
  }
  return cells
}

describe('local thermal anomaly', () => {
  it('finds a spike and leaves the flat background near zero', () => {
    const cells = lattice('s1', { noise: 0.4, spikes: [{ x: 12, y: 12, amount: 6 }] })
    const anomalies = computeSnapshotAnomalies(cells, {
      radiusMeters: 500,
      minNeighbours: 8,
    })
    const spike = anomalies.find((entry) => entry.cellId === 's1|12|12')!
    expect(spike.z).not.toBeNull()
    expect(spike.z!).toBeGreaterThan(5)

    const scored = anomalies.filter((entry) => entry.z !== null)
    const typical = scored.filter((entry) => Math.abs(entry.z!) < 3).length
    expect(typical / scored.length).toBeGreaterThan(0.9)
  })

  it('excludes a cell from its own background', () => {
    // With leave-one-out, a lone spike cannot pull up the baseline it is
    // measured against, so its z stays large.
    const withSpike = computeSnapshotAnomalies(
      lattice('s1', { noise: 0.4, spikes: [{ x: 12, y: 12, amount: 6 }] }),
      { radiusMeters: 300, minNeighbours: 8 },
    ).find((entry) => entry.cellId === 's1|12|12')!
    expect(withSpike.z!).toBeGreaterThan(4)
    // The background it was compared to is the neighbours' level, not its own.
    expect(withSpike.backgroundC).toBeLessThan(43)
  })

  it('returns null rather than a huge z on a perfectly flat neighbourhood', () => {
    const anomalies = computeSnapshotAnomalies(lattice('s1', { noise: 0 }), {
      radiusMeters: 500,
      minNeighbours: 8,
    })
    expect(anomalies.every((entry) => entry.z === null)).toBe(true)
  })

  it('returns null when there are too few neighbours', () => {
    const anomalies = computeSnapshotAnomalies(lattice('s1', { size: 3, noise: 0.4 }), {
      radiusMeters: 150,
      minNeighbours: 12,
    })
    expect(anomalies.every((entry) => entry.z === null)).toBe(true)
  })

  it('is deterministic and order-independent', () => {
    const cells = lattice('s1', { noise: 0.4, spikes: [{ x: 5, y: 5, amount: 4 }] })
    const forward = computeSnapshotAnomalies(cells, DEFAULT_ANOMALY_PARAMETERS)
    const reversed = computeSnapshotAnomalies([...cells].reverse(), DEFAULT_ANOMALY_PARAMETERS)
    const key = (entry: CellAnomaly) => `${entry.cellId}:${entry.z}`
    expect(new Set(reversed.map(key))).toEqual(new Set(forward.map(key)))
  })
})

describe('out-of-sample anomaly validation', () => {
  const parameters = { radiusMeters: 500, minNeighbours: 8 }

  it('reports PERSISTENT when the same places are anomalous in the holdout', () => {
    const spikes = [
      { x: 6, y: 6, amount: 6 },
      { x: 15, y: 9, amount: 5 },
      { x: 9, y: 18, amount: 7 },
    ]
    const bySnapshot = new Map<string, CellAnomaly[]>()
    for (const [index, snapshot] of ['s1', 's2', 's3'].entries()) {
      bySnapshot.set(
        snapshot,
        computeSnapshotAnomalies(
          lattice(snapshot, { noise: 0.4, base: 38 + index * 2, spikes }),
          parameters,
        ),
      )
    }
    const validation = validateAnomalies(bySnapshot)
    expect(validation.verdict).toBe('PERSISTENT')
    expect(validation.rankCorrelation!).toBeGreaterThan(0.6)
    expect(validation.topDecileRetention!).toBeGreaterThan(0.5)
    expect(validation.holdoutSnapshots).toEqual(['s2', 's3'])
  })

  it('does not report PERSISTENT when the whole pattern changes between snapshots', () => {
    // The texture itself is reseeded, not only the spikes — otherwise the
    // shared background would persist and the validator would be right to say
    // so. This is the case the check exists to catch: noise, not structure.
    const bySnapshot = new Map<string, CellAnomaly[]>()
    bySnapshot.set(
      's1',
      computeSnapshotAnomalies(
        lattice('s1', { noise: 3, noiseSeed: 1, spikes: [{ x: 4, y: 4, amount: 6 }] }),
        parameters,
      ),
    )
    bySnapshot.set(
      's2',
      computeSnapshotAnomalies(
        lattice('s2', { noise: 3, noiseSeed: 7, spikes: [{ x: 18, y: 20, amount: 6 }] }),
        parameters,
      ),
    )
    const validation = validateAnomalies(bySnapshot)
    expect(validation.verdict).not.toBe('PERSISTENT')
  })

  it('says INSUFFICIENT_DATA rather than guessing with one snapshot', () => {
    const bySnapshot = new Map<string, CellAnomaly[]>()
    bySnapshot.set('s1', computeSnapshotAnomalies(lattice('s1', { noise: 0.4 }), parameters))
    expect(validateAnomalies(bySnapshot).verdict).toBe('INSUFFICIENT_DATA')
  })
})

/** The ring the lattice gave this cell, rebuilt from its centroid. */
function ringFor(entry: { lon: number; lat: number }): Array<[number, number]> {
  const half = 0.001 / 2
  return [
    [entry.lon - half, entry.lat - half],
    [entry.lon + half, entry.lat - half],
    [entry.lon + half, entry.lat + half],
    [entry.lon - half, entry.lat + half],
  ]
}

describe('attaching anomalies to stops', () => {
  it('matches a stop to the nearest cell and averages across snapshots', () => {
    const bySnapshot = new Map<string, CellAnomaly[]>()
    for (const snapshot of ['s1', 's2']) {
      bySnapshot.set(
        snapshot,
        computeSnapshotAnomalies(
          lattice(snapshot, { noise: 0.4, spikes: [{ x: 10, y: 10, amount: 6 }] }),
          { radiusMeters: 500, minNeighbours: 8 },
        ),
      )
    }
    const rings = new Map(
      [...bySnapshot.values()].flat().map((entry) => [entry.cellId, ringFor(entry)]),
    )
    const attached = attachAnomaliesToStops(
      [{ id: 1, lon: -112.1 + 10 * 0.001, lat: 33.4 + 10 * 0.001 }],
      bySnapshot,
      rings,
    )
    const entry = attached.get(1)!
    expect(entry.z).not.toBeNull()
    expect(entry.matchedBy).toBe('containment')
    expect(entry.z!).toBeGreaterThan(4)
    expect(entry.snapshotsWithValue).toBe(2)
  })

  it('leaves a stop with no nearby cell unscored rather than borrowing a distant one', () => {
    const bySnapshot = new Map<string, CellAnomaly[]>()
    bySnapshot.set(
      's1',
      computeSnapshotAnomalies(lattice('s1', { noise: 0.4 }), {
        radiusMeters: 500,
        minNeighbours: 8,
      }),
    )
    const rings = new Map(
      [...bySnapshot.values()].flat().map((entry) => [entry.cellId, ringFor(entry)]),
    )
    const attached = attachAnomaliesToStops([{ id: 9, lon: -111.0, lat: 34.0 }], bySnapshot, rings)
    expect(attached.get(9)!.z).toBeNull()
    expect(attached.get(9)!.snapshotsWithValue).toBe(0)
  })
})

/* -------------------------------------------------------------------------- */
/* Selection                                                                  */
/* -------------------------------------------------------------------------- */

function candidate(
  id: string,
  exposure: number | null,
  anomalyZ: number | null,
  lon = -112.1,
  lat = 33.45,
): SelectableCandidate {
  return { id, lat, lon, exposure, anomalyZ }
}

describe('Pareto fronts', () => {
  it('puts non-dominated points on front 1', () => {
    const fronts = paretoFronts([
      { id: 'a', a: 10, b: 1 },
      { id: 'b', a: 5, b: 5 },
      { id: 'c', a: 1, b: 10 },
      { id: 'd', a: 4, b: 4 }, // dominated by b
    ])
    expect(fronts[0]!.sort()).toEqual(['a', 'b', 'c'])
    expect(fronts[1]).toEqual(['d'])
  })

  it('places every point on exactly one front', () => {
    const points = Array.from({ length: 60 }, (_, index) => ({
      id: `p${index}`,
      a: (index * 37) % 60,
      b: (index * 17) % 60,
    }))
    const fronts = paretoFronts(points)
    const flat = fronts.flat()
    expect(flat).toHaveLength(points.length)
    expect(new Set(flat).size).toBe(points.length)
  })

  it('is deterministic', () => {
    const points = [
      { id: 'x', a: 3, b: 7 },
      { id: 'y', a: 7, b: 3 },
      { id: 'z', a: 5, b: 5 },
    ]
    expect(paretoFronts(points)).toEqual(paretoFronts([...points].reverse()))
  })
})

describe('weight-free selection', () => {
  /** Ten candidates spread far apart so separation never binds. */
  const spread = (index: number) => -112.1 + index * 0.02

  it('uses no weights anywhere and selects exactly the capacity', () => {
    const candidates = Array.from({ length: 20 }, (_, index) =>
      candidate(`c${index}`, index * 10, (index % 7) - 3, spread(index)),
    )
    const plan = selectUnderCapacity(candidates, { capacity: 5 })
    expect(plan.selectedIds).toHaveLength(5)
    expect(plan.entries).toHaveLength(20)
  })

  it('never selects a dominated candidate ahead of the one dominating it', () => {
    const candidates = [
      candidate('strong', 100, 3, spread(0)),
      candidate('weak', 10, 0.1, spread(1)),
      candidate('mid', 50, 1, spread(2)),
    ]
    const plan = selectUnderCapacity(candidates, { capacity: 1 })
    expect(plan.selectedIds).toEqual(['strong'])
  })

  it('favours the candidate strong on its weaker axis within a front', () => {
    // Both on front 1. 'balanced' has the higher min-percentile.
    const candidates = [
      candidate('extreme', 100, -2, spread(0)),
      candidate('balanced', 70, 2, spread(1)),
      candidate('filler', 10, -3, spread(2)),
    ]
    const plan = selectUnderCapacity(candidates, { capacity: 1 })
    expect(plan.selectedIds).toEqual(['balanced'])
  })

  it('classifies quadrants on the median of each axis', () => {
    const candidates = [
      candidate('bothHigh', 100, 3, spread(0)),
      candidate('exposure', 90, -2, spread(1)),
      candidate('anomaly', 5, 2.5, spread(2)),
      candidate('neither', 1, -3, spread(3)),
    ]
    const ranked = rankCandidates(candidates)
    const byId = new Map(ranked.map((entry) => [entry.id, entry]))
    expect(byId.get('bothHigh')!.quadrant).toBe('BOTH_HIGH')
    expect(byId.get('exposure')!.quadrant).toBe('EXPOSURE_DRIVEN')
    expect(byId.get('anomaly')!.quadrant).toBe('ANOMALY_DRIVEN')
    expect(byId.get('neither')!.quadrant).toBe('NEITHER')
  })

  it('holds incomplete candidates out and names what is missing', () => {
    const candidates = [
      candidate('ok', 50, 1, spread(0)),
      candidate('noExposure', null, 1, spread(1)),
      candidate('noAnomaly', 50, null, spread(2)),
    ]
    const plan = selectUnderCapacity(candidates, { capacity: 5 })
    expect(plan.selectedIds).toEqual(['ok'])
    expect(plan.incompleteIds.sort()).toEqual(['noAnomaly', 'noExposure'])
    const missing = plan.ranked.find((entry) => entry.id === 'noExposure')!
    expect(missing.missing).toContain('exposure')
  })

  it('keeps selections apart, and says so when it has to relax', () => {
    // Six candidates ~46 m apart, spanning ~230 m — the whole cluster sits
    // inside the 400 m default, so the capacity cannot be filled without
    // relaxing the rule.
    const clustered = Array.from({ length: 6 }, (_, index) =>
      candidate(`c${index}`, 100 - index, 3 - index * 0.1, -112.1 + index * 0.0005),
    )
    // Nothing else to choose: the rule has to be relaxed to fill capacity 2,
    // and the relaxation is reported rather than silently applied.
    const loose = selectUnderCapacity(clustered, { capacity: 2 })
    expect(loose.selectedIds).toHaveLength(2)
    expect(loose.notes.join(' ')).toMatch(/relaxed/)

    // Add one well-separated candidate. Now capacity 2 can be filled without
    // relaxing, so the clustered runners-up are rejected *for separation* and
    // labelled as such — not lumped in with "below the cut-off".
    const withAlternative = [...clustered, candidate('far', 95, 2.8, -112.05)]
    const strict = selectUnderCapacity(withAlternative, { capacity: 2 })
    expect(strict.selectedIds).toContain('far')
    expect(strict.notes.join(' ')).not.toMatch(/relaxed/)
    const deferred = strict.entries.find((entry) => entry.reasonCode === 'NOT_SELECTED_SEPARATION')
    expect(deferred).toBeDefined()
  })

  it('honours manual include and exclude', () => {
    const candidates = Array.from({ length: 10 }, (_, index) =>
      candidate(`c${index}`, index * 10, index - 5, spread(index)),
    )
    const excluded = selectUnderCapacity(candidates, { capacity: 3, excludedIds: ['c9'] })
    expect(excluded.selectedIds).not.toContain('c9')

    const included = selectUnderCapacity(candidates, { capacity: 2, includedIds: ['c0'] })
    expect(included.selectedIds[0]).toBe('c0')
    expect(included.entries[0]!.reasonCode).toBe('MANUAL_INCLUDE')
  })

  it('is deterministic, including on exact ties', () => {
    const tied = [
      candidate('bbb', 50, 1, spread(0)),
      candidate('aaa', 50, 1, spread(1)),
      candidate('ccc', 50, 1, spread(2)),
    ]
    const first = selectUnderCapacity(tied, { capacity: 2 })
    const second = selectUnderCapacity([...tied].reverse(), { capacity: 2 })
    expect(second.selectedIds).toEqual(first.selectedIds)
  })

  it('reports percentile ranks on 0-100', () => {
    const values = percentileRanks([1, 2, 3, 4, 5])
    expect(values[0]).toBe(0)
    expect(values[4]).toBe(100)
    expect(values[2]).toBe(50)
  })
})
