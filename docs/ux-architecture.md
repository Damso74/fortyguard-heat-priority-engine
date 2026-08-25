# UX architecture

## Product model

FortyGuard is one decision workflow, not a collection of nine unrelated dashboards.

```text
Overview → Priority map → Missions → Audit
              │             │
              └─ Explore data: heat, transit use, field reviews,
                 stress test, methods and limits
```

The primary operational path is:

```text
Overview → Priority planner → Freeze plan → Missions → Field observation
         → Evidence review → Reports & audit
```

Heat and ridership explain the inputs. Scenario Lab challenges a draft or active plan. Methodology documents the claim boundary. These supporting routes sit behind `Explore data` so the primary navigation reads like a human task, not the internal architecture.

The overview first viewport contains one promise, one action, one map, one proof line and one concise limitation. Technical evidence remains available below the fold or in supporting routes.

## Shell contract

The shared shell owns:

- route matching, including descendant routes such as `/missions/[missionId]`;
- the four primary tasks used by mobile and desktop navigation;
- one secondary `Explore data` group;
- plan-version visibility only where a plan is actually consumed;
- a single `main` landmark and a stable skip-link target;
- a maximum content width for editorial pages and a workspace variant for the planner.

Every page owns one `h1`, one primary action, its loading/error/empty states and only the status information relevant to its own source. Human-facing labels use `stable` and `changes with assumptions`; methodological terms remain in expanded detail and exports.

## Interaction contract

- Primary and destructive actions have explicit visual variants and 44 px touch targets.
- Exclusive choices expose their selected state to assistive technology.
- A page visit never changes mission state by itself; state changes follow an explicit user action.
- Session reset requires confirmation.
- Maps use a viewport-relative height with a usable minimum, and their controls must not collide.
- Loading regions use `aria-busy`; errors preserve the last valid result where possible and offer retry.

## State architecture next step

The planner currently owns a local draft run while the operational pages consume the run from `OperationsProvider`. A production-grade handoff should replace this split with one workspace state:

```text
PlanWorkspace
  draftControls
  draftRun
  activePlan { planId, runId, revision, frozenAt }
  missionsByPlanId
  evidenceRevision
```

The planner CTA should freeze the exact visible run and create missions for that `planId`. Field observations should be append-only attempts. Reinspection should create a new attempt rather than reusing or hiding the previous observation. Plan revision and evidence revision should remain separate.

This state migration is intentionally documented rather than silently introduced by the visual refactor, because it changes product behavior and persistence semantics.
