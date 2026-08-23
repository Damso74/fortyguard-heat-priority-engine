import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { executeRun } from '@/lib/agent/run'
import { resetServerEnvCache } from '@/lib/config/server-env'
import { loadSourceProvenance, loadStopDataset } from '@/lib/data/stops'
import { validateAnomalies, validationStatement } from '@/lib/metrics/anomaly'
import { exportRunJson, planPreamble } from '@/lib/export/plan-export'
import { enumerateScenarios } from '@/lib/metrics/exposure'

/**
 * Regression tests for the methodology rules that are only observable at
 * dataset or whole-run level. The per-formula rules live in exposure.test.ts.
 */

const ROOT = process.cwd()
const FIXED_NOW = () => new Date('2026-08-04T18:00:00.000Z')
const REQUEST = {
  aoiId: 'central-phoenix',
  capacity: 50,
  analysisDate: '2026-08-03',
  snapshotTimes: ['11:00', '14:00', '17:00'],
  dayType: 'weekday' as const,
}

/**
 * One run, shared by every test in this file.
 *
 * The run now re-selects across all 324 scenarios, so it costs a few seconds.
 * Executing it once per assertion would dominate the suite for no extra
 * coverage — the run is deterministic, so a shared instance is the same object
 * every test would have built for itself.
 */
let cachedRun: Awaited<ReturnType<typeof executeRun>> | null = null
async function sharedRun() {
  if (!cachedRun) {
    resetServerEnvCache()
    cachedRun = await executeRun(REQUEST, { now: FIXED_NOW })
  }
  return cachedRun
}

/* ========================================================================== */
/* RULE 4 — the quarter is fiscal, labelled, and its mismatch disclosed        */
/* ========================================================================== */

describe('RULE 4 — FY2024 Q4 labelling and period mismatch', () => {
  it('labels the base quarter as a fiscal quarter with explicit months', async () => {
    const run = await sharedRun()
    expect(run.methodology.exposure.ridershipQuarter).toBe('2024_4')
    expect(run.methodology.exposure.ridershipQuarterLabel).toBe('FY2024 Q4 — Apr–Jun 2024')
  }, 120_000)

  it('records the fiscal-year reading and its evidence in the dataset provenance', () => {
    const provenance = loadStopDataset().provenance as Record<
      string,
      { fiscalYearNote?: string; baseQuarterLabel?: string; periodMismatch?: string }
    >
    expect(provenance.ridership?.baseQuarterLabel).toBe('FY2024 Q4 — Apr–Jun 2024')
    expect(provenance.ridership?.fiscalYearNote).toMatch(/FISCAL/)
    // The inference is disclosed as an inference, not asserted as documented.
    expect(provenance.ridership?.fiscalYearNote).toMatch(/no data dictionary/i)
  })

  it('discloses the mismatch with the July-2026 GTFS and the thermal date', async () => {
    const run = await sharedRun()
    expect(run.methodology.exposure.periodMismatch).toMatch(/Apr–Jun 2024/)
    expect(run.methodology.exposure.periodMismatch).toMatch(/July 2026/)
    expect(run.methodology.exposure.periodMismatch).toMatch(/2026-08-03/)
    expect(run.limitations.join(' ')).toMatch(/does not match the GTFS schedule/)
  }, 120_000)
})

/* ========================================================================== */
/* RULE 5 — the newer source, held at the last defensible quarter             */
/* ========================================================================== */

describe('RULE 5 — newer official source, most recent defensible quarter', () => {
  const provenance = loadSourceProvenance()
  const ridership = provenance.sources.find((s) => s.key === 'valley_metro_quarterly_ridership')!

  it('uses the newer BusRidershipByQuarterForPortal service', () => {
    expect(ridership.layer_url).toContain('BusRidershipByQuarterForPortal')
    expect(ridership.layer_url).toMatch(/FeatureServer\/6$/)
  })

  it('records why later published quarters were rejected, with the figures', () => {
    const notes = ridership.known_limitations.join(' ')
    expect(notes).toMatch(/demonstrably incomplete/)
    expect(notes).toMatch(/43092/)
    expect(notes).toMatch(/19324/)
  })

  it('reads the avg* columns, which the service publishes as strings', () => {
    expect(ridership.fields_used_by_this_project).toContain('avg2024_4')
    expect(ridership.known_limitations.join(' ')).toMatch(/STRINGS/)
  })

  it('improved coverage over the superseded source', () => {
    // The older layer gave 3960 stops; the newer one gives more.
    expect(loadStopDataset().counts.withDocumentedRidership).toBeGreaterThan(3960)
  })
})

