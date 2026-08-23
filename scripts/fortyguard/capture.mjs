#!/usr/bin/env node
/**
 * Local thermal capture — the only code in this project that can spend credits.
 *
 * ## Why this is a CLI and not a route
 *
 * It used to be `POST /api/thermal/capture`, gated on a token. That was better
 * than nothing and still wrong in three ways:
 *
 * 1. **It shipped.** A credit-spending endpoint existed on every deployment, one
 *    configuration mistake away from being reachable. The safest endpoint is the
 *    one that is not deployed.
 * 2. **It wrote to the filesystem.** On Vercel that is ephemeral and read-only in
 *    the parts that matter, so a "successful" capture could vanish — after the
 *    credits were spent.
 * 3. **A request has no good lifetime.** A full capture is tiles × snapshots
 *    submissions, each polling for minutes; that outlives any serverless
 *    invocation, so a timeout would abandon paid-for work.
 *
 * A capture is an operator action taken deliberately, on a machine with a
 * filesystem, whose output is reviewed in a diff and committed. That is a CLI.
 *
 * ## The default is to spend nothing
 *
 * Running this script with only `--aoi` and `--date` prints the plan and exits.
 * Reaching a POST requires **three independent things**, none of which implies
 * another:
 *
 * 1. `RUN_LIVE_FORTYGUARD=1` in the environment — the deployment-level opt-in;
 * 2. `--confirm-spend` on the command line — the operator-level opt-in, which
 *    cannot be left set in a shell profile the way an environment variable can;
 * 3. `--max-new-submissions N`, a positive integer — the size of the spend.
 *
 * A key on its own authorises nothing, and neither does any two of the three.
 *
 * ## Refusing to run in the wrong place
 *
 * The script exits before touching the network if it detects a serverless or CI
 * environment. This is belt-and-braces — the file is not imported by the app —
 * but the cost of being wrong is money, so the check is explicit.
 *
 * ## Usage
 *
 *   # network-free: prints tiles, transmitted timestamps and the exact bill
 *   node scripts/fortyguard/capture.mjs --aoi central-phoenix --date 2026-08-03
 *
 *   # actually submits, at most 6 new submissions
 *   FORTYGUARD_API_KEY=... RUN_LIVE_FORTYGUARD=1 \
 *     node scripts/fortyguard/capture.mjs --aoi central-phoenix --date 2026-08-03 \
 *       --times 11:00,14:00,17:00 --confirm-spend --max-new-submissions 6
 *
 *   --resume    continue a checkpointed capture, polling activities already paid
 *               for instead of resubmitting them. Still needs its own budget.
 */

/* -------------------------------------------------------------------------- */
/* Refuse to run anywhere that is not a developer machine                     */
/* -------------------------------------------------------------------------- */

const HOSTED_MARKERS = [
  ['VERCEL', 'Vercel'],
  ['VERCEL_ENV', 'Vercel'],
  ['AWS_LAMBDA_FUNCTION_NAME', 'AWS Lambda'],
  ['AWS_EXECUTION_ENV', 'AWS Lambda'],
  ['NETLIFY', 'Netlify'],
  ['CF_PAGES', 'Cloudflare Pages'],
  ['GITHUB_ACTIONS', 'GitHub Actions'],
  ['CI', 'a CI runner'],
]

export function detectHostedEnvironment(env = process.env) {
  for (const [variable, name] of HOSTED_MARKERS) {
    if (env[variable]) return { variable, name }
  }
  return null
}

const hosted = detectHostedEnvironment()
if (hosted) {
  process.stderr.write(
    `Refusing to run: ${hosted.variable} is set, so this looks like ${hosted.name}.\n\n` +
      'Thermal capture spends FortyGuard credits and writes a file that must be reviewed and\n' +
      'committed. Hosted filesystems are ephemeral, hosted request lifetimes are shorter than a\n' +
      'capture, and no deployment should be able to spend money. Run this on a developer machine.\n',
  )
  process.exit(2)
}

/* -------------------------------------------------------------------------- */
/* Arguments                                                                  */
/* -------------------------------------------------------------------------- */

