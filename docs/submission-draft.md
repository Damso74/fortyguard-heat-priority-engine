# Hackathon submission draft

FortyGuard Hackathon ’26 · Resilient Cities & Infrastructure · Agentic AI ·
Data Analysis & Correlation

> **Draft. Not submitted.** No submission form has been filed. The official
> collaborator `Hackathon-FG` (`hackathon@fortyguard.com`) has accepted read
> access; GitHub reconfirmed role `read` with no pending invite on 2026-08-24.
> The final demo video is uploaded non-listed at <https://youtu.be/GW-F8puuu5I>.
> Status per requirement:
> [`hackathon-compliance.md` §6](hackathon-compliance.md). Actions still to take:
> [`submission-checklist.md`](submission-checklist.md).
>
> **Licensing gate resolved by removal:** the two raw extracts without
> redistribution terms are excluded from the tracked repository
> ([`data-provenance.md` §8](data-provenance.md)).

## Heat Priority Engine

**Tagline:** turn hyperlocal heat, transit demand and scheduled waiting into a
reviewable inspection queue — without inventing a weighted score or a hotspot.

## Result

The default run is a real, immutable FortyGuard pilot:

- 450 `tcm` cells from three completed activities;
- Downtown Phoenix, 2024-07-15 at 08:00, 14:00 and 20:00;
- 27 transit stops covered at all three hours — the returned footprint, and
  nothing outside it;
- capacity 10;
- **3 robust priorities + 7 assumption-dependent candidates** across 324 scenarios;
- product mode **`EXPOSURE_ONLY`**.

The pilot is a **27-stop Downtown footprint**, not Central Phoenix and not the
city. Any request outside it falls back to a permanently labelled synthetic
fixture, whose rankings demonstrate the method and are not findings about
Phoenix.

That last line is the product thesis. The real surface is hot but spatially
uniform, and its local anomaly does not persist on held-out hours. The engine
therefore uses confirmed absolute heat to condition the transit-burden axis and
removes anomaly from the ranking. It does not manufacture hotspots to make the
demo look more dramatic.

## Problem

Phoenix has 4,288 active transit stops. A team with limited inspection capacity
needs to decide where to look first before extreme heat, but the obvious “shade
these stops” product cannot be supported by the public inventory: Phoenix reports
3,164 sheltered stops while the accessible amenity fields contain only 20 usable
values in one layer and zero positives in another.

The commercial problem is therefore operational triage under incomplete evidence:
where do riders accumulate the largest modelled heat burden, how sensitive is the
answer to unknown assumptions, and what is the data still unable to justify?

## Solution

Heat Priority Engine joins:

1. FortyGuard temperature tiles;
2. Valley Metro quarterly average ridership;
3. official GTFS departure times, separated by weekday, Saturday and Sunday.

For each stop it models:

```text
scenario exposure load = Σ riders(h) × expected wait(h) × max(0, T(h) − 30 °C)
```

This is an estimated planning quantity, never a measured rider dose. Nobody
counted riders by hour, scheduled waits are not observed waits, and 30 °C is
FortyGuard’s analytics default rather than a health threshold.

The second possible axis is a robust local anomaly: leave-one-out median/MAD
within 1 km, validated on held-out hours. The pilot fails persistence, so that
axis is excluded. When both axes are valid they remain separate and use Pareto
layering; there is no weight slider or hidden exchange rate between riders and
degrees.

The result is delivered through a complete operations loop, not a standalone
map:

1. **Heat monitor** exposes the exact stored hours, footprint, field, unit and
   provenance boundary.
2. **Priority planner** builds the capacity-constrained, stress-tested queue.
3. **Inspection missions** converts selected stops into field-ready tasks.
4. **Field capture** records shade, shelter, accessibility, confidence and a
   note in a clearly labelled session demo.
5. **Evidence review** requires a human accept, reject or reinspection decision;
   accepted evidence creates plan version 2 but does not silently alter the
   thermal score.
6. **Scenario lab** compares the engine with ridership-only, temperature-only,
   scheduled-wait-only and deterministic-random baselines.
7. **Reports & audit** exports the decision brief, CSV and JSON evidence package.

That is the commercial wedge: a transit operator, resilience team or consulting
partner can move from environmental evidence to a governed field programme
without buying a full digital twin or asking staff to enter their calendars.

## Why it is credible

- missing values remain missing, never zero;
- every source has provenance and a hash;
- every real snapshot has a surface digest and a broader attestation digest;
- capability answers for field, semantics, unit and timezone are fingerprinted;
- lookup matches AOI, date, hours, analytic, granularity, filter and timezone;
- ambiguous or invalid snapshots fail closed;
- 324 scenario combinations re-run selection and expose frequency plus rank range;
- exports are frozen from a named self-attestation bound to the reviewed audit;
- a code-enforced claim registry blocks people protected, degrees reduced, cost,
  unsheltered status, causality and government endorsement.

## FortyGuard integration

The deployment cannot spend a credit. Capture is a local CLI with three separate
opt-ins and an explicit submission budget, durable checkpointing, resume by
activity id, a lock against duplicate operators, bounded polling and no POST
retry. The production app only reads committed snapshots.

The three already-paid Phoenix envelopes are imported by a network-free script
that verifies their request parameters, status, activity ids, 150-cell response,
returned footprint and raw SHA-256 before writing through the production store.

The probe confirmed `average_temperature`, modelled temperature semantics and
literal `°C`. The API omits timezone metadata; a three-hour Phoenix baseline
comparison supports AOI-local wall clock over UTC by a 3.28× RMSE ratio. This is
labelled empirical confirmation, not a vendor-contract claim.

## Limitations

