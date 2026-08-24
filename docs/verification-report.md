# Verification report

Generated: 2026-08-24T09:24:01.290Z
Command: `npm run verify`
Node: v24.19.0 · Platform: win32

| Step | Result | Ran | Duration |
|---|---|---|---:|
| ESLint | PASS | — | 18.0s |
| TypeScript | PASS | — | 15.9s |
| Distributed data hashes and exclusions | PASS | — | 0.4s |
| Vitest (unit + integration) | PASS | 378 tests in 22 files | 30.0s |
| Thermal snapshot store | PASS | — | 0.7s |
| Next production build | PASS | — | 28.0s |
| Generated runtime assets (MapLibre worker) | PASS | — | 0.1s |
| GTFS archive and derived hashes | PASS | — | 0.4s |
| GTFS rebuild reproduces the canonical hash | PASS | — | 3.5s |
| Secret scan | PASS | — | 0.1s |
| Dependency audit (high severity) | PASS | — | 1.8s |
| Playwright end-to-end | PASS | 32 tests | 59.8s |

**Overall: PASS**

## What each step proves

- **ESLint / TypeScript** — no unused code, no `any`, no `console.log` on shipped paths, strict types throughout.
- **Vitest** — baseline metric regression, normalisation, scoring, capacity selection, sensitivity, tiling, zones, state machine, audit redaction, CSV injection, and the full FortyGuard client contract against typed fixtures.
- **Thermal snapshot store** — every committed snapshot is a valid real capture under the current capability fingerprint, and no two answer the same request.
- **Next production build** — the deployed artefact compiles.
- **Generated runtime assets** — the MapLibre worker exists under public/ and matches node_modules, so a build that skipped `prebuild` cannot ship a map that renders tiles and carries no data.
- **Distributed data hashes and exclusions** — retained licensed raw layers and the generated application dataset match their manifests; the two unresolved raw extracts are absent from Git.
- **GTFS rebuild** — the timetable-derived artefact reproduces canonically from the committed ODC-BY archive.
- **Secret scan** — no credential patterns in the tree, no server secret name in a browser asset.
- **Playwright** — the whole demo journey against a production build, including the map-failure and no-key paths.

No step was skipped, softened or excluded to produce this result.

The **Ran** column is read from each runner's own summary rather than written by hand. Every test count in this repository that was typed into prose had gone stale by the time it was read, so no document quotes one any more.
