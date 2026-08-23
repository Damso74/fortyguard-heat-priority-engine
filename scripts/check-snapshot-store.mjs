#!/usr/bin/env node
/**
 * Fail the build on anything invalid in the production thermal snapshot store.
 *
 * The store is `data/generated/thermal-snapshots/` and it holds **real captures
 * only**. This check exists because a fabricated one was committed and survived
 * review: a `LIVE_FORTYGUARD` / `REAL` file with `act-1` for an activity id, a
 * confirmed `°C` unit the capability manifest does not support, and zero cells.
 * Nothing at the time would have gone red.
 *
 * Every file must now parse, validate structurally (both digests recomputed), and
 * satisfy every real-capture rule against the **current** capability manifest —
 * including the capability fingerprint, so a capture read under one set of
 * answers cannot survive a change to those answers by being relabelled.
 *
 * Runs under `tsx` so it can import the same modules the application does. There
 * is deliberately no second implementation of these rules.
 *
 * Nothing here touches the network.
 */

const { auditSnapshotStore, snapshotDir, snapshotFiles } = await import(
  '../lib/fortyguard/snapshot-store.ts'
)
const { capabilityFingerprint, evaluateCapability } = await import(
  '../lib/fortyguard/capability.ts'
)

const fingerprint = capabilityFingerprint()
const gate = evaluateCapability()
const files = snapshotFiles()

process.stdout.write(
  `snapshot store   ${snapshotDir()}\n` +
    `files            ${files.length}\n` +
    `capability       ${fingerprint.slice(0, 16)}… (${gate.realProductPermitted ? 'confirmed' : `NOT confirmed — ${gate.missing.join(', ')}`})\n`,
)

const problems = auditSnapshotStore({ capabilityFingerprint: fingerprint })

if (problems.length > 0) {
  process.stderr.write(`\nsnapshot store check FAILED — ${problems.length} invalid file(s)\n\n`)
  for (const problem of problems) {
    process.stderr.write(`  ${problem.path}\n`)
    for (const reason of problem.reasons) process.stderr.write(`    - ${reason}\n`)
  }
  process.stderr.write(
    '\nThe production store holds real captures only. Synthetic layers are generated on demand\n' +
      'by lib/fortyguard/demo-fixture.ts; invalid examples worth keeping belong under\n' +
      'tests/fixtures/thermal-snapshots/, which nothing at runtime reads.\n',
  )
  process.exit(1)
}

process.stdout.write(
  files.length === 0
    ? '\nsnapshot store: empty. No real FortyGuard capture has been committed, so every run serves\n' +
        'the labelled synthetic fixture and says so.\n'
    : '\nsnapshot store: every committed file is a valid real capture under the current capability.\n',
)
