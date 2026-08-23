/**
 * Weight-free selection over two separately-reported metrics.
 *
 * The previous version of this product blended heat and ridership into one score
 * with a user-adjustable weight, and moving that weight moved most of the plan. A
 * control that arbitrary should not exist, so it does not.
 *
 * The overlap figures behind that diagnosis are deleted rather than quoted: they
 * came from a spatial abstraction that no longer exists, measured against a
 * synthetic surface, and nothing here can reproduce them. The argument does not
 * need them — an exchange rate between riders and degrees is unjustifiable at any
 * overlap.
 *
 * Instead, exposure and anomaly stay on their own axes and selection uses
 * **Pareto layering**:
 *
 * 1. a location is on front 1 if no other location beats it on *both* metrics;
 * 2. front 2 is the same rule applied to what is left, and so on;
 * 3. within a front, order by `min(exposure percentile, anomaly percentile)` —
 *    a max-min rule that favours locations strong on their weaker axis;
 * 4. fill the capacity front by front, subject to a stated minimum separation.
 *
 * No step multiplies the two metrics, adds them, or scales one against the
 * other. There is no exchange rate to justify because none is used.
 */

import { percentileRanks, round } from './stats'
import { haversineMeters } from '@/lib/geo/measure'

export type Quadrant = 'BOTH_HIGH' | 'EXPOSURE_DRIVEN' | 'ANOMALY_DRIVEN' | 'NEITHER'

export type SelectionReasonCode =
  | 'PARETO_FRONT'
  | 'SINGLE_AXIS_RANK'
  | 'MANUAL_INCLUDE'
  | 'NOT_SELECTED_CAPACITY'
  | 'NOT_SELECTED_SEPARATION'
  | 'NOT_SELECTED_INCOMPLETE'
  | 'MANUAL_EXCLUDE'

export interface SelectableCandidate {
  id: string
  lat: number
  lon: number
  /** Metric A, °C·rider-minutes. Null when a factor is missing. */
  exposure: number | null
  /** Metric B, robust z. Null when no local background could be measured. */
  anomalyZ: number | null
}

export interface RankedCandidate {
  id: string
  exposure: number | null
  anomalyZ: number | null
  exposurePercentile: number | null
  anomalyPercentile: number | null
  /** 1 is the best front. Null when the candidate is incomplete. */
  paretoFront: number | null
  /** min(exposurePercentile, anomalyPercentile) — the in-front ordering key. */
  balancedPercentile: number | null
  quadrant: Quadrant | null
  complete: boolean
  missing: string[]
}

export interface SelectionEntry {
  rank: number
  candidateId: string
  selected: boolean
  reasonCode: SelectionReasonCode
  reason: string
}

export interface SelectionResult {
  capacity: number
  entries: SelectionEntry[]
  selectedIds: string[]
  /**
   * Selections placed by the analyst rather than by the ranking.
   *
   * Kept separate from `selectedIds` order so no downstream consumer can read a
   * pin as an analytical result. A pin is in the plan because someone put it
   * there; that is a legitimate operation and a different kind of fact.
   */
  pinnedIds: string[]
  ranked: RankedCandidate[]
  /** The metrics this selection was allowed to use. */
  axes: AxisPermission
  quadrantCounts: Record<Quadrant, number>
  incompleteIds: string[]
  minimumSeparationMeters: number
  requestedSeparationMeters: number
  frontsUsed: number
  notes: string[]
}

/**
 * Which metrics this selection may use.
 *
 * Comes from the product gates. It is not advisory: a forbidden metric is masked
 * to `null` at the boundary of `rankCandidates`, so no percentile, front,
 * tiebreak or quadrant downstream can read it even by accident. That is what
 * makes "the anomaly did not validate, so it is excluded from selection" a
 * property of the code rather than a sentence in a report.
 */
export interface AxisPermission {
  exposure: boolean
  anomaly: boolean
}

export const BOTH_AXES: AxisPermission = { exposure: true, anomaly: true }

export interface SelectionOptions {
  capacity: number
  /** Selected locations are kept at least this far apart where possible. */
  minSeparationMeters?: number
  excludedIds?: readonly string[]
  includedIds?: readonly string[]
  /** Defaults to both. Narrowed by the product gates. */
  axes?: AxisPermission
}

