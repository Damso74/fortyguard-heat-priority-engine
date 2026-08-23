import { describe, expect, it } from 'vitest'
import {
  MIN_COMPARED_CELLS,
  MIN_SNAPSHOTS_FOR_STOP_ANOMALY,
  attachAnomaliesToStops,
  computeSnapshotAnomalies,
  validateAnomalies,
  type CellAnomaly,
} from '@/lib/metrics/anomaly'

/**
 * Out-of-sample validation, attacked.
 *
 * The failure these are written against: the previous implementation averaged
 * each position's z **across** the held-out snapshots and then correlated the fit
 * against that average. Averaging before validating hides the one thing the step
 * is for. One holdout that reproduces the fit perfectly and one that inverts it
 * completely average to a field with no structure — or, with the aligned holdout
 * slightly stronger, to a field that still correlates — and the run reports that
 * the anomaly persisted across the afternoon. It did not. It persisted once and
 * reversed once.
 */

const SIZE = 12

/**
 * A lattice with a fixed hot patch, plus deterministic texture.
 *
 * `sign: -1` inverts the anomaly field: the hot patch becomes a cold one and
 * every texture deviation flips, which is what a holdout that contradicts the fit
 * looks like.
 */
function lattice(snapshot: string, options: { offset?: number; sign?: 1 | -1 } = {}) {
  const { offset = 0, sign = 1 } = options
  const cells = []
  for (let row = 0; row < SIZE; row += 1) {
    for (let col = 0; col < SIZE; col += 1) {
      const hot = row >= 5 && row <= 6 && col >= 5 && col <= 6
      const structure = (hot ? 4 : 0) + ((row * 7 + col * 3) % 5) * 0.05
      cells.push({
        id: `${snapshot}:${row}:${col}`,
        centroidLon: -112.1 + col * 0.004,
        centroidLat: 33.4 + row * 0.004,
        ring: [] as Array<[number, number]>,
        value: 40 + offset + sign * structure,
        snapshot,
      })
    }
  }
  return computeSnapshotAnomalies(cells, { radiusMeters: 900, minNeighbours: 5 })
}

/* ========================================================================== */
/* One valid holdout, one inverted                                            */
/* ========================================================================== */

