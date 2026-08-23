#!/usr/bin/env node
/**
 * Rebuild every generated artefact and check it reproduces.
 *
 * The reproducibility claim in the README is only worth something if a build
 * actually runs. This step:
 *
 * 1. re-derives the GTFS day-type profiles from the **committed archive**;
 * 2. rebuilds the joined analysis dataset from the licensed committed layers
 *    plus the two ephemeral, non-redistributed verification inputs;
 * 3. compares both against the canonical hashes recorded in the manifests;
 * 4. restores the working tree if anything drifted, so a failing verification
 *    does not leave the repository half-rewritten.
 *
 * Canonical hashes exclude `generatedAtUtc`. The file digest necessarily changes
 * on every run because that timestamp is inside the file, which is exactly why
 * it was useless as a verification target before.
 *
 * Full mode requires `npm run data:fetch` first on a clean clone. Distributed
 * verification uses `--gtfs-only`, because its ODC-BY archive remains tracked.
 */

import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const isWindows = process.platform === 'win32'
const PYTHON = process.env.PYTHON_BIN ?? (isWindows ? 'python' : 'python3')

const allArtefacts = [
  {
    label: 'GTFS day-type profiles',
    generated: 'data/generated/stop_service_frequency.json',
    manifest: 'data/raw/valley_metro_gtfs_metadata.json',
    expected: (manifest) => manifest.derived.canonicalSha256,
    command: [PYTHON, ['scripts/fetch/fetch_gtfs.py', '--rebuild']],
  },
  {
    label: 'Joined analysis dataset',
    generated: 'data/generated/phoenix_transit_stops.json',
    manifest: 'data/manifests/generated-dataset.json',
    expected: (manifest) => manifest.artifact.canonicalSha256,
    command: [PYTHON, ['scripts/generate/build_analysis_dataset.py']],
  },
]
const ARTEFACTS = process.argv.includes('--gtfs-only') ? allArtefacts.slice(0, 1) : allArtefacts

/**
 * The canonical hash is read from the builder's own output, never recomputed
 * here.
 *
 * A second implementation of the same canonicalisation is a bug waiting to
 * happen, and this one had it: `json.dumps` writes a float-valued `100.0` where
 * `JSON.stringify` writes `100`, so the two digests disagreed on a dataset that
 * was in fact perfectly reproducible. One implementation, in the script that
 * builds the artefact; this file only compares what it printed against what the
 * manifest recorded.
 */
function rebuiltCanonicalHash(stdout) {
  const start = stdout.indexOf('{')
  if (start < 0) throw new Error('Rebuild produced no JSON summary on stdout.')
  const parsed = JSON.parse(stdout.slice(start))
  const hash = parsed.canonicalSha256
  if (typeof hash !== 'string') {
    throw new Error('Rebuild summary carries no canonicalSha256.')
  }
  return hash
}

let failed = 0

for (const artefact of ARTEFACTS) {
  process.stdout.write(`\n--- ${artefact.label} ---\n`)

  const generatedPath = join(ROOT, artefact.generated)
  const manifestPath = join(ROOT, artefact.manifest)
  const before = readFileSync(generatedPath, 'utf-8')
  const manifestBefore = readFileSync(manifestPath, 'utf-8')
  const expected = artefact.expected(JSON.parse(manifestBefore))

  const [command, args] = artefact.command
  const outcome = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'inherit'],
    shell: isWindows,
  })
  if ((outcome.status ?? 1) !== 0) {
    process.stdout.write(`FAIL  rebuild command exited ${outcome.status}\n`)
    writeFileSync(generatedPath, before, 'utf-8')
    writeFileSync(manifestPath, manifestBefore, 'utf-8')
    failed += 1
    continue
  }

  const actual = rebuiltCanonicalHash(outcome.stdout ?? '')
  if (actual === expected) {
    process.stdout.write(`PASS  canonical ${actual.slice(0, 16)}… reproduced\n`)
  } else {
    process.stdout.write(
      `FAIL  canonical hash drifted\n      recorded ${expected}\n      rebuilt  ${actual}\n` +
        '      Either an input changed or the pipeline is not deterministic.\n' +
        '      Explain the difference in docs/data-provenance.md before updating the manifest.\n',
    )
    failed += 1
  }

  // The rebuild rewrites generatedAtUtc even when nothing else moved. Restoring
  // both files keeps `git status` clean, so a verification run never looks like
  // an uncommitted data change.
  writeFileSync(generatedPath, before, 'utf-8')
  writeFileSync(manifestPath, manifestBefore, 'utf-8')
}

process.stdout.write(
  failed === 0
    ? `\n${ARTEFACTS.length === 1 ? 'The distributed GTFS artefact reproduced' : 'All generated artefacts reproduced'} from the available inputs.\n`
    : `\n${failed} artefact(s) did not reproduce.\n`,
)
process.exit(failed === 0 ? 0 : 1)
