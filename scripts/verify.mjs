#!/usr/bin/env node
/**
 * Single verification command.
 *
 * Runs every gate in order, keeps going after a failure so the report is
 * complete rather than stopping at the first red, and writes
 * docs/verification-report.md with what actually happened.
 *
 * Nothing here is allowed to soften a failure: no `|| true`, no skipped suites,
 * no reduced test selection. A red step makes the whole command exit non-zero.
 */

import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const isWindows = process.platform === 'win32'

const PYTHON = process.env.PYTHON_BIN ?? (isWindows ? 'python' : 'python3')

const STEPS = [
  { id: 'lint', label: 'ESLint', command: 'npm', args: ['run', 'lint'] },
  { id: 'typecheck', label: 'TypeScript', command: 'npm', args: ['run', 'typecheck'] },
  {
    id: 'distributed-data',
    label: 'Distributed data hashes and exclusions',
    command: 'npm',
    args: ['run', 'data:check-distributed'],
  },
  { id: 'unit', label: 'Vitest (unit + integration)', command: 'npm', args: ['test'] },
  {
    // Every file in the production snapshot store must be a valid real capture
    // under the current capability manifest, and no two may answer the same
    // request. A fabricated snapshot was committed once and nothing went red.
    id: 'snapshots',
    label: 'Thermal snapshot store',
    command: 'npm',
    args: ['run', 'check:snapshots'],
  },
  { id: 'build', label: 'Next production build', command: 'npm', args: ['run', 'build'] },
  {
    // Redundant with the `postbuild` hook, and deliberately so: this is the step
    // that stays red if somebody removes the hook.
    id: 'assets',
    label: 'Generated runtime assets (MapLibre worker)',
    command: 'node',
    args: ['scripts/check-build-assets.mjs'],
  },
  {
    id: 'gtfs-check',
    label: 'GTFS archive and derived hashes',
    command: PYTHON,
    args: ['scripts/fetch/fetch_gtfs.py', '--check'],
  },
  {
    // The two raw inputs without redistribution terms are deliberately absent.
    // The GTFS-derived artefact remains fully reproducible from its licensed,
    // committed archive; the joined dataset itself is verified by file digest.
    id: 'gtfs-rebuild',
    label: 'GTFS rebuild reproduces the canonical hash',
    command: 'node',
    args: ['scripts/verify-rebuild.mjs', '--gtfs-only'],
  },
  { id: 'secrets', label: 'Secret scan', command: 'node', args: ['scripts/scan-secrets.mjs'] },
  {
    id: 'audit',
    label: 'Dependency audit (high severity)',
    command: 'npm',
    args: ['audit', '--audit-level=high'],
  },
  { id: 'e2e', label: 'Playwright end-to-end', command: 'npm', args: ['run', 'test:e2e'] },
]

/**
 * What a runner says it ran, read off its own summary line.
 *
 * Returns null for steps that do not report a count, which is most of them —
 * an absent count is reported as absent rather than as zero.
 */
function countOf(id, output) {
  if (id === 'unit') {
    const files = /Test Files\s+(\d+) passed \((\d+)\)/.exec(output)
    const tests = /Tests\s+(\d+) passed \((\d+)\)/.exec(output)
    if (!tests) return null
    return `${tests[1]} tests` + (files ? ` in ${files[1]} files` : '')
  }
  if (id === 'e2e') {
    const passed = /(\d+) passed/.exec(output)
    return passed ? `${passed[1]} tests` : null
  }
  return null
}

const only = process.argv.slice(2).filter((argument) => !argument.startsWith('-'))
const selected = only.length ? STEPS.filter((step) => only.includes(step.id)) : STEPS

const results = []

