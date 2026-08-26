# Final submission evidence

Last full local verification: **26 August 2026**. Production browser review:
**26 August 2026**.

## Public artefacts

| Artefact | Evidence |
|---|---|
| Repository | <https://github.com/Damso74/fortyguard-heat-priority-engine> — public, default branch `main` |
| Verified product commit | [`e6240dbf134fb98d7a02df75e5ef62b1957add45`](https://github.com/Damso74/fortyguard-heat-priority-engine/commit/e6240dbf134fb98d7a02df75e5ef62b1957add45) |
| Verification | `npm run verify` passed locally on the verified product commit: 382 Vitest tests and 44 Playwright tests, plus build, hashes, GTFS rebuild, secret scan and audit |
| Production | <https://heat-priority-engine.vercel.app> |
| Vercel deployment | `dpl_BGtEM9GUGfUErhWj3WRArxMhA6ji` — `READY`, production, exact source commit `e6240dbf` |
| Demo video | <https://youtu.be/LPq0Tn6YX9w> — non-listed final, 1:25, English captions, no copyright issue reported |
| Official rules | <https://www.fortyguard.com/hackathon26> |
| Submission form | <https://docs.google.com/forms/d/e/1FAIpQLSdheKfejq4uAk5dNluoaH6yBAL9N78-E1H8c_8FSnSMZKGlqQ/viewform> |

The product commit above is the exact source state deployed and reviewed. This
documentation-only evidence seal follows it without changing the runtime.

## Technical verification

`npm ci` completed reproducibly with zero reported vulnerabilities. The release
gate is `npm run verify`; its generated, current result is
[`../verification-report.md`](../verification-report.md). It covers:

- ESLint and strict TypeScript;
- distributed-data hashes and exclusions;
- unit and integration tests;
- thermal snapshot validation;
- Next.js production build and MapLibre assets;
- GTFS archive checks and canonical rebuild;
- secret scan and high-severity dependency audit;
- Playwright end-to-end tests against a production build.

## Production browser evidence

- Desktop: the historical pilot and `10 inspection candidates · 3 robust`
  conclusion rendered with no console error or horizontal overflow.
- Main journey: overview → heat → planner → mission → demo observation → human
  acceptance reached `Plan v2`.
- Mobile: 412×915 rendered the full-width planner map, the stronger Heat Monitor
  overlay, dual °C/°F values and the honest empty-review state with no horizontal
  overflow or error overlay.
- Public status API: configured and live-spend flags remain off; the deployment
  reads the stored real pilot.

## Data provenance and truth boundary

- Real default pilot: 450 cells, three completed FortyGuard activities, 27
  Downtown Phoenix stops, `EXPOSURE_ONLY`.
- Transit inputs: Valley Metro quarterly ridership and scheduled GTFS service.
- The complete public history excludes the two unresolved raw extracts and the
  unnecessary OpenAPI download; `git rev-list --objects --all` is the history
  check.
- Source URLs, retrieval metadata, hashes, licences and temporal limitations are
  in [`../data-provenance.md`](../data-provenance.md).
- Allowed and blocked claims are in
  [`../limitations-and-claims.md`](../limitations-and-claims.md).

## Judging evidence

| Criterion | Evidence |
|---|---|
| Impact & relevance — 40% | A constrained Phoenix transit team receives an actionable inspection order rather than a passive heat map. |
| Technical execution — 35% | Typed deterministic engine, validated immutable snapshot, canonical data rebuild, quality gates, frozen exports, CI and E2E evidence. |
| Innovation — 15% | Weight-free two-axis reasoning, uncertainty-based robustness and a human-governed field loop. |
| Communication — 10% | Three-minute video, concise summaries, visible provenance and explicit blocked claims. |

## Remaining limitations

- The code has no separate open-source licence; dataset licences are explicit.
- Production run/export continuity remains instance-local and fails closed.
