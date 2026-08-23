import { describe, expect, it } from 'vitest'
import {
  AXES_FOR_MODE,
  buildProductManifest,
  resolveProductMode,
  type GateInputs,
} from '@/lib/gates/product-mode'
import { rankCandidates, selectUnderCapacity, type SelectableCandidate } from '@/lib/metrics/selection'
import type { ProductMode } from '@/lib/types'

/**
 * The gates constrain the algorithm, not the label.
 *
 * Two defects are covered here, and they compounded. `PRODUCT_MODE` was returned
 * verbatim before a single gate was read, so an environment variable could name
 * the two-axis product on a run whose capability was unconfirmed. And the mode,
 * however it was arrived at, never reached `selectUnderCapacity`: the ranking
 * always used both axes, so "the anomaly did not validate, so it is excluded"
 * was a sentence in a report next to a ranking that had used it anyway.
 */

const BASE: GateInputs = {
  baselinePass: true,
  shelterInventoryAvailable: false,
  ridershipDocumented: true,
  scheduleAvailable: true,
  exposureCoverage: 0.9,
  anomalyCoverage: 0.9,
  anomalyValidation: 'PERSISTENT',
  sufficientHoldouts: true,
  capabilityConfirmed: true,
  anomalyFieldConfirmed: true,
  liveSignalObtained: false,
  contractExercised: 'fixture',
  dataMode: 'DEMO_SYNTHETIC',
  thermalGate: { outcome: 'GO_THERMAL_SIGNAL' } as never,
  forcedMode: 'auto',
}

/** Inputs whose evidence supports exactly the named mode. */
const EVIDENCE_FOR: Record<ProductMode, GateInputs> = {
  HEAT_EXPOSURE_AND_ANOMALY: BASE,
  EXPOSURE_ONLY: { ...BASE, sufficientHoldouts: false },
  ANOMALY_ONLY: { ...BASE, capabilityConfirmed: false },
  NO_GO_THERMAL_PRODUCT: { ...BASE, capabilityConfirmed: false, sufficientHoldouts: false },
}

/* ========================================================================== */
/* Evidence decides; configuration may only narrow                            */
/* ========================================================================== */

describe('the effective mode is never wider than the evidence', () => {
  it('reaches each mode from its own evidence', () => {
    for (const [mode, inputs] of Object.entries(EVIDENCE_FOR)) {
      expect(resolveProductMode(inputs).evidenceMode, mode).toBe(mode)
    }
  })

  it('refuses every attempted promotion, from every starting point', () => {
    const modes = Object.keys(EVIDENCE_FOR) as ProductMode[]
    for (const evidence of modes) {
      for (const requested of modes) {
        const resolution = resolveProductMode({
          ...EVIDENCE_FOR[evidence],
          forcedMode: requested,
        })
        const want = AXES_FOR_MODE[requested]
        const have = AXES_FOR_MODE[evidence]
        const isPromotion = (want.exposure && !have.exposure) || (want.anomaly && !have.anomaly)

        if (isPromotion) {
          expect(resolution.promotionRefused, `${evidence} <- ${requested}`).toBe(true)
          expect(resolution.mode, `${evidence} <- ${requested}`).toBe(evidence)
          expect(resolution.rationale.join(' ')).toMatch(/never widen/)
        } else {
          expect(resolution.promotionRefused, `${evidence} <- ${requested}`).toBe(false)
          expect(resolution.mode, `${evidence} <- ${requested}`).toBe(requested)
        }
        // Whatever happened, the result is never wider than the evidence.
        expect(resolution.axes.exposure && !have.exposure).toBe(false)
        expect(resolution.axes.anomaly && !have.anomaly).toBe(false)
      }
    }
  })

  it('allows a downgrade and records it', () => {
    const resolution = resolveProductMode({ ...BASE, forcedMode: 'EXPOSURE_ONLY' })
    expect(resolution.evidenceMode).toBe('HEAT_EXPOSURE_AND_ANOMALY')
    expect(resolution.mode).toBe('EXPOSURE_ONLY')
    expect(resolution.downgraded).toBe(true)
    expect(resolution.axes).toEqual({ exposure: true, anomaly: false })
  })

  it('carries the resolution onto the manifest every surface reads', () => {
    const manifest = buildProductManifest(
      { ...EVIDENCE_FOR.ANOMALY_ONLY, forcedMode: 'HEAT_EXPOSURE_AND_ANOMALY' },
      '2026-08-04T00:00:00.000Z',
    )
    expect(manifest.mode).toBe('ANOMALY_ONLY')
    expect(manifest.evidenceMode).toBe('ANOMALY_ONLY')
    expect(manifest.requestedMode).toBe('HEAT_EXPOSURE_AND_ANOMALY')
    expect(manifest.promotionRefused).toBe(true)
    expect(manifest.axes).toEqual({ exposure: false, anomaly: true })
    expect(manifest.blockingReasons.join(' ')).toMatch(/capability probe has not confirmed/)
  })
})