/* ========================================================================== */
/* RULE 9 — the spread is a scenario envelope, never an uncertainty interval  */
/* ========================================================================== */

describe('RULE 9 — scenario envelope naming', () => {
  it('names the spread an envelope everywhere it is exported', async () => {
    const run = await sharedRun()

    expect(run.methodology.scenarioEnvelope.description).toMatch(/not a confidence interval/)
    expect(run.methodology.scenarioEnvelope.scenarioCount).toBe(324)

    const json = exportRunJson(run)
    expect(json).toMatch(/envelopeLow/)
    expect(json).toMatch(/scenarioEnvelope/)
    // The old vocabulary must not survive anywhere in an export.
    expect(json).not.toMatch(/uncertaintyInterval|uncertainty_interval/i)

    const preamble = JSON.stringify(planPreamble(run))
    expect(preamble).not.toMatch(/uncertainty interval/i)
  }, 120_000)

  it('exposes every result with envelope fields rather than interval fields', async () => {
    const run = await sharedRun()
    const complete = run.results.filter((entry) => entry.complete)
    expect(complete.length).toBeGreaterThan(200)
    for (const entry of complete.slice(0, 40)) {
      expect(entry.envelopeLow).not.toBeNull()
      expect(entry.envelopeHigh).not.toBeNull()
      expect(entry.envelopeLow!).toBeLessThanOrEqual(entry.envelopeHigh!)
      expect(entry.scenariosEvaluated).toBe(324)
    }
  }, 120_000)
})

/* ========================================================================== */
/* RULE 11 — a synthetic PERSISTENT is never Phoenix validation               */
/* ========================================================================== */

describe('RULE 11 — synthetic validation is never presented as Phoenix validation', () => {
  it('tags the fixture run as an estimator self-check', async () => {
    const run = await sharedRun()
    const validation = run.methodology.anomaly.validation

    expect(run.manifest.dataMode).toBe('DEMO_SYNTHETIC')
    expect(validation.scope).toBe('synthetic_fixture')
    expect(validation.statement).toMatch(/NOT evidence about Phoenix/)
    expect(validation.statement).toMatch(/self-check/)
  }, 120_000)

  it('states in the limitations that no Phoenix anomaly has been validated', async () => {
    const run = await sharedRun()
    expect(run.limitations.join(' ')).toMatch(/NO Phoenix anomaly has been validated/)
  }, 120_000)

  it('does not let a fixture verdict raise confidence', async () => {
    const run = await sharedRun()
    for (const entry of run.results.filter((r) => r.complete).slice(0, 20)) {
      // Capped at the same level as an unvalidated live run.
      expect(entry.confidence.components.anomalyValidation).toBe(0.15)
      expect(entry.confidence.reasons.join(' ')).toMatch(/not against Phoenix/)
    }
  }, 120_000)

  it('produces different wording for a live scope, from one place only', () => {
    expect(validationStatement('PERSISTENT', 'live_measurement')).toMatch(/held-out FortyGuard/)
    expect(validationStatement('PERSISTENT', 'synthetic_fixture')).toMatch(/NOT evidence/)
    const empty = validateAnomalies(new Map(), 'synthetic_fixture')
    expect(empty.scope).toBe('synthetic_fixture')
    expect(empty.statement).toMatch(/NOT evidence about Phoenix/)
  })
})

/* ========================================================================== */
/* RULE 12 — assumption sensitivity across all five dimensions                */
/* ========================================================================== */