export const DEFAULT_MIN_SEPARATION_METERS = 400

/**
 * Pareto fronts for two maximised objectives.
 *
 * Uses the 2-D skyline sweep: sort by the first objective descending, then a
 * point joins the current front exactly when its second objective is not
 * dominated by one already taken. `O(n log n)` per front rather than `O(n²)`.
 *
 * ## Ties
 *
 * Domination is **strict**: `p` dominates `q` only when it is at least as good
 * on both objectives and strictly better on at least one. Two points with
 * identical `(a, b)` therefore belong on the *same* front — neither dominates
 * the other.
 *
 * The earlier sweep tested `point.b > bestB`, which pushed an exact duplicate to
 * the next front down. That is wrong in both directions: it invented a quality
 * difference between indistinguishable candidates, and — because ties in the
 * thermal fixture and in ridership are common — it inflated the front count and
 * moved real candidates behind duplicates of their own values. The test is now
 * `>=` within a run of equal `a`, applied by processing equal-`a` groups
 * together so that a later point can never be excluded by an equal-valued peer.
 */
export function paretoFronts(
  points: ReadonlyArray<{ id: string; a: number; b: number }>,
): string[][] {
  let remaining = [...points].sort((x, y) => (y.a - x.a) || (y.b - x.b) || (x.id < y.id ? -1 : 1))
  const fronts: string[][] = []

  while (remaining.length > 0) {
    const front: string[] = []
    const leftovers: typeof remaining = []
    let bestB = -Infinity

    let index = 0
    while (index < remaining.length) {
      const a = remaining[index]!.a
      let end = index
      while (end < remaining.length && remaining[end]!.a === a) end += 1

      // Two separate tests, because domination is asymmetric in the two cases:
      //
      // - against an EARLIER group (strictly greater `a`), a point survives only
      //   if its `b` is strictly greater — equal `b` with lower `a` is dominated;
      // - within its OWN group (equal `a`), a point is dominated by any peer with
      //   greater `b`, so only the group maximum can survive — but peers sharing
      //   that maximum do not dominate each other and all belong on the front.
      let groupMaxB = -Infinity
      for (let i = index; i < end; i += 1) groupMaxB = Math.max(groupMaxB, remaining[i]!.b)
      const admit = groupMaxB > bestB

      for (let i = index; i < end; i += 1) {
        const point = remaining[i]!
        if (admit && point.b === groupMaxB) front.push(point.id)
        else leftovers.push(point)
      }
      if (admit) bestB = groupMaxB
      index = end
    }

    if (front.length === 0) break // defensive: cannot happen with finite values
    fronts.push(front)
    remaining = leftovers
  }

  return fronts
}

/**
 * Rank the candidates using **only** the permitted axes.
 *
 * The forbidden metric is masked to `null` before anything else happens. That is
 * deliberate over a set of `if (axes.anomaly)` guards further down: masking makes
 * the exclusion structural, so a percentile, a front, a tiebreak or a quadrant
 * cannot read it however the code is later edited, and a mutation test can assert
 * that perturbing an excluded metric leaves the ranking byte-identical.
 *
 * With one axis there is no dominance structure — nothing can beat anything on
 * *both* of one metric — so every complete candidate sits on front 1 and the
 * ordering is that axis's percentile. Quadrants are a two-axis construct and are
 * null. With no axis, nothing is complete and nothing is ranked: that is what
 * `NO_GO_THERMAL_PRODUCT` means.
 */