function parseArgs(argv) {
  const args = {
    times: ['11:00', '14:00', '17:00'],
    resume: false,
    confirmSpend: false,
    maxNewSubmissions: 0,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    const next = () => argv[++index]
    if (token === '--aoi') args.aoi = next()
    else if (token === '--date') args.date = next()
    else if (token === '--times') args.times = next().split(',').map((value) => value.trim())
    else if (token === '--granularity') args.granularity = Number(next())
    else if (token === '--max-new-submissions') args.maxNewSubmissions = Number(next())
    else if (token === '--confirm-spend') args.confirmSpend = true
    else if (token === '--dry-run') args.dryRun = true
    else if (token === '--resume') args.resume = true
    else if (token === '--help' || token === '-h') args.help = true
    else {
      process.stderr.write(`Unknown argument: ${token}\n`)
      process.exit(64)
    }
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
if (args.help || !args.aoi || !args.date) {
  process.stdout.write(
    'Usage: node scripts/fortyguard/capture.mjs --aoi <id> --date YYYY-MM-DD\n' +
      '         [--times 11:00,14:00,17:00] [--granularity 60] [--resume]\n' +
      '         [--confirm-spend --max-new-submissions N]\n\n' +
      'Without --confirm-spend AND RUN_LIVE_FORTYGUARD=1 AND a positive\n' +
      '--max-new-submissions, this prints the plan and submits nothing.\n',
  )
  process.exit(args.help ? 0 : 64)
}

/* -------------------------------------------------------------------------- */
/* Load the TypeScript modules the app uses, so there is one implementation    */
/* -------------------------------------------------------------------------- */

// The capture logic, the snapshot format and the hashes live in lib/ and are
// unit-tested there. Re-implementing any of it here would be a second source of
// truth for the most safety-critical path in the project. The npm script runs
// this file under tsx, which is what lets these .ts imports resolve.

const { AREAS_OF_INTEREST } = await import('../../lib/geo/aoi.ts')
const { FortyGuardClient } = await import('../../lib/fortyguard/client.ts')
const {
  runCapture,
  planCapture,
  checkpointPath,
  CaptureLockedError,
  CaptureBudgetError,
  CaptureReconciliationError,
} = await import('../../lib/fortyguard/capture.ts')
const { ANALYSIS_TIMEZONE } = await import('../../lib/agent/request.ts')
const { loadCapability, evaluateCapability } = await import('../../lib/fortyguard/capability.ts')

const aoi = AREAS_OF_INTEREST.find((area) => area.id === args.aoi)
if (!aoi) {
  process.stderr.write(
    `Unknown area "${args.aoi}". Known: ${AREAS_OF_INTEREST.map((a) => a.id).join(', ')}\n`,
  )
  process.exit(64)
}

if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
  process.stderr.write('--date must be YYYY-MM-DD.\n')
  process.exit(64)
}
for (const time of args.times) {
  if (!/^([01]\d|2[0-3]):00$/.test(time)) {
    process.stderr.write(
      `--times must be whole clock hours (HH:00); got "${time}". The engine joins temperature to ` +
        'an expected wait computed over a whole hour.\n',
    )
    process.exit(64)
  }
}
if (new Set(args.times.map((t) => t.slice(0, 2))).size !== args.times.length) {
  process.stderr.write('--times must be distinct hours; a repeat would be paid for and discarded.\n')
  process.exit(64)
}

const spec = {
  aoiId: aoi.id,
  analysisDate: args.date,
  snapshotTimes: args.times,
  analyticType: 'tcm',
  granularityMeters: args.granularity ?? aoi.thermalGranularityMeters,
  filterType: 1,
  timezone: ANALYSIS_TIMEZONE,
  maxTileSqMi: Number(process.env.FORTYGUARD_MAX_TILE_SQ_MI ?? 9),
}

/* -------------------------------------------------------------------------- */
/* Plan, and report the cost before spending anything                         */
/* -------------------------------------------------------------------------- */

const capability = loadCapability()
const gate = evaluateCapability(capability)
const plan = planCapture(aoi, spec)

const budget = Number.isInteger(args.maxNewSubmissions) ? args.maxNewSubmissions : 0
const hasKey = Boolean(process.env.FORTYGUARD_API_KEY)
const envOptIn =
  process.env.RUN_LIVE_FORTYGUARD === '1' || process.env.RUN_LIVE_FORTYGUARD === 'true'

process.stdout.write(
  `area          ${aoi.id}\n` +
    `date          ${spec.analysisDate}\n` +
    `strategy      ${capability.timezone.strategy} (${spec.timezone})\n` +
    `tiles         ${plan.tileCount} at <= ${spec.maxTileSqMi} mi2, coverage ${plan.coversAoi ? 'complete' : 'INCOMPLETE'}\n` +
    `submissions   ${plan.totalUnits} total, ${plan.alreadyPaidFor} already paid for, ${plan.newSubmissions} new\n` +
    `budget        ${budget} new submission(s) authorised\n` +
    `checkpoint    ${plan.checkpointPath}\n` +
    `capability    ${plan.capabilityFingerprint.slice(0, 16)}... ` +
    `${gate.realProductPermitted ? '(confirmed)' : `(NOT confirmed - ${gate.missing.join(', ')})`}\n` +
    '\nrequest plan (local hour -> transmitted):\n',
)
for (const entry of plan.timestamps) {
  process.stdout.write(
    `  ${entry.requestedLocalTime} ${entry.requestedLocalIso}` +
      `  ->  start_date=${entry.transmittedDate} start_time=${entry.transmittedTime}` +
      `  (${entry.transmittedIsoUtc})\n`,
  )
}

if (plan.unresolvedUnits.length > 0) {
  process.stderr.write(
    `\n${plan.unresolvedUnits.length} unit(s) have a recorded submission intent and no activity id:\n` +
      plan.unresolvedUnits.map((unit) => `  ${unit.key}\n`).join('') +
      '\nFortyGuard may be running work this checkpoint cannot name. Reconcile against the account\n' +
      'before anything else is submitted. Nothing will be resubmitted automatically.\n',
  )
  process.exit(6)
}

if (!gate.realProductPermitted) {
  process.stdout.write(
    '\nNote: a capture would still run, but until the probe confirms the value field, that the\n' +
      'field holds a temperature, the unit as literal degrees Celsius, and an applied timezone\n' +
      'strategy, the resulting snapshot records unitConfirmed=false and the product will not\n' +
      'express metric A in degrees.\n',
  )
}

/* -------------------------------------------------------------------------- */
/* Three independent opt-ins, or nothing is submitted                          */
/* -------------------------------------------------------------------------- */

/*
 * `--dry-run` is terminal, and it is checked FIRST.
 *
 * It used to be parsed and then ignored, on the reasoning that a dry run is what
 * happens anyway unless every opt-in is present. That reasoning is exactly
 * backwards for a flag whose entire purpose is to prevent spending: the case that
 * matters is the one where the opt-ins ARE present — a command recalled from
 * shell history, or a real capture line with `--dry-run` appended to check it
 * first — and there the flag did nothing at all and the run spent money.
 *
 * A flag that means "do not spend" must win against every flag that means "spend".
 */
if (args.dryRun) {
  process.stdout.write(
    '\n--dry-run: nothing was submitted and no network request was made.\n' +
      'Remove --dry-run to execute the plan above.\n',
  )
  process.exit(0)
}

const blockers = []
if (!hasKey) blockers.push('FORTYGUARD_API_KEY is not set')
if (!envOptIn) blockers.push('RUN_LIVE_FORTYGUARD is not 1')
if (!args.confirmSpend) blockers.push('--confirm-spend was not passed')
if (!(Number.isInteger(budget) && budget > 0)) {
  blockers.push('--max-new-submissions was not a positive integer')
}

if (blockers.length > 0) {
  process.stdout.write(
    `\nDRY RUN - nothing was submitted and no network request was made.\n` +
      'Reaching a POST needs all three opt-ins; missing:\n' +
      blockers.map((blocker) => `  - ${blocker}\n`).join(''),
  )
  process.exit(0)
}

if (plan.newSubmissions > budget) {
  process.stderr.write(
    `\nRefusing to start: the plan needs ${plan.newSubmissions} new submission(s) and the budget\n` +
      `is ${budget}. Nothing was submitted.\n`,
  )
  process.exit(7)
}

const existingCheckpoint = plan.alreadyPaidFor > 0 || plan.newSubmissions < plan.totalUnits
if (existingCheckpoint && !args.resume) {
  process.stderr.write(
    `\nA checkpoint already exists at ${checkpointPath(spec)} with ${plan.alreadyPaidFor} paid\n` +
      'submission(s). Re-run with --resume to continue it, or delete it deliberately to start over.\n',
  )
  process.exit(4)
}

/* -------------------------------------------------------------------------- */
/* Capture — the lock is taken inside runCapture, before any network call      */
/* -------------------------------------------------------------------------- */

try {
  const client = new FortyGuardClient({
    apiKey: process.env.FORTYGUARD_API_KEY,
    baseUrl: process.env.FORTYGUARD_API_BASE_URL,
    // The request may only go to the host the capability manifest attests to.
    // Otherwise the snapshot would record that manifest's identity for numbers
    // produced somewhere else.
    attestedHost: capability.endpoint.host,
    authHeader: process.env.FORTYGUARD_AUTH_HEADER,
    maxConcurrency: Number(process.env.FORTYGUARD_MAX_CONCURRENCY ?? 2),
    pollTimeoutMs: Number(process.env.FORTYGUARD_POLL_TIMEOUT_SECONDS ?? 600) * 1000,
    resultHostAllowlist: (process.env.FORTYGUARD_RESULT_HOST_ALLOWLIST ?? 'api.fortyguard.com')
      .split(',')
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  })

  const result = await runCapture({
    aoi,
    spec,
    client,
    maxNewSubmissions: budget,
    log: (message) => process.stdout.write(`  ${message}\n`),
  })

  process.stdout.write(
    `\nwrote         ${result.write.path}${result.write.alreadyPresent ? ' (identical, unchanged)' : ''}\n` +
      `cells         ${result.cells}\n` +
      `surface       ${result.surfaceSha256}\n` +
      `attestation   ${result.attestationSha256}\n` +
      `activities    ${result.activityIds.length} (${result.submittedUnits} new, ${result.resumedUnits} resumed)\n\n` +
      'Review the file, run `npm run check:snapshots`, then commit it. Runs serve it with\n' +
      'DATA_MODE=cached_real and make no further API calls.\n',
  )
} catch (error) {
  if (error instanceof CaptureReconciliationError) {
    process.stderr.write(`\nSTOPPED FOR MANUAL RECONCILIATION\n\n${error.message}\n`)
    process.exit(6)
  }
  if (error instanceof CaptureBudgetError) {
    process.stderr.write(`\n${error.message}\n`)
    process.exit(7)
  }
  if (error instanceof CaptureLockedError) {
    process.stderr.write(`\n${error.message}\n`)
    process.exit(5)
  }
  throw error
}
