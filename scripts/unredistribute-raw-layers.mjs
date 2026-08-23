#!/usr/bin/env node
/**
 * Remove the raw extracts whose redistribution permission is unresolved.
 *
 * **This script has not been run.** It exists so that the decision, once a person
 * makes it, is one command rather than a research project — and so that the cost
 * of making it is visible before it is made.
 *
 * ## The situation
 *
 * Four raw ArcGIS source files are committed and public here. Two Valley Metro
 * bus-stop items explicitly permit unrestricted sharing, modification and use.
 * Permission remains unresolved for the City BusStops extract and the Valley
 * Metro quarterly-ridership item. `docs/data-provenance.md` §8 records the
 * item URLs, terms and review date.
 *
 * The GTFS archive is deliberately **not** in this list: it is published under
 * ODC-BY, which permits redistribution with attribution.
 *
 * ## What removing them costs
 *
 * These files are inputs to the offline reproducibility claims, which are among
 * the strongest things this project has:
 *
 * - `python scripts/fetch/fetch_arcgis.py --check` re-hashes them;
 * - `node scripts/verify-rebuild.mjs` rebuilds the analysis dataset from them and
 *   compares canonical hashes;
 * - `python scripts/spike/analyze_shadefirst.py` reproduces the baseline metrics;
 * - several unit tests pin the resulting artefact hashes.
 *
 * With the extracts gone, all of that needs `npm run data:fetch` first, which
 * needs the network. That is a real loss, and it is why this is a decision rather
 * than a cleanup.
 *
 * `data/generated/phoenix_transit_stops.json` is a **derivative** of the same
 * layers and is left in place: whether a derived join is redistribution of the
 * source is exactly the question a person has to answer, and guessing at it here
 * would be the same mistake in the other direction.
 *
 * ## What this does not do
 *
 * It **does not rewrite history**. Previous public commits still contain these
 * files, and they will remain retrievable from this repository's history. A
 * force-push to hide that would be destructive and would not be honest either.
 * If the history matters, that is a separate, deliberate conversation with
 * whoever owns the repository.
 *
 * ## Usage
 *
 *   node scripts/unredistribute-raw-layers.mjs                        # dry run
 *   node scripts/unredistribute-raw-layers.mjs --i-have-a-licensing-decision
 */

import { existsSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Redistribution permission remains unresolved. Licensed sources are not here. */
const UNLICENSED_EXTRACTS = [
  'data/raw/phoenix_bus_stops.geojson',
  'data/raw/valley_metro_quarterly_ridership.json',
]

/** What stops working the moment they are gone. */
const BREAKS = [
  'python scripts/fetch/fetch_arcgis.py --check   (re-hashes the raw layers)',
  'node scripts/verify-rebuild.mjs                (rebuilds the dataset from them)',
  'python scripts/spike/analyze_shadefirst.py     (reproduces the baseline metrics)',
  'npm test                                       (tests pinning artefact hashes)',
  '…and therefore `npm run verify` and the GitHub Actions workflow.',
  'Each needs `npm run data:fetch` first, which needs the network.',
]

const confirmed = process.argv.includes('--i-have-a-licensing-decision')

let total = 0
process.stdout.write('Files this would remove from the tracked tree:\n\n')
for (const file of UNLICENSED_EXTRACTS) {
  const path = join(root, file)
  const present = existsSync(path)
  const bytes = present ? statSync(path).size : 0
  total += bytes
  process.stdout.write(
    `  ${present ? '✓' : '·'} ${file.padEnd(52)}${present ? `${(bytes / 1_048_576).toFixed(2)} MB` : '(already absent)'}\n`,
  )
}
process.stdout.write(`\n  total ${(total / 1_048_576).toFixed(2)} MB\n`)

process.stdout.write('\nKept deliberately:\n')
process.stdout.write('  data/raw/valley_metro_gtfs.zip        ODC-BY permits redistribution with attribution\n')
process.stdout.write('  data/raw/valley_metro_phoenix_stops.geojson      Valley Metro item permits unrestricted sharing\n')
process.stdout.write('  data/raw/valley_metro_phoenix_stops_2023.geojson Valley Metro item permits unrestricted sharing\n')
process.stdout.write('  data/raw/*_metadata.json              facts recorded about the sources, not the sources\n')
process.stdout.write('  data/manifests/source-provenance.json URLs, queries, timestamps, counts and hashes\n')

process.stdout.write('\nWhat this breaks:\n')
for (const item of BREAKS) process.stdout.write(`  - ${item}\n`)

process.stdout.write(
  '\nThis does NOT rewrite history. Previous public commits still contain these files\n' +
    'and will remain retrievable. Hiding that would need a force-push, which is\n' +
    'destructive and would not make the earlier redistribution not have happened.\n',
)

if (!confirmed) {
  process.stdout.write(
    '\nDRY RUN — nothing was removed.\n\n' +
      'Re-run with --i-have-a-licensing-decision once a person has established that\n' +
      'the two unresolved layers should not remain redistributed. Read\n' +
      'docs/data-provenance.md §8 first; the alternative is direct permission\n' +
      'from the publisher, recorded there with a source, and to say\n' +
      'so there with a source.\n',
  )
  process.exit(0)
}

const present = UNLICENSED_EXTRACTS.filter((file) => existsSync(join(root, file)))
if (present.length === 0) {
  process.stdout.write('\nNothing to remove.\n')
  process.exit(0)
}

// One command, not two. `git rm --cached` untracks the files, after which
// `git rm -f` on the same paths fails with "did not match any files" — so the
// working tree was left populated and the script exited non-zero halfway
// through. `git rm -f` alone removes them from both the index and the disk.
execFileSync('git', ['rm', '-f', '--', ...present], { cwd: root, stdio: 'inherit' })

process.stdout.write(
  '\nRemoved from the working tree and the index. Now, deliberately:\n\n' +
    '  1. add them to .gitignore so a re-fetch does not re-commit them;\n' +
    '  2. update docs/data-provenance.md §8 to record the decision and its date;\n' +
    '  3. update the CI workflow: the offline rebuild steps need `npm run data:fetch`\n' +
    '     first, or must be marked as requiring network access;\n' +
    '  4. commit. Do not force-push.\n',
)