describe('RULE 12 — candidates are assumption-sensitive unless stable everywhere', () => {
  it('flags every selected stop that does not survive all 324 scenarios', async () => {
    const run = await sharedRun()
    const selected = new Set(run.plan.selectedIds)

    for (const entry of run.results) {
      const id = String(entry.stop.id)
      if (!selected.has(id)) {
        // Anything not selected in the base run is sensitive by definition.
        expect(entry.assumptionSensitive, id).toBe(true)
        continue
      }
      const stable = entry.scenarioSelectionRate >= 1
      expect(entry.assumptionSensitive, id).toBe(!stable)
    }
  }, 120_000)

  it('names which scenario settings drop a sensitive candidate', async () => {
    const run = await sharedRun()
    const sensitive = run.results.filter(
      (entry) => run.plan.selectedIds.includes(String(entry.stop.id)) && entry.assumptionSensitive,
    )
    expect(sensitive.length).toBeGreaterThan(0)

    // Attribution is one-at-a-time, so a candidate is EITHER dropped by some
    // single setting — which is named — OR only by combinations, which is said
    // explicitly. The earlier version unioned every dimension that differed in
    // any losing scenario, so `sensitiveTo` was never empty and never accurate.
    let namedSingleSetting = 0
    let combinationOnly = 0
    for (const entry of sensitive) {
      if (entry.sensitiveTo.length > 0) namedSingleSetting += 1
      else if (entry.droppedByCombinationOnly) combinationOnly += 1
      // Never both empty and unexplained.
      expect(
        entry.sensitiveTo.length > 0 || entry.droppedByCombinationOnly,
        `stop ${entry.stop.id} is assumption-dependent with no explanation`,
      ).toBe(true)
    }
    expect(namedSingleSetting).toBeGreaterThan(0)
    expect(namedSingleSetting + combinationOnly).toBe(sensitive.length)

    for (const entry of sensitive.slice(0, 10)) {
      for (const reason of entry.sensitiveTo) {
        expect(reason).toMatch(
          /^(demandProfile|routeChoice|waitCap|referenceTemperatureC|ridershipQuarter)=/,
        )
      }
      const reasons = entry.confidence.reasons.join(' ')
      expect(reasons).toMatch(/Assumption-dependent/)
      expect(reasons).toMatch(
        entry.sensitiveTo.length > 0
          ? /drops when .+ alone is changed/
          : /no single setting drops it — only combinations do/,
      )
      // The reason must carry the two figures the reader needs to weigh it:
      // how often it is selected, and how far its rank moves while it is.
      expect(reasons).toMatch(
        new RegExp(
          `selected in ${entry.scenarioSelectionCount} of ${entry.scenarioCount} evaluable scenarios`,
        ),
      )
      expect(reasons).toMatch(/ranking \d+(–\d+)? where selected/)
    }
  }, 120_000)

  it('reports the run as a robust / assumption-dependent split, with frequency and rank range', async () => {
    const run = await sharedRun()

    // The split partitions the plan exactly — no selection is in both or neither.
    expect([...run.plan.robustIds, ...run.plan.assumptionDependentIds].sort()).toEqual(
      [...run.plan.selectedIds].sort(),
    )
    expect(run.plan.robustIds.some((id) => run.plan.assumptionDependentIds.includes(id))).toBe(false)

    expect(run.plan.headline).toBe(
      `${run.plan.robustIds.length} robust ${run.plan.robustIds.length === 1 ? 'priority' : 'priorities'} + ` +
        `${run.plan.assumptionDependentIds.length} assumption-dependent ` +
        `${run.plan.assumptionDependentIds.length === 1 ? 'candidate' : 'candidates'}`,
    )

    const byId = new Map(run.results.map((entry) => [String(entry.stop.id), entry]))

    for (const id of run.plan.robustIds) {
      const entry = byId.get(id)!
      expect(entry.assumptionSensitive, id).toBe(false)
      // Robust means selected in EVERY scenario, not merely most of them.
      expect(entry.scenarioSelectionCount, id).toBe(run.plan.scenarioCount)
    }

    for (const id of run.plan.assumptionDependentIds) {
      const entry = byId.get(id)!
      expect(entry.assumptionSensitive, id).toBe(true)
      expect(entry.scenarioSelectionCount, id).toBeLessThan(run.plan.scenarioCount)
    }

    // Both figures travel with every selection, robust or not — a reader
    // comparing two of them needs the same numbers on both.
    for (const id of run.plan.selectedIds) {
      const entry = byId.get(id)!
      expect(entry.scenarioCount, id).toBe(run.plan.scenarioCount)
      expect(entry.scenarioSelectionCount, id).toBeGreaterThan(0)
      expect(entry.scenarioRankBest, id).not.toBeNull()
      expect(entry.scenarioRankWorst, id).not.toBeNull()
      expect(entry.scenarioRankBest!, id).toBeGreaterThanOrEqual(1)
      expect(entry.scenarioRankWorst!, id).toBeLessThanOrEqual(run.plan.capacity)
      expect(entry.scenarioRankWorst!, id).toBeGreaterThanOrEqual(entry.scenarioRankBest!)
    }
  }, 120_000)

  it('covers all five dimensions in the rule it publishes', async () => {
    const run = await sharedRun()
    const dimensions = Object.keys(run.methodology.scenarioEnvelope.dimensions)
    expect(dimensions.sort()).toEqual([
      'demandProfile',
      'referenceTemperatureC',
      'ridershipQuarter',
      'routeChoice',
      'waitCap',
    ])
    expect(run.methodology.scenarioEnvelope.assumptionSensitiveRule).toMatch(/every one of the 324/)
    expect(enumerateScenarios()).toHaveLength(324)
  }, 120_000)
})

