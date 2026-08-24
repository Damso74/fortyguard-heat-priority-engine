# Final submission evidence

Last full local verification: **24 August 2026**. Production browser review:
**24 August 2026**.

## Public artefacts

| Artefact | Evidence |
|---|---|
| Repository | <https://github.com/Damso74/fortyguard-heat-priority-engine> — public, default branch `main` |
| Verified product commit | [`fef54677179ed67646896a4d4effb77e95b25304`](https://github.com/Damso74/fortyguard-heat-priority-engine/commit/fef54677179ed67646896a4d4effb77e95b25304) |
| GitHub CI | [Run 32656317089](https://github.com/Damso74/fortyguard-heat-priority-engine/actions/runs/32656317089) — success on the verified product commit |
| Production | <https://heat-priority-engine.vercel.app> |
| Vercel deployment | `dpl_He6uG9MqptbDVhVwXQnX5iPsu3CG` — `READY`, production |
| Demo video | <https://youtu.be/GW-F8puuu5I> — 152.921 seconds, captions available |
| Official rules | <https://www.fortyguard.com/hackathon26> |
| Submission form | <https://docs.google.com/forms/d/e/1FAIpQLSdheKfejq4uAk5dNluoaH6yBAL9N78-E1H8c_8FSnSMZKGlqQ/viewform> |

The submission-package changes after `fef5467` are documentation-only and are
not required to redeploy the already verified product. The exact local seal
commit is obtained with `git rev-parse HEAD` and is recorded in the handoff
report before any push.

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

- Desktop: meaningful content rendered, correct title/description/OG image, no
  Next.js error overlay and no console warning/error.
- Main journey: overview → heat → planner → mission → demo observation → human
  acceptance reached `Plan v2`.
- Mobile: 412×915 viewport rendered the same thesis and actions with no
  horizontal overflow or error overlay.
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

- Human approval of the final narration is not automatable.
- The Google Form has not been submitted.
- The code has no separate open-source licence; dataset licences are explicit.
- Production run/export continuity remains instance-local and fails closed.