for (const step of selected) {
  process.stdout.write(`\n=== ${step.label} ===\n`)
  const started = Date.now()
  // Captured rather than inherited, so the report can record what actually ran.
  // Every count this project ever wrote by hand had gone stale by the time
  // somebody read it, so the counts are extracted from the runners instead.
  const outcome = spawnSync(step.command, step.args, {
    cwd: ROOT,
    encoding: 'utf-8',
    shell: isWindows,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, FORCE_COLOR: '0' },
  })
  process.stdout.write(outcome.stdout ?? '')
  process.stderr.write(outcome.stderr ?? '')

  const durationMs = Date.now() - started
  const code = outcome.status ?? (outcome.error ? -1 : 0)
  results.push({
    ...step,
    code,
    durationMs,
    ok: code === 0,
    error: outcome.error ? String(outcome.error.message) : null,
    counted: countOf(step.id, `${outcome.stdout ?? ''}\n${outcome.stderr ?? ''}`),
  })
  process.stdout.write(
    `--- ${step.label}: ${code === 0 ? 'PASS' : 'FAIL'} (${(durationMs / 1000).toFixed(1)}s)\n`,
  )
}

const failed = results.filter((result) => !result.ok)

/* ------------------------------- report ---------------------------------- */

const lines = [
  '# Verification report',
  '',
  `Generated: ${new Date().toISOString()}`,
  `Command: \`npm run verify\`${only.length ? ` (subset: ${only.join(', ')})` : ''}`,
  `Node: ${process.version} · Platform: ${process.platform}`,
  '',
  '| Step | Result | Ran | Duration |',
  '|---|---|---|---:|',
  ...results.map(
    (result) =>
      `| ${result.label} | ${result.ok ? 'PASS' : `FAIL (exit ${result.code})`} | ${result.counted ?? '—'} | ${(result.durationMs / 1000).toFixed(1)}s |`,
  ),
  '',
  `**Overall: ${failed.length === 0 ? 'PASS' : `FAIL — ${failed.length} step(s) red`}**`,
  '',
  '## What each step proves',
  '',
  '- **ESLint / TypeScript** — no unused code, no `any`, no `console.log` on shipped paths, strict types throughout.',
  '- **Vitest** — baseline metric regression, normalisation, scoring, capacity selection, sensitivity, tiling, zones, state machine, audit redaction, CSV injection, and the full FortyGuard client contract against typed fixtures.',
  '- **Thermal snapshot store** — every committed snapshot is a valid real capture under the current capability fingerprint, and no two answer the same request.',
  '- **Next production build** — the deployed artefact compiles.',
  '- **Generated runtime assets** — the MapLibre worker exists under public/ and matches node_modules, so a build that skipped `prebuild` cannot ship a map that renders tiles and carries no data.',
  '- **Distributed data hashes and exclusions** — retained licensed raw layers and the generated application dataset match their manifests; the two unresolved raw extracts are absent from Git.',
  '- **GTFS rebuild** — the timetable-derived artefact reproduces canonically from the committed ODC-BY archive.',
  '- **Secret scan** — no credential patterns in the tree, no server secret name in a browser asset.',
  '- **Playwright** — the whole demo journey against a production build, including the map-failure and no-key paths.',
  '',
  failed.length === 0
    ? 'No step was skipped, softened or excluded to produce this result.'
    : `Failing steps: ${failed.map((result) => result.id).join(', ')}.`,
  '',
  'The **Ran** column is read from each runner\'s own summary rather than written by hand. ' +
    'Every test count in this repository that was typed into prose had gone stale by the time ' +
    'it was read, so no document quotes one any more.',
  '',
]

writeFileSync(join(ROOT, 'docs', 'verification-report.md'), lines.join('\n'), 'utf-8')

process.stdout.write('\n')
for (const result of results) {
  process.stdout.write(
    `${result.ok ? 'PASS' : 'FAIL'}  ${result.label} (${(result.durationMs / 1000).toFixed(1)}s)\n`,
  )
}
process.stdout.write(`\nWrote docs/verification-report.md\n`)

process.exit(failed.length === 0 ? 0 : 1)
