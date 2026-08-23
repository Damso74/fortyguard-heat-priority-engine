import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./', import.meta.url)),
    },
  },
  test: {
    // Node environment throughout: every unit and integration test here targets
    // pure logic. Browser behaviour is covered by the Playwright suite instead
    // of a simulated DOM, which keeps the assertions honest.
    environment: 'node',
    /*
     * One process per test file, not one thread.
     *
     * Several suites work in a temporary tree via `process.chdir` — the snapshot
     * store and the capture checkpoints are both resolved from `process.cwd()`,
     * deliberately, so a test can exercise them without touching the repository.
     * `process.cwd()` is per-PROCESS, so under the default worker-thread pool two
     * files running concurrently share it: one file's `chdir` silently relocates
     * the other's store mid-test. That produced a capture test failing about one
     * run in five, in a way that looked like a bug in the checkpoint logic.
     *
     * Forks cost a little startup time and remove the whole class of failure.
     */
    pool: 'forks',
    /*
     * The default 5 s is a hardware threshold, not an assertion.
     *
     * Several suites read a dozen source files or run the engine end to end.
     * Those take milliseconds on an idle machine and can take seconds on a busy
     * CI runner, and a suite that goes red because the runner was loaded teaches
     * people to re-run it rather than to read it. Nothing here is testing speed —
     * the payload work asserts BYTES, which are deterministic, and reports
     * timings without asserting them.
     */
    testTimeout: 30_000,
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    reporters: ['default'],
    globals: false,
  },
})
