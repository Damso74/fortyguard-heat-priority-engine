/**
 * Measure the interactive response, so the size claim is a measurement.
 *
 * Reports the decoded bytes of the full run and of the summary `/api/plans`
 * actually returns, together with cold and warm engine timings.
 *
 * Timings are **reported, not asserted**. Wall-clock on CI hardware is not a
 * property of this repository, and a threshold that flakes gets raised until it
 * means nothing. The size budget is the assertion, and it lives in a test
 * (`tests/unit/payload-budget.test.ts`) because bytes are deterministic.
 *
 * Nothing here touches the network.
 *
 *   npx tsx scripts/measure-payload.mts
 */

import { executeRun } from '@/lib/agent/run'
import { toPlanSummary } from '@/lib/agent/summary'
import { MAX_SUMMARY_BYTES } from '@/app/api/plans/route'

/**
 * The decoded size of `/api/plans` before this work, for the same request.
 *
 * Recorded rather than recomputed: the code that produced it is gone, so the
 * only honest way to keep the comparison is to pin the number that was measured.
 *
 * It was measured with `JSON.stringify(...).length` — UTF-16 code units, not
 * bytes. The reduction below is therefore computed in the same units, so the
 * ratio is like-for-like, and the true UTF-8 size is reported alongside it. The
 * two differ by the multi-byte characters this payload is full of: the degree
 * sign, the em dashes and the `·` in every unit label.
 */
const AUDITED_BASELINE_UTF16_UNITS = 5_576_488

const REQUEST = { aoiId: 'central-phoenix', capacity: 50, analysisDate: '2026-08-03' }

const coldStart = Date.now()
const run = await executeRun(REQUEST)
const coldMs = Date.now() - coldStart

const warmStart = Date.now()
await executeRun(REQUEST)
const warmMs = Date.now() - warmStart

const fullJson = JSON.stringify(run)
const summary = toPlanSummary(run)
const summaryJson = JSON.stringify(summary)

const fullUnits = fullJson.length
const summaryUnits = summaryJson.length
const summaryBytes = Buffer.byteLength(summaryJson, 'utf8')
const fullBytes = Buffer.byteLength(fullJson, 'utf8')

const line = (label: string, value: string) =>
  process.stdout.write(`${label.padEnd(34)}${value}\n`)

line('request', JSON.stringify(REQUEST))
line('stops in area', String(run.results.length))
line('heat cells', String(run.heatCells.length))
process.stdout.write('\n')
line('audited baseline (UTF-16 units)', AUDITED_BASELINE_UTF16_UNITS.toLocaleString())
line('full run object (UTF-16 units)', fullUnits.toLocaleString())
line('/api/plans summary (UTF-16 units)', summaryUnits.toLocaleString())
line(
  'reduction vs baseline (like-for-like)',
  `${((1 - summaryUnits / AUDITED_BASELINE_UTF16_UNITS) * 100).toFixed(1)}%`,
)
process.stdout.write('\n')
line('full run object (UTF-8 bytes)', `${fullBytes.toLocaleString()} B`)
line('/api/plans summary (UTF-8 bytes)', `${summaryBytes.toLocaleString()} B — what travels`)
line('budget enforced by the route', `${MAX_SUMMARY_BYTES.toLocaleString()} B`)
process.stdout.write('\n')
line('engine, cold (first run)', `${coldMs} ms`)
line('engine, second run', `${warmMs} ms`)
line(
  'served from the run cache',
  'an identical request is answered from the stored run, so the engine does not run at all',
)
process.stdout.write('\n')

for (const [key, value] of Object.entries(summary)) {
  const bytes = Buffer.byteLength(JSON.stringify(value ?? null), 'utf8')
  if (bytes > 20_000) line(`  summary.${key}`, `${bytes.toLocaleString()} B`)
}

if (summaryBytes > MAX_SUMMARY_BYTES) {
  process.stderr.write('\nThe summary is over budget.\n')
  process.exit(1)
}