- The real pilot covers 27 Downtown stops, not Central or Full Phoenix.
- The thermal date and ridership quarter are 2024; the GTFS schedule is 2026.
- Ridership is a quarterly daily average distributed through unobserved hourly
  profiles; it may include alightings.
- Timetables omit cancellations, bunching and real-time deviation.
- Shelter status is unknown for every stop.
- The local anomaly is not persistent and takes no part in the pilot ranking.
- Two recent-date API activities returned `Completed` with zero cells and were
  charged; empty results are rejected and never committed.
- The two raw extracts without established redistribution permission are not
  tracked. The two retained Valley Metro bus-stop items are explicitly licensed,
  and GTFS is ODC-BY.
- An export is frozen from a run held in memory by the instance that computed it.
  If a platform routes the export elsewhere it returns `409` and asks for a
  re-run; it never regenerates the numbers.

## Architecture

Next.js App Router · strict TypeScript · React · Tailwind · MapLibre · Zod ·
Vitest · Playwright · Python data pipeline · Vercel.

```text
official transit layers → paginated fetch + hashes → joined stop dataset
local FortyGuard capture/import → immutable reviewed snapshot
snapshot + stops + GTFS → quality gates → evidence-based product mode
324 scenario selections → missions → field evidence → human review
→ versioned decision package → CSV / JSON
```

## Verification

`npm run verify` runs lint, strict type checking, unit/integration tests, snapshot
store audit, production build, asset checks, hashes of distributed data,
exclusion checks for the two removed raw extracts, canonical GTFS rebuild,
secret scan, dependency audit and the Playwright production suite. The
regenerated verification report carries the current counts.

## Links

- Repository: <https://github.com/Damso74/fortyguard-heat-priority-engine>
- Demo: <https://heat-priority-engine.vercel.app>
- Methodology: `/methodology` in the demo
- Demo video: <https://youtu.be/GW-F8puuu5I> — 2:32, non-listed, active English
  captions, owner's ElevenLabs voice clone, synchronized navigation and guided
  cursor. The source MP4 remains ignored locally.
- What is real and what is fixture: [`findings-provenance.md`](findings-provenance.md)

Both links are recorded as live; confirm each one in a browser on the day, from a
logged-out session, before the form is filed.

## Field-by-field form answers

These answers match the Google Form re-verified on 2026-08-24. Bracketed values
must be supplied only at submission time and must never be committed.

| Form field | Answer to use |
|---|---|
| Participant type | Solo |
| Full name | Damien Credoz |
| Registered email | `[enter the registered email in the form only]` |
| Project title | Heat Priority Engine |
| One-line pitch | FortyGuard turns hyperlocal heat, transit demand and scheduled waiting into a reviewable Phoenix inspection queue. |
| Primary track | Track 1 — Resilient Cities & Infrastructure |
| Secondary tracks | Track 6 — Agentic AI; Track 7 — Data Analysis & Correlation |
| Who this is for | Transit operators, municipal resilience teams and their delivery partners. It changes which stops they inspect first when field capacity is limited, while exposing when the available evidence cannot justify a stronger intervention claim. |
| Where and when | Downtown Phoenix. FortyGuard temperature: 15 July 2024 at 08:00, 14:00 and 20:00 local analysis time; ridership: FY2024 Q4; scheduled service: July 2026. The temporal mismatch is disclosed and stress-tested, not hidden. |
| FortyGuard API usage | Three completed FortyGuard Temperature API activities provide 450 `tcm` cells for `average_temperature` across three hours. The app verifies and stores those immutable responses, joins stops inside the returned footprint, validates anomaly persistence and then builds an auditable capacity-constrained inspection queue. |
| FortyGuard API key | `[enter directly in the form; never paste into this file, the repository or browser-visible app code]` |
| AI tools | OpenAI Codex/ChatGPT supported repository inspection, implementation, test design, adversarial review and documentation under human direction and review. ElevenLabs generated the final English narration from the owner's authorised voice clone. All product calculations are deterministic code covered by tests; AI does not invent or alter the reported heat, ridership or ranking values. |
| Repository | https://github.com/Damso74/fortyguard-heat-priority-engine |
| Collaborator confirmation | `Hackathon-FG has accepted read permission; GitHub role read verified 2026-08-24` |
| Live demo | https://heat-priority-engine.vercel.app |
| Demo video | https://youtu.be/GW-F8puuu5I |
| Optional note | The real pilot deliberately enters `EXPOSURE_ONLY` mode because its local anomaly fails held-out-hour persistence. Rather than manufacture a hotspot, the engine ranks estimated exposure alone and keeps unsupported claims blocked in the audit export. |

### Project description — form-sized version

Heat Priority Engine turns FortyGuard temperature evidence into a governed
transit inspection programme. It combines three immutable FortyGuard captures
with official quarterly stop ridership and scheduled service, models estimated
heat exposure under 324 assumption scenarios, and selects a capacity-limited
queue. Operators can issue inspection missions, record field evidence, require
human review and export a frozen audit package. The real Downtown Phoenix pilot
covers 27 stops and correctly falls back to `EXPOSURE_ONLY`: its absolute heat
evidence is valid, but its local anomaly does not persist on held-out hours. The
product therefore refuses to invent hotspots or claim measured rider dose,
causality, shelter status, health outcomes or government endorsement.

### Declarations requiring final human confirmation

- The owner retains the organiser's 2026-08-03 written permission for
  pre-sprint building and personally decides how to attest the form's
  repo-created-after-kickoff checkbox.
- Re-run `npm run verify` on the exact submitted commit before confirming that no
  key is committed or browser-visible.
- Confirm original work, registration and acceptance of the Terms & Conditions
  personally; the README separately discloses the small pre-existing pieces.
