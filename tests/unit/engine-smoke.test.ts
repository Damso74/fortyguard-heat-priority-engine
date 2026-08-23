import { describe, expect, it } from 'vitest'
import { executeRun } from '@/lib/agent/run'
import { resetServerEnvCache } from '@/lib/config/server-env'

const FIXED_NOW = () => new Date('2026-08-04T18:00:00.000Z')

const REQUEST = {
  aoiId: 'central-phoenix',
  capacity: 50,
  analysisDate: '2026-08-03',
  snapshotTimes: ['11:00', '14:00', '17:00'],
  dayType: 'weekday' as const,
}

describe('end-to-end run in no-key mode', () => {
  it('produces two separately-reported metrics and a weight-free plan', async () => {
    resetServerEnvCache()
    const run = await executeRun(REQUEST, { now: FIXED_NOW })

    expect(run.state).toBe('awaiting_approval')
    expect(run.manifest.dataMode).toBe('DEMO_SYNTHETIC')
    expect(run.manifest.gates.fortyGuardLiveSignal).toBe('BLOCKED_LIVE')
    expect(run.manifest.gates.shelterInventory).toBe('FAIL')
    expect(run.manifest.gates.ridershipDocumentation).toBe('PASS')
    expect(run.manifest.gates.scheduledService).toBe('PASS')

    // Both metrics present, on their own scales, never blended.
    expect(run.methodology.selection.weightsUsed).toBe(false)
    expect(run.methodology.exposure.unit).toMatch(/rider-minutes/)
    // A1–A7; A7 is the temporal-drift assumption added with the scenario envelope.
    expect(run.methodology.exposure.assumptions).toHaveLength(9)
    expect(run.methodology.scenarioEnvelope.scenarioCount).toBe(324)
    expect(run.methodology.anomaly.leaveOneOut).toBe(true)

    expect(run.results.length).toBeGreaterThan(500)
    expect(run.plan.selectedIds).toHaveLength(50)

    const complete = run.results.filter((entry) => entry.complete)
    expect(complete.length).toBeGreaterThan(300)

    // Exposure carries a scenario envelope, not a single figure.
    const withBounds = complete.filter((e) => e.envelopeLow !== null && e.envelopeHigh !== null)
    expect(withBounds.length).toBeGreaterThan(0)
    for (const entry of withBounds.slice(0, 50)) {
      expect(entry.envelopeLow!).toBeLessThanOrEqual(entry.envelopeHigh!)
      expect(entry.scenariosEvaluated).toBe(324)
    }

    // Everything selected is on a Pareto front.
    for (const id of run.plan.selectedIds) {
      const result = run.results.find((entry) => String(entry.stop.id) === id)
      expect(result?.paretoFront).not.toBeNull()
    }

    // Determinism.
    const again = await executeRun(REQUEST, { now: FIXED_NOW })
    expect(again.runId).toBe(run.runId)
    expect(again.plan.selectedIds).toEqual(run.plan.selectedIds)
  }, 120_000)

  it('reports the anomaly validation honestly', async () => {
    resetServerEnvCache()
    const run = await executeRun(REQUEST, { now: FIXED_NOW })
    const validation = run.methodology.anomaly.validation

    expect(validation.holdoutSnapshots.length).toBe(2)
    expect(validation.comparedCells).toBeGreaterThan(1000)
    expect(['PERSISTENT', 'WEAK', 'NOT_PERSISTENT', 'INSUFFICIENT_DATA']).toContain(
      validation.verdict,
    )
    // The fixture contains spatially fixed hot patches, so a correct
    // implementation must find the anomaly persistent out of sample.
    expect(validation.verdict).toBe('PERSISTENT')
    expect(validation.rankCorrelation).toBeGreaterThan(0.6)
    expect(validation.topDecileRetention).toBeGreaterThan(validation.topDecileChanceLevel)
  }, 120_000)

  it('never claims the shelter status of any stop', async () => {
    resetServerEnvCache()
    const run = await executeRun(REQUEST, { now: FIXED_NOW })
    for (const entry of run.results) {
      expect(entry.stop.shelterStatus).toBe('unknown')
    }
    expect(run.manifest.claimsBlocked).toContain('stop_is_unsheltered')
    expect(run.manifest.claimsBlocked).toContain('people_protected')
    expect(run.manifest.claimsBlocked).toContain('temperature_reduced')
  }, 120_000)
})
