# Demo script — 3 minutes

> **Status: the 2026-08-23 candidate remains available, but the jury-focused UI
> deployed on 2026-08-26 requires a fresh recording before form submission.**
> `outputs/submission-video/fortyguard-demo-jury-final.mp4` is an ignored local
> artefact: H.264/AAC, 1440×810 (16:9), 2:32.88, with the owner's ElevenLabs
> voice clone, guided cursor and embedded English subtitles. Audio measures
> -17.9 LUFS integrated / -1.8 dBTP. Representative frames confirm the K=10
> scenario comparison and `Submission licensing: Ready`. YouTube serves the
> 2:32 video with active English captions and reports no copyright issue. Its
> visible licensing-ready state matches the clean replacement repository:
> <https://youtu.be/GW-F8puuu5I>. End-to-end listening approval remains a human
> review item.
> Tracking remains in
> [`submission-checklist.md`](submission-checklist.md).

**Setup:** production build at 1440×810 or larger. Open `/`, wait for the verified
pilot, and reset the demo workspace if a previous rehearsal left an observation.
The deployment is keyless and cannot spend a FortyGuard credit.

**Every figure spoken below is bound by the claim table in
[`hackathon-compliance.md` §6](hackathon-compliance.md).** In one line: a real
450-cell, three-activity Downtown pilot over 27 stops; `EXPOSURE_ONLY`; 3 robust
and 7 conditional at capacity 10; no hotspot, no city-wide claim, no measured
dose. If a take drifts from that, the take is wrong, not the table.

## 0:00–0:25 — Name the user, decision and operating value

> “When extreme heat hits Phoenix, a transit team does not need another map. It
> needs to know which stops to inspect first, with limited staff, and why that
> choice can be defended. That is why I built Heat Priority Engine. For transit
> operators and urban resilience teams, that replaces ad-hoc site visits with a
> repeatable, reviewable workflow.”

Point to **Real FortyGuard pilot**, **3 robust priorities**, **7 conditional
candidates**, and the next operational action.

## 0:25–0:58 — Prove that FortyGuard is central and bounded

Open **Heat monitor** and switch between 08:00, 14:00 and 20:00.

> “This pilot starts with real FortyGuard evidence: 450 stored temperature cells
> from three completed activities, at 8 a.m., 2 p.m., and 8 p.m., covering 27
> Downtown stops. The monitor shows exactly what the API returned. Every result
> preserves its source time, units, footprint, and evidence digest. Because the
> local anomaly did not persist, the product refuses to label a hotspot. Trust
> begins with knowing what the evidence does not prove.”

## 0:58–1:38 — Turn the evidence into a defensible queue

Open **Priority planner** and point to the ranked queue, its scenario split and
the explicit selected filter.

> “Heat Priority Engine combines that thermal evidence with transit demand and
> scheduled waiting, then turns it into ten reviewable inspection missions.
> Three remain selected across all 324 scenarios. Seven depend on assumptions.
> A small field team can act first on the priorities that survive uncertainty.
> In the planner, every stop explains its position through riders, waiting,
> heat, selection frequency, and rank range. Exposure and anomaly stay separate.
> There is no hidden weight slider and no convenient black-box answer.”

## 1:38–2:01 — Complete the human-controlled operational loop

Open **Inspection missions**, assign the first robust mission, then open it.
Choose a shade status, shelter and accessibility result, add a short note, set
confidence, and submit.

> “Then the plan becomes work. An operator opens a mission and records what the
> datasets cannot know: shade, shelter, accessibility, confidence, and field
> notes. Nothing changes silently. Only after a human reviewer accepts that
> evidence does the plan advance to version two.”

Open **Evidence review** and accept the observation while this line is spoken.

## 2:01–2:12 — Compare against legible alternatives

Open **Scenario lab**, compare K = 10, 20 and 50, and point to Coverage@K versus
the ridership-only, temperature-only, scheduled-wait-only and deterministic
random baselines.

> “The scenario lab compares the governed plan with simple alternatives. If
> ridership alone, temperature alone, or scheduled waiting performs better, the
> product says so.”

**Final-take direction:** stay on **K = 10**. Point first to **Difference vs best
baseline** (-1.8 pts), then to **Heat contribution** (2). Do not finish on K =
20 or 50, where every eligible stop is selected and all methods converge to
100%; that is correct but visually uninformative.

## 2:12–2:25 — Expose the method and hand over an auditable decision

Open **Data & methodology** and move down the evidence gates. Unsupported claims
are disabled in the product rather than hidden in narration. Then open
**Reports & audit** and point to run id, digest, plan version and claim boundary.

> “Finally, the decision exports with its run identity, evidence digest,
> assumptions, limitations, and review state. Unsupported claims remain visible
> instead of being polished away.”

## 2:25–2:33 — Close on the product category

> “Heat Priority Engine is not another heat dashboard. It is the operating layer
> between FortyGuard intelligence and the next defensible field action:
> understand, prioritize, inspect, validate, and prove.”

## Rehearsal checklist

- Every module loads from the left navigation with no dead end.
- The visible cursor leads attention and every click produces a short halo.
- The top context bar always shows place, date, hours, timezone, units and mode.
- One mission can be submitted and accepted in under 35 seconds.
- Downloads produce non-empty CSV and JSON files.
- No API key, official seal, flag, partner logo or unsupported ROI claim appears.
- Export the plan in the same browser session that produced it. An export is
  frozen from the stored run; a `409` on camera means the run was not held, and
  the fix is to re-run and re-export, not to explain it away.
- Nothing on screen says Central Phoenix or Full Phoenix while the pilot data is
  being described.

## Before recording

- [x] Resolve the repository-wide raw-file licensing `NO-GO`: the original
      repository is private and the public submission repository starts from a
      clean root without the unresolved extracts or inherited PR refs.
- [x] Capture the deployed production build, not `npm run dev`.
- [x] Confirm the run on screen is `CACHED REAL DATA`, not the fixture.
- [x] Check the recording is ≤ 3:00 — measured duration: 2:32.88.
- [x] Keep the file local until the submission form asks for it; the output path
      is ignored by Git.
- [ ] Owner watches the full video with sound and approves the natural neural
      narration or records a replacement voice track.
- [x] Accessible assembly pipeline verified locally: deterministic VTT sidecar,
      embedded English subtitle stream, two-pass loudness normalisation and
      higher-fidelity H.264 output.
- [x] Re-record the final walkthrough at 1440×810 with the resolved licensing
      state, keeping Scenario Lab on K=10. Save the approved ElevenLabs track
      as `outputs/submission-video/narration-jury-final.mp3`, then run
      `npm run submission:captions`, `npm run submission:record` and
      `npm run submission:assemble` in that order.