describe('every holdout is validated on its own before anything is combined', () => {
  it('does not let a perfect holdout carry an inverted one', () => {
    const fit = lattice('2026-08-03T11:00')
    const aligned = lattice('2026-08-03T14:00', { offset: 3 })
    const inverted = lattice('2026-08-03T17:00', { offset: 1, sign: -1 })

    // Each holdout, on its own, is exactly what it looks like.
    const alignedOnly = validateAnomalies(
      new Map([
        ['2026-08-03T11:00', fit],
        ['2026-08-03T14:00', aligned],
      ]),
    )
    expect(alignedOnly.perHoldout[0]!.verdict).toBe('PERSISTENT')
    expect(alignedOnly.perHoldout[0]!.rankCorrelation).toBeGreaterThan(0.9)

    const invertedOnly = validateAnomalies(
      new Map([
        ['2026-08-03T11:00', fit],
        ['2026-08-03T17:00', inverted],
      ]),
    )
    expect(invertedOnly.perHoldout[0]!.verdict).toBe('NOT_PERSISTENT')
    expect(invertedOnly.perHoldout[0]!.rankCorrelation).toBeLessThan(0)

    /* --- and together: the adversarial case ------------------------------ */
    const both = validateAnomalies(
      new Map([
        ['2026-08-03T11:00', fit],
        ['2026-08-03T14:00', aligned],
        ['2026-08-03T17:00', inverted],
      ]),
    )

    // Both holdouts are scored separately, with their own denominators.
    expect(both.perHoldout).toHaveLength(2)
    expect(both.perHoldout.map((entry) => entry.verdict)).toEqual([
      'PERSISTENT',
      'NOT_PERSISTENT',
    ])

    // The aggregate is the WEAKEST holdout, not a mean of them. This is the
    // assertion the old implementation could not pass: it averaged the two
    // holdouts' z per position first, so the inverted snapshot was cancelled by
    // the aligned one instead of failing the run.
    expect(both.verdict).toBe('NOT_PERSISTENT')
    expect(both.sufficientHoldouts).toBe(false)
    expect(both.rankCorrelation).toBe(invertedOnly.perHoldout[0]!.rankCorrelation)

    // …and it says which holdout failed and why, rather than reporting one
    // summary number that belongs to no snapshot.
    expect(both.failureReasons).toHaveLength(1)
    expect(both.failureReasons[0]).toContain('2026-08-03T17:00')
    expect(both.failureReasons[0]).toMatch(/rank correlation/)
  })

  it('requires EVERY holdout to pass before the anomaly axis is claimed', () => {
    const fit = lattice('2026-08-03T09:00')
    const all = validateAnomalies(
      new Map([
        ['2026-08-03T09:00', fit],
        ['2026-08-03T11:00', lattice('2026-08-03T11:00', { offset: 1 })],
        ['2026-08-03T14:00', lattice('2026-08-03T14:00', { offset: 3 })],
      ]),
    )
    expect(all.perHoldout.every((entry) => entry.verdict === 'PERSISTENT')).toBe(true)
    expect(all.verdict).toBe('PERSISTENT')
    expect(all.sufficientHoldouts).toBe(true)
    expect(all.failureReasons).toEqual([])

    // Replace the last one with an inverted field: one bad holdout out of two is
    // enough to withdraw the claim.
    const one = validateAnomalies(
      new Map([
        ['2026-08-03T09:00', fit],
        ['2026-08-03T11:00', lattice('2026-08-03T11:00', { offset: 1 })],
        ['2026-08-03T14:00', lattice('2026-08-03T14:00', { offset: 3, sign: -1 })],
      ]),
    )
    expect(one.sufficientHoldouts).toBe(false)
    expect(one.verdict).not.toBe('PERSISTENT')
  })

  it('reports a per-holdout denominator rather than one shared number', () => {
    const fit = lattice('2026-08-03T11:00')
    // A holdout covering only part of the surface: fewer shared cells.
    const partial = lattice('2026-08-03T14:00', { offset: 2 }).slice(0, 30)
    const result = validateAnomalies(
      new Map([
        ['2026-08-03T11:00', fit],
        ['2026-08-03T14:00', partial],
        ['2026-08-03T17:00', lattice('2026-08-03T17:00', { offset: 3 })],
      ]),
    )
    const counts = result.perHoldout.map((entry) => entry.comparedCells)
    expect(new Set(counts).size).toBe(2)
    // The aggregate quotes the weakest holdout's denominator, not the largest.
    expect(result.comparedCells).toBe(
      result.perHoldout.find((entry) => entry.verdict === result.verdict)!.comparedCells,
    )
  })

  it('refuses a verdict on too few shared cells rather than inventing one', () => {
    const fit = lattice('2026-08-03T11:00')
    const tiny = lattice('2026-08-03T14:00', { offset: 2 }).slice(0, MIN_COMPARED_CELLS - 1)
    const result = validateAnomalies(
      new Map([
        ['2026-08-03T11:00', fit],
        ['2026-08-03T14:00', tiny],
      ]),
    )
    expect(result.perHoldout[0]!.verdict).toBe('INSUFFICIENT_DATA')
    expect(result.perHoldout[0]!.rankCorrelation).toBeNull()
    expect(result.verdict).toBe('INSUFFICIENT_DATA')
    expect(result.failureReasons[0]).toMatch(new RegExp(`${MIN_COMPARED_CELLS} are required`))
  })

  it('reports INSUFFICIENT_DATA when there is nothing to hold out', () => {
    const result = validateAnomalies(new Map([['2026-08-03T11:00', lattice('2026-08-03T11:00')]]))
    expect(result.verdict).toBe('INSUFFICIENT_DATA')
    expect(result.perHoldout).toEqual([])
    expect(result.sufficientHoldouts).toBe(false)
  })
})

/* ========================================================================== */
/* Missingness is preserved, not filled in                                    */
/* ========================================================================== */

