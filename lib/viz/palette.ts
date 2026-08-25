/**
 * Validated colour scales.
 *
 * Every scale here was checked with the data-viz validator against the white
 * card surface the marks actually sit on, not chosen by eye:
 *
 * - **Quadrants** (categorical, 3 slots + a neutral): all-pairs CVD ΔE 9.2
 *   (deutan), normal-vision ΔE 24.0. `NEITHER` is deliberately *not* a series
 *   colour — it means "neither axis is high", so neutral grey is the honest
 *   encoding and it keeps the categorical set at three.
 *   The aqua slot sits at 2.82:1 against white, below the 3:1 bar, so the
 *   **relief rule applies**: it is always shipped with a direct label in the
 *   legend and a table view, never as colour alone.
 * - **Temperature** (sequential, single orange hue): OKLab L descends
 *   monotonically 0.963 → 0.463 across eight steps. One hue, never a rainbow.
 * - **Anomaly** (diverging, blue ↔ red, neutral grey midpoint): each arm is
 *   monotonic in L and the two poles separate at CVD ΔE 20.4 / normal 30.8.
 *   Grey at the midpoint means "typical for its surroundings", which is exactly
 *   what a zero z-score says.
 */

import type { Quadrant } from '@/lib/types'

/* ------------------------------ quadrants -------------------------------- */

export const QUADRANT_COLOR: Record<Quadrant, string> = {
  BOTH_HIGH: '#eb6834',
  EXPOSURE_DRIVEN: '#2a78d6',
  ANOMALY_DRIVEN: '#1baf7a',
  NEITHER: '#aab3bd',
}

export const QUADRANT_LABEL: Record<Quadrant, string> = {
  BOTH_HIGH: 'High exposure + unusual heat',
  EXPOSURE_DRIVEN: 'High exposure, typical heat',
  ANOMALY_DRIVEN: 'Unusual heat, lower exposure',
  NEITHER: 'Neither above median',
}

export const QUADRANT_SHORT: Record<Quadrant, string> = {
  BOTH_HIGH: 'Both high',
  EXPOSURE_DRIVEN: 'Exposure',
  ANOMALY_DRIVEN: 'Anomaly',
  NEITHER: 'Neither',
}

export const QUADRANT_ORDER: Quadrant[] = [
  'BOTH_HIGH',
  'EXPOSURE_DRIVEN',
  'ANOMALY_DRIVEN',
  'NEITHER',
]

/* ----------------------------- temperature -------------------------------- */

/** Saturated single-hue heat ramp, light → dark. */
export const TEMPERATURE_RAMP = [
  '#fff1d2',
  '#fedb9b',
  '#fdba68',
  '#f5943d',
  '#e96b25',
  '#cf4818',
  '#a92f12',
  '#781d12',
] as const

/* ------------------------------- anomaly ---------------------------------- */

/** Diverging ramp for the robust z-score. Index 3 is the neutral midpoint. */
export const ANOMALY_RAMP = [
  '#184f95',
  '#3987e5',
  '#9ec5f4',
  '#f0efec',
  '#f3b0af',
  '#e34948',
  '#a52a2a',
] as const

/** z values the ramp is anchored to. Symmetric about zero by construction. */
export const ANOMALY_STOPS = [-3, -2, -1, 0, 1, 2, 3] as const

/* ------------------------------- chrome ----------------------------------- */

export const INK = {
  primary: '#10151c',
  secondary: '#55606f',
  muted: '#78838f',
  grid: '#e1e0d9',
  axis: '#c3c2b7',
  surface: '#ffffff',
} as const

/** Build a MapLibre `interpolate` colour expression from a ramp and its domain. */
export function rampExpression(
  property: string,
  stops: readonly number[],
  colors: readonly string[],
): unknown[] {
  const expression: unknown[] = ['interpolate', ['linear'], ['get', property]]
  for (let i = 0; i < stops.length; i += 1) {
    expression.push(stops[i], colors[Math.min(i, colors.length - 1)])
  }
  return expression
}

/** Evenly spaced domain values for a sequential ramp between min and max. */
export function linearStops(min: number, max: number, count: number): number[] {
  if (count <= 1 || max <= min) return [min]
  return Array.from({ length: count }, (_, index) => min + ((max - min) * index) / (count - 1))
}

/** Pick a ramp colour for a value, for legends and non-map marks. */
export function sampleRamp(
  value: number,
  stops: readonly number[],
  colors: readonly string[],
): string {
  if (!Number.isFinite(value)) return INK.muted
  if (value <= (stops[0] ?? 0)) return colors[0] ?? INK.muted
  const last = stops[stops.length - 1] ?? 0
  if (value >= last) return colors[colors.length - 1] ?? INK.muted
  for (let i = 1; i < stops.length; i += 1) {
    const lower = stops[i - 1]!
    const upper = stops[i]!
    if (value <= upper) {
      const t = (value - lower) / (upper - lower)
      return t < 0.5 ? colors[i - 1] ?? INK.muted : colors[i] ?? INK.muted
    }
  }
  return colors[colors.length - 1] ?? INK.muted
}
