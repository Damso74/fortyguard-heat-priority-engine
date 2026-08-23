/**
 * Shared statistics. Deterministic, order-independent, null-preserving.
 *
 * Everything here refuses to invent a value: an empty sample returns `null`
 * rather than 0, and a degenerate spread returns `null` rather than a z-score
 * of infinity.
 */

/** Linear-interpolated percentile of an ascending sorted array. */
export function percentileSorted(sorted: readonly number[], fraction: number): number | null {
  if (sorted.length === 0) return null
  if (sorted.length === 1) return sorted[0] ?? null
  const clamped = Math.min(1, Math.max(0, fraction))
  const position = (sorted.length - 1) * clamped
  const low = Math.floor(position)
  const high = Math.ceil(position)
  const lowValue = sorted[low]
  const highValue = sorted[high]
  if (lowValue === undefined || highValue === undefined) return null
  if (low === high) return lowValue
  return lowValue * (high - position) + highValue * (position - low)
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  return percentileSorted([...values].sort((a, b) => a - b), 0.5)
}

/**
 * Median via quickselect, mutating the array in place.
 *
 * The anomaly pass computes a median and a MAD for every cell against a few
 * hundred neighbours — tens of thousands of times. Full sorts made that the
 * dominant cost of a run; selection is linear rather than `n log n` and cut the
 * pass by roughly two thirds. The caller owns the array and must not care about
 * its order afterwards.
 */
export function medianInPlace(values: number[]): number | null {
  const n = values.length
  if (n === 0) return null
  if (n === 1) return values[0]!
  if (n % 2 === 1) return selectNth(values, (n - 1) / 2)
  // Even count: the upper middle, then the max of the lower partition, which
  // quickselect has already left below the pivot position.
  const upper = selectNth(values, n / 2)
  let lower = -Infinity
  for (let i = 0; i < n / 2; i += 1) {
    const value = values[i]!
    if (value > lower) lower = value
  }
  return (lower + upper) / 2
}

/** Hoare-partition quickselect. Returns the k-th smallest (0-indexed). */
function selectNth(values: number[], k: number): number {
  let left = 0
  let right = values.length - 1
  while (left < right) {
    // Median-of-three pivot keeps sorted and reverse-sorted inputs off the
    // quadratic path, which matters because neighbour arrays are spatially
    // ordered and therefore far from random.
    const mid = (left + right) >> 1
    const a = values[left]!
    const b = values[mid]!
    const c = values[right]!
    const pivot = a < b ? (b < c ? b : a < c ? c : a) : a < c ? a : b < c ? c : b

    let i = left
    let j = right
    while (i <= j) {
      while (values[i]! < pivot) i += 1
      while (values[j]! > pivot) j -= 1
      if (i <= j) {
        const swap = values[i]!
        values[i] = values[j]!
        values[j] = swap
        i += 1
        j -= 1
      }
    }
    if (k <= j) right = j
    else if (k >= i) left = i
    else break
  }
  return values[k]!
}

/**
 * Median absolute deviation, scaled to be a consistent estimator of the standard
 * deviation for normally distributed data. Returns `null` for an empty sample.
 */
export const MAD_TO_SIGMA = 1.4826

export function medianAbsoluteDeviation(
  values: readonly number[],
  centre?: number,
): number | null {
  if (values.length === 0) return null
  const mid = centre ?? median(values)
  if (mid === null) return null
  return median(values.map((value) => Math.abs(value - mid)))
}

/** Average ranks, ties shared. */
export function ranks(values: readonly number[]): number[] {
  const ordered = values
    .map((value, index) => ({ value, index }))
    .sort((a, b) => a.value - b.value)
  const output = new Array<number>(values.length).fill(0)
  let i = 0
  while (i < ordered.length) {
    let end = i
    while (end + 1 < ordered.length && ordered[end + 1]!.value === ordered[i]!.value) end += 1
    const rank = (i + end) / 2 + 1
    for (let position = i; position <= end; position += 1) {
      output[ordered[position]!.index] = rank
    }
    i = end + 1
  }
  return output
}

export function spearman(left: readonly number[], right: readonly number[]): number | null {
  if (left.length < 3 || left.length !== right.length) return null
  const x = ranks(left)
  const y = ranks(right)
  const xMean = x.reduce((sum, value) => sum + value, 0) / x.length
  const yMean = y.reduce((sum, value) => sum + value, 0) / y.length
  let numerator = 0
  let xVariance = 0
  let yVariance = 0
  for (let i = 0; i < x.length; i += 1) {
    const dx = (x[i] ?? 0) - xMean
    const dy = (y[i] ?? 0) - yMean
    numerator += dx * dy
    xVariance += dx * dx
    yVariance += dy * dy
  }
  const denominator = Math.sqrt(xVariance * yVariance)
  return denominator === 0 ? null : numerator / denominator
}

/**
 * Percentile rank of each value within its own sample, on 0–100.
 *
 * Used only for presentation and for the weight-free tiebreak in selection —
 * never to combine two quantities into one score.
 */
export function percentileRanks(values: readonly number[]): number[] {
  if (values.length === 0) return []
  if (values.length === 1) return [100]
  const r = ranks(values)
  return r.map((rank) => ((rank - 1) / (values.length - 1)) * 100)
}

export function round(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}