/* ========================================================================== */
/* Axis isolation: mutation tests                                             */
/* ========================================================================== */

describe('an excluded metric cannot move a ranking', () => {
  /** A deterministic spread of candidates on both axes. */
  const candidates = (mutate: (index: number) => Partial<SelectableCandidate> = () => ({})) =>
    Array.from({ length: 30 }, (_unused, index) => ({
      id: `s${String(index).padStart(2, '0')}`,
      lat: 33.4 + index * 0.01,
      lon: -112.2 + index * 0.01,
      exposure: 1000 + ((index * 37) % 29) * 10,
      anomalyZ: -2 + ((index * 13) % 17) * 0.25,
      ...mutate(index),
    })) as SelectableCandidate[]

  const options = { capacity: 8, minSeparationMeters: 0 }

  it('is unmoved by any perturbation of the anomaly under EXPOSURE_ONLY', () => {
    const axes = AXES_FOR_MODE.EXPOSURE_ONLY
    const baseline = selectUnderCapacity(candidates(), { ...options, axes })

    // Mutations that would each change a two-axis ranking: reverse the anomaly,
    // flatten it, spike one candidate, and remove it entirely.
    const mutations: Array<(index: number) => Partial<SelectableCandidate>> = [
      (index) => ({ anomalyZ: 2 - ((index * 13) % 17) * 0.25 }),
      () => ({ anomalyZ: 0 }),
      (index) => ({ anomalyZ: index === 17 ? 99 : -99 }),
      () => ({ anomalyZ: null }),
    ]

    for (const mutation of mutations) {
      const mutated = selectUnderCapacity(candidates(mutation), { ...options, axes })
      expect(mutated.selectedIds).toEqual(baseline.selectedIds)
      expect(mutated.entries.map((entry) => entry.rank + entry.candidateId)).toEqual(
        baseline.entries.map((entry) => entry.rank + entry.candidateId),
      )
      expect(mutated.ranked.map((entry) => entry.balancedPercentile)).toEqual(
        baseline.ranked.map((entry) => entry.balancedPercentile),
      )
    }

    // The same mutation DOES move a two-axis ranking, which is what makes the
    // assertion above meaningful rather than a test of a constant.
    const twoAxis = selectUnderCapacity(candidates(), {
      ...options,
      axes: AXES_FOR_MODE.HEAT_EXPOSURE_AND_ANOMALY,
    })
    const twoAxisMutated = selectUnderCapacity(
      candidates((index) => ({ anomalyZ: 2 - ((index * 13) % 17) * 0.25 })),
      { ...options, axes: AXES_FOR_MODE.HEAT_EXPOSURE_AND_ANOMALY },
    )
    expect(twoAxisMutated.selectedIds).not.toEqual(twoAxis.selectedIds)
  })

  it('is unmoved by any perturbation of exposure under ANOMALY_ONLY', () => {
    const axes = AXES_FOR_MODE.ANOMALY_ONLY
    const baseline = selectUnderCapacity(candidates(), { ...options, axes })

    for (const mutation of [
      (index: number) => ({ exposure: 100000 - index }),
      () => ({ exposure: 1 }),
      () => ({ exposure: null }),
    ]) {
      const mutated = selectUnderCapacity(candidates(mutation), { ...options, axes })
      expect(mutated.selectedIds).toEqual(baseline.selectedIds)
    }
  })

  it('reports the excluded axis as absent rather than as a value', () => {
    const ranked = rankCandidates(candidates(), AXES_FOR_MODE.EXPOSURE_ONLY)
    for (const entry of ranked) {
      expect(entry.anomalyZ).toBeNull()
      expect(entry.anomalyPercentile).toBeNull()
      // Quadrants are a two-axis construct; with one axis there is no split.
      expect(entry.quadrant).toBeNull()
      // …and with one objective there is no dominance structure either.
      expect(entry.paretoFront).toBe(1)
      expect(entry.balancedPercentile).toBe(entry.exposurePercentile)
    }

    const plan = selectUnderCapacity(candidates(), {
      ...options,
      axes: AXES_FOR_MODE.EXPOSURE_ONLY,
    })
    const selected = plan.entries.filter((entry) => entry.selected)
    expect(selected.every((entry) => entry.reasonCode === 'SINGLE_AXIS_RANK')).toBe(true)
    expect(selected.every((entry) => /exposure alone/i.test(entry.reason))).toBe(true)
    expect(selected.every((entry) => !/Pareto|undefined/i.test(entry.reason))).toBe(true)
  })

  it('ranks nothing at all under NO_GO', () => {
    const result = selectUnderCapacity(candidates(), {
      ...options,
      axes: AXES_FOR_MODE.NO_GO_THERMAL_PRODUCT,
    })
    expect(result.selectedIds).toEqual([])
    expect(result.ranked.every((entry) => !entry.complete)).toBe(true)
    expect(result.ranked.every((entry) => entry.paretoFront === null)).toBe(true)
    expect(result.notes.join(' ')).toMatch(/no ranked recommendation/)
  })

  it('keeps an analyst pin as an instruction, and never as a ranking', () => {
    // A pin is honoured under NO_GO — the analyst asked for it — but it carries
    // no front, no percentile and no robustness, so it cannot be read as a
    // finding the engine produced.
    const result = selectUnderCapacity(candidates(), {
      ...options,
      axes: AXES_FOR_MODE.NO_GO_THERMAL_PRODUCT,
      includedIds: ['s03'],
    })
    expect(result.pinnedIds).toEqual(['s03'])
    expect(result.selectedIds).toEqual(['s03'])
    const entry = result.entries.find((candidate) => candidate.candidateId === 's03')!
    expect(entry.reasonCode).toBe('MANUAL_INCLUDE')
    expect(entry.reason).toMatch(/instruction, not a finding/)
    expect(result.ranked.find((candidate) => candidate.id === 's03')!.paretoFront).toBeNull()
  })

  it('excludes the anomaly axis when the field is not confirmed to hold heat', () => {
    /*
     * A robust z-score is scale-free: it computes perfectly well over an
     * arbitrary numeric property, and the answer is a valid statistic. What it is
     * not is a *heat* anomaly. The gate used to require only coverage,
     * validation and holdouts — none of which says the number is a temperature —
     * so an unidentified field could become "unusually hot for its surroundings".
     */
    const unidentified = resolveProductMode({ ...BASE, anomalyFieldConfirmed: false })
    expect(unidentified.axes.anomaly).toBe(false)
    expect(unidentified.evidenceMode).toBe('EXPOSURE_ONLY')
    expect(unidentified.blockingReasons.join(' ')).toMatch(
      /Scale-invariance is not evidence that the data is heat/,
    )

    // With neither the unit nor the field identified, there is no product at all.
    const nothing = resolveProductMode({
      ...BASE,
      capabilityConfirmed: false,
      anomalyFieldConfirmed: false,
    })
    expect(nothing.evidenceMode).toBe('NO_GO_THERMAL_PRODUCT')
  })

  it('does not let a pin promote a mode or fill an excluded axis', () => {
    // Pinning does not change what the evidence supports.
    const withPin = resolveProductMode(EVIDENCE_FOR.ANOMALY_ONLY)
    expect(withPin.axes.exposure).toBe(false)
    const result = selectUnderCapacity(candidates(), {
      ...options,
      axes: withPin.axes,
      includedIds: ['s05'],
    })
    expect(result.ranked.find((candidate) => candidate.id === 's05')!.exposure).toBeNull()
  })
})