export function rankCandidates(
  candidates: readonly SelectableCandidate[],
  axes: AxisPermission = BOTH_AXES,
): RankedCandidate[] {
  const masked = candidates.map((candidate) => ({
    ...candidate,
    exposure: axes.exposure ? candidate.exposure : null,
    anomalyZ: axes.anomaly ? candidate.anomalyZ : null,
  }))

  const axisCount = (axes.exposure ? 1 : 0) + (axes.anomaly ? 1 : 0)
  const complete = masked.filter(
    (candidate) =>
      axisCount > 0 &&
      (!axes.exposure || candidate.exposure !== null) &&
      (!axes.anomaly || candidate.anomalyZ !== null),
  )

  const exposurePercentiles = axes.exposure
    ? percentileRanks(complete.map((c) => c.exposure ?? 0))
    : []
  const anomalyPercentiles = axes.anomaly
    ? percentileRanks(complete.map((c) => c.anomalyZ ?? 0))
    : []

  const percentileById = new Map<string, { exposure: number | null; anomaly: number | null }>()
  complete.forEach((candidate, index) => {
    percentileById.set(candidate.id, {
      exposure: axes.exposure ? (exposurePercentiles[index] ?? 0) : null,
      anomaly: axes.anomaly ? (anomalyPercentiles[index] ?? 0) : null,
    })
  })

  const frontById = new Map<string, number>()
  if (axisCount === 2) {
    const fronts = paretoFronts(
      complete.map((candidate) => ({
        id: candidate.id,
        a: candidate.exposure ?? 0,
        b: candidate.anomalyZ ?? 0,
      })),
    )
    fronts.forEach((front, index) => front.forEach((id) => frontById.set(id, index + 1)))
  } else {
    // One objective: a plain ordering, not a layering. Calling each distinct
    // value its own "front" would report dozens of fronts and imply a dominance
    // structure that a single metric does not have.
    for (const candidate of complete) frontById.set(candidate.id, 1)
  }

  return masked.map((candidate) => {
    const percentiles = percentileById.get(candidate.id)
    const missing: string[] = []
    if (axes.exposure && candidate.exposure === null) missing.push('exposure')
    if (axes.anomaly && candidate.anomalyZ === null) missing.push('heat anomaly')
    if (axisCount === 0) missing.push('every axis is excluded by the product gates')

    if (!percentiles) {
      return {
        id: candidate.id,
        exposure: candidate.exposure,
        anomalyZ: candidate.anomalyZ,
        exposurePercentile: null,
        anomalyPercentile: null,
        paretoFront: null,
        balancedPercentile: null,
        quadrant: null,
        complete: false,
        missing,
      }
    }

    // Median split on each axis: 50 is the median by construction of the
    // percentile rank, so the quadrant boundary needs no extra parameter. It is
    // only meaningful with two axes.
    const quadrant: Quadrant | null =
      axisCount < 2
        ? null
        : (percentiles.exposure ?? 0) >= 50 && (percentiles.anomaly ?? 0) >= 50
          ? 'BOTH_HIGH'
          : (percentiles.exposure ?? 0) >= 50
            ? 'EXPOSURE_DRIVEN'
            : (percentiles.anomaly ?? 0) >= 50
              ? 'ANOMALY_DRIVEN'
              : 'NEITHER'

    const permitted = [percentiles.exposure, percentiles.anomaly].filter(
      (value): value is number => value !== null,
    )

    return {
      id: candidate.id,
      exposure: candidate.exposure,
      anomalyZ: candidate.anomalyZ,
      exposurePercentile: percentiles.exposure === null ? null : round(percentiles.exposure, 2),
      anomalyPercentile: percentiles.anomaly === null ? null : round(percentiles.anomaly, 2),
      paretoFront: frontById.get(candidate.id) ?? null,
      balancedPercentile: round(Math.min(...permitted), 2),
      quadrant,
      complete: true,
      missing,
    }
  })
}