describe('unavailable evidence stays unavailable', () => {
  it('reports no background rather than a background of zero', () => {
    // Two isolated cells: neither has enough neighbours for a background.
    const lonely = computeSnapshotAnomalies(
      [
        {
          id: 'a',
          centroidLon: -112.07,
          centroidLat: 33.45,
          ring: [],
          value: 41,
          snapshot: '2026-08-03T11:00',
        },
      ],
      { radiusMeters: 100, minNeighbours: 5 },
    )
    // Zero is a real temperature on this scale, so "no neighbourhood" and "the
    // neighbourhood sits at 0 °C" must not be the same value.
    expect(lonely[0]!.backgroundC).toBeNull()
    expect(lonely[0]!.scaleC).toBeNull()
    expect(lonely[0]!.z).toBeNull()
  })

  it('does not average a manufactured zero background into a stop', () => {
    const cells: CellAnomaly[] = [
      {
        cellId: 'covered',
        snapshot: '2026-08-03T11:00',
        lon: -112.07,
        lat: 33.45,
        value: 41,
        backgroundC: 40,
        scaleC: 0.5,
        z: 2,
        neighbours: 20,
      },
      {
        cellId: 'uncovered',
        snapshot: '2026-08-03T14:00',
        lon: -112.07,
        lat: 33.45,
        value: 42,
        backgroundC: null,
        scaleC: null,
        z: null,
        neighbours: 0,
      },
    ]
    const attached = attachAnomaliesToStops(
      [{ id: 1, lat: 33.45, lon: -112.07 }],
      new Map([
        ['2026-08-03T11:00', [cells[0]!]],
        ['2026-08-03T14:00', [cells[1]!]],
      ]),
      new Map([
        ['covered', ringAround(-112.07, 33.45)],
        ['uncovered', ringAround(-112.07, 33.45)],
      ]),
    )
    const stop = attached.get(1)!
    // 40, not 20: the null background is dropped, not averaged in as zero.
    expect(stop.backgroundC).toBe(40)
  })
})

/* ========================================================================== */
/* A stop needs its own evidence                                              */
/* ========================================================================== */

describe('a stop scored once does not carry an anomaly', () => {
  const ring = ringAround(-112.07, 33.45)

  const scored = (snapshot: string, z: number | null): CellAnomaly => ({
    cellId: `cell-${snapshot}`,
    snapshot,
    lon: -112.07,
    lat: 33.45,
    value: 41,
    backgroundC: 40,
    scaleC: 0.5,
    z,
    neighbours: 20,
  })

  it('withholds the score when only one snapshot scored the stop', () => {
    const attached = attachAnomaliesToStops(
      [{ id: 1, lat: 33.45, lon: -112.07 }],
      new Map([
        ['2026-08-03T11:00', [scored('2026-08-03T11:00', 3.2)]],
        ['2026-08-03T14:00', [scored('2026-08-03T14:00', null)]],
      ]),
      new Map([
        ['cell-2026-08-03T11:00', ring],
        ['cell-2026-08-03T14:00', ring],
      ]),
    )
    const stop = attached.get(1)!
    // A mean of one is the number itself wearing a claim it has not earned.
    expect(stop.z).toBeNull()
    expect(stop.snapshotsWithScore).toBe(1)
    expect(stop.snapshotsAnalysed).toBe(2)
    expect(stop.minimumSnapshots).toBe(MIN_SNAPSHOTS_FOR_STOP_ANOMALY)
    expect(stop.ineligibleReason).toMatch(/One reading is not a persistence claim/)
  })

  it('scores the stop once two snapshots agree it exists', () => {
    const attached = attachAnomaliesToStops(
      [{ id: 1, lat: 33.45, lon: -112.07 }],
      new Map([
        ['2026-08-03T11:00', [scored('2026-08-03T11:00', 3.0)]],
        ['2026-08-03T14:00', [scored('2026-08-03T14:00', 2.0)]],
      ]),
      new Map([
        ['cell-2026-08-03T11:00', ring],
        ['cell-2026-08-03T14:00', ring],
      ]),
    )
    const stop = attached.get(1)!
    expect(stop.z).toBe(2.5)
    expect(stop.snapshotsWithScore).toBe(2)
    expect(stop.ineligibleReason).toBeNull()
  })

  it('says so plainly when no snapshot covered the stop at all', () => {
    const attached = attachAnomaliesToStops(
      [{ id: 1, lat: 33.9, lon: -112.9 }],
      new Map([['2026-08-03T11:00', [scored('2026-08-03T11:00', 3.0)]]]),
      new Map([['cell-2026-08-03T11:00', ring]]),
    )
    const stop = attached.get(1)!
    expect(stop.z).toBeNull()
    expect(stop.snapshotsWithScore).toBe(0)
    expect(stop.matchedBy).toBe('none')
    expect(stop.ineligibleReason).toMatch(/No analysed snapshot produced a local anomaly/)
  })
})

/** A ~200 m square centred on a point, so containment has something to test. */
function ringAround(lon: number, lat: number): Array<[number, number]> {
  const d = 0.001
  return [
    [lon - d, lat - d],
    [lon + d, lat - d],
    [lon + d, lat + d],
    [lon - d, lat + d],
    [lon - d, lat - d],
  ]
}