/* ========================================================================== */
/* Cross-cutting: the vocabulary the rules forbid                             */
/* ========================================================================== */

describe('forbidden vocabulary', () => {
  it('never calls 30 °C a health threshold anywhere in the shipped code or docs', () => {
    const files = [
      'lib/metrics/exposure.ts',
      'lib/agent/run.ts',
      'docs/scoring-methodology.md',
      'app/methodology/page.tsx',
    ]
    for (const file of files) {
      // Comments and prose wrap, so the negation may sit on the previous line.
      // Collapse whitespace and inspect a window around each mention.
      const text = readFileSync(join(ROOT, file), 'utf-8').replace(/\s+/g, ' ')
      const pattern = /health/gi
      let match: RegExpExecArray | null
      while ((match = pattern.exec(text)) !== null) {
        const window = text.slice(Math.max(0, match.index - 90), match.index + 60)
        expect(window, `${file}: …${window.trim()}…`).toMatch(/\bnot\b|\bNOT\b|never|no source/i)
      }
    }
  })

  it('describes the reference temperature as an API default', async () => {
    const run = await sharedRun()
    expect(run.methodology.exposure.referenceTemperatureSource).toMatch(/API/)
    expect(run.methodology.exposure.referenceTemperatureSource).toMatch(/NOT a health/)
  }, 120_000)

  /*
   * Phrases that assert a measurement this project has never taken, or an
   * authority nobody exercised. Each was in the tree: the submission draft
   * described "a real heat surface" and called the export "human-approved"; the
   * claim register listed the overlap of ridership with "the measured heat
   * signal". No FortyGuard key has ever been issued to this project, and there
   * is no authentication anywhere in it, so all three were false.
   *
   * The scan covers what a reader can actually reach — the interface, the API
   * surfaces, the exports and the documentation — rather than every comment.
   */
  const FORBIDDEN_PHRASES = [
    'real heat surface',
    'real hot spot',
    'measured heat signal',
    'human-approved',
    'human approved',
  ]

  const PUBLIC_SURFACES = [
    'app',
    'components',
    'lib/claims',
    'lib/export',
    'docs',
    'README.md',
  ]

  function walk(target: string, out: string[] = []): string[] {
    const full = join(ROOT, target)
    if (statSync(full).isFile()) {
      if (/\.(ts|tsx|md)$/.test(full)) out.push(target)
      return out
    }
    for (const entry of readdirSync(full)) {
      walk(`${target}/${entry}`, out)
    }
    return out
  }

  it('makes no claim of a measurement or an approval on any public surface', () => {
    const offenders: string[] = []
    for (const surface of PUBLIC_SURFACES) {
      for (const file of walk(surface)) {
        // The page that exists to catalogue what may not be said is allowed to
        // name the phrases it forbids, and so is this test.
        if (file === 'docs/findings-provenance.md') continue
        const text = readFileSync(join(ROOT, file), 'utf-8')
        for (const phrase of FORBIDDEN_PHRASES) {
          if (text.toLowerCase().includes(phrase)) offenders.push(`${file}: ${phrase}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('keeps the synthetic split labelled wherever it is quoted', () => {
    // 13 + 37 is real arithmetic over a surface this project generated. Quoting
    // it without saying so turns a demonstration of the method into a finding
    // about Phoenix.
    for (const file of ['README.md', 'docs/submission-draft.md', 'docs/scoring-methodology.md']) {
      const text = readFileSync(join(ROOT, file), 'utf-8')
      const index = text.indexOf('13 robust')
      if (index < 0) continue
      const window = text.slice(index, index + 600)
      expect(window.toLowerCase(), file).toContain('synthetic')
    }
  })

  it('never presents the fixture anomaly verdict as a Phoenix finding', async () => {
    const run = await sharedRun()
    expect(run.methodology.anomaly.validation.scope).toBe('synthetic_fixture')
    expect(run.methodology.anomaly.validation.statement).toMatch(/NOT evidence about Phoenix/)
    expect(run.limitations.join(' ')).toMatch(/NO Phoenix anomaly has been validated/)
  }, 120_000)
})