export function selectUnderCapacity(
  candidates: readonly SelectableCandidate[],
  options: SelectionOptions,
): SelectionResult {
  const capacity = Math.max(0, Math.floor(options.capacity))
  const separation = options.minSeparationMeters ?? DEFAULT_MIN_SEPARATION_METERS
  const excluded = new Set(options.excludedIds ?? [])
  // Deduplicated, order preserved. Pinning the same stop twice previously
  // consumed two capacity slots and emitted two entries for one location, so a
  // plan of 50 could contain 49 distinct places while reporting 50.
  const forcedSet = new Set<string>()
  const forced: string[] = []
  let duplicatePins = 0
  for (const id of options.includedIds ?? []) {
    if (excluded.has(id)) continue
    if (forcedSet.has(id)) {
      duplicatePins += 1
      continue
    }
    forcedSet.add(id)
    forced.push(id)
  }

  const axes = options.axes ?? BOTH_AXES
  const axisCount = (axes.exposure ? 1 : 0) + (axes.anomaly ? 1 : 0)
  const singleAxisLabel = axes.exposure ? 'estimated exposure' : 'local thermal anomaly'
  const excludedAxisLabel = axes.exposure ? 'anomaly' : 'exposure'
  const ranked = rankCandidates(candidates, axes)
  const rankedById = new Map(ranked.map((entry) => [entry.id, entry]))
  const positionById = new Map(candidates.map((c) => [c.id, { lat: c.lat, lon: c.lon }]))
  const notes: string[] = []

  const quadrantCounts: Record<Quadrant, number> = {
    BOTH_HIGH: 0,
    EXPOSURE_DRIVEN: 0,
    ANOMALY_DRIVEN: 0,
    NEITHER: 0,
  }
  for (const entry of ranked) {
    if (entry.quadrant) quadrantCounts[entry.quadrant] += 1
  }

  const incompleteIds = ranked.filter((entry) => !entry.complete).map((entry) => entry.id)

  /** Front, then max-min percentile, then id. Fully deterministic. */
  const ordered = ranked
    .filter((entry) => entry.complete && !excluded.has(entry.id) && !forcedSet.has(entry.id))
    .sort((a, b) => {
      if (a.paretoFront !== b.paretoFront) return (a.paretoFront ?? 1e9) - (b.paretoFront ?? 1e9)
      if (a.balancedPercentile !== b.balancedPercentile) {
        return (b.balancedPercentile ?? 0) - (a.balancedPercentile ?? 0)
      }
      return a.id < b.id ? -1 : 1
    })

  const selected: string[] = []
  const entries = new Map<string, SelectionEntry>()
  const deferred: string[] = []

  const farEnough = (id: string): boolean => {
    if (separation <= 0) return true
    const position = positionById.get(id)
    if (!position) return true
    return selected.every((chosenId) => {
      const other = positionById.get(chosenId)
      if (!other) return true
      return haversineMeters(position, other) >= separation
    })
  }

  /* --------------------------- manual inclusions ------------------------- */
  const pinned: string[] = []
  if (duplicatePins > 0) {
    notes.push(
      `${duplicatePins} duplicate pin(s) were ignored; a location can occupy only one slot.`,
    )
  }
  for (const id of forced) {
    if (selected.length >= capacity) {
      notes.push(`Pinned location ${id} did not fit within the capacity of ${capacity}.`)
      break
    }
    if (!rankedById.has(id)) {
      notes.push(`Pinned location ${id} is not a candidate in this run and was ignored.`)
      continue
    }
    selected.push(id)
    pinned.push(id)
    entries.set(id, {
      rank: selected.length,
      candidateId: id,
      selected: true,
      reasonCode: 'MANUAL_INCLUDE',
      reason:
        'Pinned by the analyst; the plan was rebuilt around it. This is an instruction, not a ' +
        'finding — the ranking did not put it here and its scenario behaviour says nothing ' +
        'about whether it would have been selected.',
    })
  }

  /* ------------------------------ front fill ----------------------------- */
  let frontsUsed = 0
  for (const entry of ordered) {
    if (selected.length >= capacity) break
    if (!farEnough(entry.id)) {
      deferred.push(entry.id)
      continue
    }
    selected.push(entry.id)
    frontsUsed = Math.max(frontsUsed, entry.paretoFront ?? 0)
    entries.set(entry.id, {
      rank: selected.length,
      candidateId: entry.id,
      selected: true,
      reasonCode: axisCount === 2 ? 'PARETO_FRONT' : 'SINGLE_AXIS_RANK',
      reason:
        axisCount === 2
          ? `Pareto front ${entry.paretoFront}: no location beats it on both exposure and anomaly. ` +
            `Exposure percentile ${entry.exposurePercentile?.toFixed(0)}, ` +
            `anomaly percentile ${entry.anomalyPercentile?.toFixed(0)}.`
          : `Ranked on ${singleAxisLabel} alone at percentile ` +
            `${(entry.exposurePercentile ?? entry.anomalyPercentile)?.toFixed(0)}; ` +
            `${excludedAxisLabel} is excluded by the product gates.`,
    })
  }

  /* ----- relax the separation only if capacity could not otherwise fill --- */
  if (selected.length < capacity && deferred.length > 0) {
    const before = selected.length
    for (const id of deferred) {
      if (selected.length >= capacity) break
      const entry = rankedById.get(id)
      if (!entry) continue
      selected.push(id)
      entries.set(id, {
        rank: selected.length,
        candidateId: id,
        selected: true,
        reasonCode: axisCount === 2 ? 'PARETO_FRONT' : 'SINGLE_AXIS_RANK',
        reason:
          (axisCount === 2
            ? `Pareto front ${entry.paretoFront}`
            : `Ranked on ${singleAxisLabel} alone`) +
          `; selected with the ${separation} m separation relaxed because the capacity could ` +
          'not otherwise be filled.',
      })
    }
    if (selected.length > before) {
      notes.push(
        `The ${separation} m minimum separation was relaxed for ${selected.length - before} ` +
          'location(s) so the requested capacity could be filled.',
      )
    }
  }

  /* ---------------------------- non-selected ----------------------------- */
  const selectedSet = new Set(selected)
  let nextRank = selected.length
  const rest = ranked
    .filter((entry) => !selectedSet.has(entry.id))
    .sort((a, b) => {
      if (a.complete !== b.complete) return a.complete ? -1 : 1
      if (a.paretoFront !== b.paretoFront) return (a.paretoFront ?? 1e9) - (b.paretoFront ?? 1e9)
      return (b.balancedPercentile ?? -1) - (a.balancedPercentile ?? -1)
    })

  for (const entry of rest) {
    nextRank += 1
    let reasonCode: SelectionReasonCode = 'NOT_SELECTED_CAPACITY'
    let reason = `Ranked below the capacity cut-off of ${capacity}.`

    if (excluded.has(entry.id)) {
      reasonCode = 'MANUAL_EXCLUDE'
      reason = 'Removed by the analyst; the plan was rebuilt without it.'
    } else if (!entry.complete) {
      reasonCode = 'NOT_SELECTED_INCOMPLETE'
      reason = `Not ranked — missing ${entry.missing.join(' and ')}.`
    } else if (deferred.includes(entry.id)) {
      reasonCode = 'NOT_SELECTED_SEPARATION'
      reason = `Within ${separation} m of a location already selected.`
    }

    entries.set(entry.id, {
      rank: nextRank,
      candidateId: entry.id,
      selected: false,
      reasonCode,
      reason,
    })
  }

  /* --------------------------- reported metrics -------------------------- */
  let minimumSeparation = Infinity
  for (let i = 0; i < selected.length; i += 1) {
    for (let j = i + 1; j < selected.length; j += 1) {
      const a = positionById.get(selected[i]!)
      const b = positionById.get(selected[j]!)
      if (!a || !b) continue
      minimumSeparation = Math.min(minimumSeparation, haversineMeters(a, b))
    }
  }
  if (!Number.isFinite(minimumSeparation)) minimumSeparation = 0

  if (selected.length < capacity) {
    notes.push(
      `Only ${selected.length} of ${capacity} slots could be filled from ` +
        `${ordered.length} complete candidates.`,
    )
  }
  if (incompleteIds.length > 0) {
    notes.push(`${incompleteIds.length} location(s) held out for missing data.`)
  }

  if (!axes.exposure && !axes.anomaly) {
    notes.push(
      'The product gates permit neither axis, so this run offers no ranked recommendation. ' +
        'Nothing was selected by the engine; any entries below are analyst pins, which are ' +
        'instructions rather than findings.',
    )
  } else if (!axes.exposure || !axes.anomaly) {
    notes.push(
      `Ranked on ${axes.exposure ? 'exposure' : 'the local anomaly'} alone: the other axis is ` +
        'excluded by the product gates and takes no part in the ordering, the tiebreak or the ' +
        'quadrants. With one objective there is no dominance structure, so every ranked ' +
        'candidate sits on a single front.',
    )
  }

  return {
    capacity,
    entries: [...entries.values()].sort((a, b) => a.rank - b.rank),
    selectedIds: selected,
    pinnedIds: pinned,
    ranked,
    axes,
    quadrantCounts,
    incompleteIds,
    minimumSeparationMeters: Math.round(minimumSeparation),
    requestedSeparationMeters: separation,
    frontsUsed,
    notes,
  }
}
