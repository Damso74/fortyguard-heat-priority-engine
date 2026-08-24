# Three-minute demo script

Target runtime: **2:33**. Production URL:
<https://heat-priority-engine.vercel.app>. Keep the default Downtown pilot and
capacity 10. Do not improvise a hotspot, city-wide result or shelter claim.

| Time | On screen / clicks | Narration | Evidence to show |
|---|---|---|---|
| 0:00–0:20 | Open **Overview**. Point to the real-pilot and exposure-only badges. | “Phoenix transit teams do not need another heat map. They need to know which stops to inspect first, with limited staff, and why that choice can be defended.” | Real FortyGuard pilot; 3 robust + 7 conditional at capacity 10. |
| 0:20–0:45 | Click **Explore heat evidence**. Switch 08:00, 14:00 and 20:00. | “The pilot starts with three stored FortyGuard activities: 450 real temperature cells covering 27 Downtown stops. The product preserves time, units, footprint and evidence digest.” | `CACHED REAL DATA`; 450 cells; three hours; no live credit spend. |
| 0:45–1:20 | Click **Open priority plan**. Point to the queue and robustness split. | “Temperature is combined with transit demand and scheduled waiting. Three stops survive every tested assumption; seven depend on assumptions. Exposure and local anomaly remain separate—there is no hidden weighted score.” | Selection frequency, rank range, riders × wait × heat decomposition. |
| 1:20–1:55 | Click **Create inspection missions**, open the first mission, select a demo observation and submit. | “The plan becomes field work. An operator records what the source datasets cannot know. This observation is session-only and explicitly labelled as demo evidence.” | Mission identity, shade/shelter/accessibility fields, confidence. |
| 1:55–2:15 | Click **Review evidence**, then **Accept evidence**. | “Nothing changes silently. A human review is required before the plan advances to version two.” | `Plan v2` after acceptance. |
| 2:15–2:35 | Open **Scenario lab**, remain at K=10. | “The governed plan is compared with ridership-only, temperature-only, scheduled-wait-only and deterministic-random baselines.” | Difference versus best baseline and heat contribution. |
| 2:35–2:50 | Open **Data & methodology**, then **Reports & audit**. | “Every export carries its run identity, assumptions, digest, limitations and blocked claims.” | Run id, evidence digest, claim boundary, CSV/JSON actions. |
| 2:50–3:00 | Return to the overview or hold on the report. | “Heat Priority Engine is the operating layer between FortyGuard intelligence and the next defensible field action: understand, prioritize, inspect, validate and prove.” | Product name and live URL. |

## Recovery plan

- The production demo is snapshot-backed and needs no FortyGuard key. If a
  remote basemap fails, continue with the priority list and table views; the
  evidence and calculations remain available.
- If an export returns `409`, rerun the plan and export in the same browser
  session. Never claim the server regenerated the old run.
- If a previous rehearsal left `Plan v2`, use the demo reset control before the
  take or state that the accepted observation is session-local.
- If production becomes unavailable, use a verified `npm run build` followed by
  `npm start`; show the same committed snapshot and state clearly that the URL is
  local.

The already uploaded final video is <https://youtu.be/GW-F8puuu5I>; browser
inspection on 2026-08-24 measured 152.921 seconds and found the captions control.
The detailed narration and recording checklist remain in
[`../demo-script.md`](../demo-script.md).
