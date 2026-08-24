# Heat Priority Engine — submission summary

## Very short description

Turn FortyGuard heat and Phoenix transit data into a defensible,
capacity-limited inspection queue.

## 100–150 word summary

Heat Priority Engine turns FortyGuard temperature evidence into a governed
transit inspection programme for Phoenix. It combines three immutable
FortyGuard captures with official quarterly stop ridership and scheduled GTFS
service, models estimated heat exposure under 324 assumption scenarios, and
builds a capacity-limited queue. Operators can inspect the evidence, issue field
missions, record observations, require human review and export a frozen audit
package. The real Downtown pilot covers 27 stops and deliberately resolves to
`EXPOSURE_ONLY`: absolute heat evidence is usable, but the local anomaly does not
persist on held-out hours. The product therefore refuses to invent hotspots,
measured rider dose, shelter status, causality or government endorsement. It
shows which priorities survive uncertainty and why a constrained team should
inspect them first.

## Long form description

### Problem and users

Transit operators, municipal resilience teams and delivery partners have
limited field capacity before extreme heat. Temperature maps show conditions,
but they do not decide which stops deserve scarce inspection time, how uncertain
that decision is, or which claims the available evidence cannot support.

### Solution and workflow

Heat Priority Engine combines real stored FortyGuard temperature cells,
official Valley Metro stop ridership and scheduled GTFS departures. It estimates
scenario exposure load as riders × expected waiting × heat above a disclosed
30 °C analytics baseline. A second, separate local-anomaly axis is enabled only
when held-out-hour validation supports it; the real pilot fails that persistence
test and correctly uses exposure alone.

The existing product provides one connected workflow:

1. inspect the exact stored heat surface and provenance;
2. create a capacity-constrained priority plan;
3. distinguish robust priorities from assumption-dependent candidates across
   324 scenarios;
4. turn selected stops into inspection missions;
5. capture explicitly demo-labelled field observations;
6. require human acceptance before the plan advances;
7. compare the result with simple baselines and export an auditable package.

### Data and result

The default pilot uses 450 real FortyGuard cells from three completed activities
at 08:00, 14:00 and 20:00 on 15 July 2024. The returned Downtown Phoenix
footprint covers 27 transit stops. At capacity 10 the plan contains 3 robust
priorities and 7 assumption-dependent candidates. It is not a city-wide result,
not a measured rider dose and not a claim that any stop lacks shelter.

### Differentiation and impact

The product is an operating and governance layer, not another heat dashboard.
It keeps exposure and anomaly separate, exposes rank sensitivity, blocks
unsupported claims in code and binds exports to the exact reviewed run. A small
team receives a defensible order for field work instead of a visually persuasive
but unreviewable score.

### Stack

Next.js 16 App Router, React 19, strict TypeScript, Tailwind CSS, MapLibre, Zod,
Vitest, Playwright, Python data tooling, GitHub Actions and Vercel.

### Honest limits

- Real thermal coverage is limited to 27 Downtown stops.
- Thermal and ridership evidence are from 2024; scheduled service is from 2026.
- Ridership-by-hour and waiting are modelled, not directly observed.
- Shelter status remains unknown.
- The deployed product reads immutable snapshots and cannot call FortyGuard or
  spend credits.
- Run/export continuity is instance-local; a cross-instance miss returns `409`
  and requires a fresh run.

### Next step

Submit the verified pilot as-is. Durable shared storage, authentication and
additional geographies are explicitly post-submission work, not part of this
seal.
