# Hackathon compliance — FortyGuard Hackathon '26

**Gate: `G0_COMPLIANCE` — PASS_WITH_LIMITATIONS**

This document records what the official sources actually say, where they contradict
each other or an earlier reading, which interpretation this project adopted, and
what must be disclosed at submission.

---

## 1. Sources consulted

| Source | URL | Retrieved | Notes |
|---|---|---|---|
| Official hackathon page | <https://www.fortyguard.com/hackathon26> | 2026-08-23 | Current embedded content re-read. The FAQ and newer submission/judging panels are not fully consistent; the union is recorded below. |
| Current submission form | <https://docs.google.com/forms/d/e/1FAIpQLSdheKfejq4uAk5dNluoaH6yBAL9N78-E1H8c_8FSnSMZKGlqQ/viewform> | 2026-08-23 | Six pages; latest resubmission before the deadline replaces earlier entries. The form requires repo, public demo, video ≤ 3 minutes, collaborator confirmation and personal declarations. |
| API documentation — Known Limitations | <https://docs-api.fortyguard.com/docs/limitations> | 2026-08-04 | Angular SPA; content read from the application bundle. Plan limits, input constraints, regional coverage, credits. |
| API documentation — Create Heatmap | <https://docs-api.fortyguard.com/docs/create-heatmap> | 2026-08-04 | Request/response shapes, `analytic_type` semantics, date range. |
| API documentation — Authentication / Quickstart | <https://docs-api.fortyguard.com/docs/authentication> | 2026-08-04 | `api-key` header, activity lifecycle, status code table. |
| OpenAPI document | Historical local input, removed from the current tracked tree 2026-08-23 | pre-existing, 2026-08-04 | No redistribution permission was established; the application does not require the downloaded file. |
| API health endpoint | <https://api.fortyguard.com/health> | 2026-08-04 | `{"status":"ok","version":"1.0.1-beta","mode":"PROD"}` — the API is live. |
| Press coverage | Entrepreneur Middle East, via web search | 2026-08-04 | **Contradicts the official page** — see §3. |

---

## 2. What the official page states

Read verbatim from <https://www.fortyguard.com/hackathon26> on 2026-08-04.

### Schedule

| Milestone | Date |
|---|---|
| Registration opens | July 20 |
| Build Sprint (2 weeks) | **Aug 18 – Aug 30, 2026** |
| Project Submission | **Aug 30, 2026** |
| Judging | Sept 1 – 15 |
| Winner announcement | Sept 16 |

FAQ, *General → When does it take place?*: **"18–30 August 2026 (GST / UTC+4)."**

### Submission requirements

FAQ, *Submission & Judging → How do I submit?*:

> "Submit three things: a public GitHub repo, a live website/demo link, and add
> fortyguard as a collaborator on your repo."

FAQ, *When is the deadline?*: **"30 August 2026 (GST) — no late submissions."**

The current page's newer *What To Submit* panel additionally lists a working
demo/prototype, repository, **2–5 minute** video, written summary and API-usage
documentation. The current form is stricter at **3 minutes maximum**, so the
submission follows the form and supplies the union of both lists.

### Judging criteria

> "Impact & Relevance (40%), Technical Execution (35%), Innovation (15%),
> Communication (10%)."

The newer judging panel instead labels the dimensions Innovation, Technical
Quality, Business Viability and Presentation without matching weights. The
submission is prepared for the union: evidence of impact/business value,
technical execution, innovation and concise presentation.

### Ownership

> "You do — you keep ownership and grant FortyGuard a license to showcase it."

### Eligibility and teams

- Open globally, fully online.
- Teams of **1–3 people**; solo entries welcome.
- **"FortyGuard's data covers U.S. locations, so build around U.S. geographies."**

### Data and datasets

FAQ, *Building Your Project → Can I combine FortyGuard data with other datasets?*:

> "Yes. Using FortyGuard's temperature data is essential and required — it must be
> central to your project. On top of that, you're free to bring in other datasets
> and sources, as long as you respect their licenses."

### Tracks

Seven: Resilient Cities & Infrastructure, Future Buildings & Energy, Industrial &
Enterprise, Government & Environment, Model Designing, Agentic (API + Agentic),
Data Analysis & Correlation.

### Prizes

$6,000 total — 1st $3,000, 2nd $2,000, 3rd $1,000. Free to enter.

---

## 3. Contradictions found, and how each was resolved

### 3.1 Event dates — press coverage vs official page

A widely-syndicated article states the hackathon **"runs from August 3–17, 2026"**
with **"Projects must be submitted by August 17, 2026."**

The official page, published 2026-08-03, states **August 18–30** with a **August 30
(GST)** deadline, and its own FAQ repeats both.

**Resolution: the official page wins.** It is first-party, more recent, and
internally consistent across three separate places (hero banner, schedule block,
FAQ). The press date is treated as an earlier announcement that was later revised.

**Consequence for planning:** the deadline is **30 August 2026, 23:59 GST (UTC+4)**
— that is 19:59 UTC, 21:59 Europe/Berlin and 12:59 America/Phoenix on the same
day. The owner-set working deadline is 26 August; the rules say *"no late
submissions."*

### 3.2 Historical data floor — 2019 vs 2021

- API documentation (*Create Heatmap*, *Known Limitations*): **"all date and time
  inputs must fall between `2019-01-01` and the present day."**
- Hackathon FAQ (*Platform & API*): **"Data runs from 1 January 2021 up to the
  present day."**

**Resolution: enforce the stricter bound, 2021-01-01.** Implemented as
`EARLIEST_ANALYSIS_DATE` in `lib/agent/request.ts` and enforced by the request
schema. This used to be probed by a Python script with its own POST
implementation; that script now has no network code at all, and the capture CLI
is the only thing that submits. The equivalent capture submits
2018-06-15, 2019-06-15 and 2021-06-15 to settle the question empirically once a
key exists.

### 3.3 Resolution — "10 mi²" vs "~20 m" vs "60/80/100 m"

- Hackathon hero block: **"10 mi² — Hyperlocal Resolution"**.
- Hackathon FAQ: **"~20-meter resolution, hour by hour."**
- API `granularity` enum and *Known Limitations*: **60 m, 80 m or 100 m**.

**Resolution:** the "10 mi²" figure is an *area ceiling* mislabelled as a
resolution — the *Known Limitations* plan table lists "Heatmap Generation (max
area): Up to 10 mi²" for API Basic and API Startup. The "~20 m" figure is not
reachable through any documented API parameter. **Only the API enum is treated as
contractual.** No product surface claims 20 m.

### 3.4 Area ceiling — 10 mi² vs 50 mi²

*Known Limitations* plan table:

| Capability | API Basic | API Premium | API Startup |
|---|---|---|---|
| Monthly credits | 1,000,000 | 5,000,000 | 1,000,000 |
| Heatmap Generation (max area) | **Up to 10 mi²** | **Up to 50 mi²** | **Up to 10 mi²** |
| Regional coverage | United States only | United States only | United States only |

**Resolution:** the plan a hackathon key carries is not documented, so the project
defaults to a **9 mi² ceiling per tile** — under the smallest documented limit,
with headroom for the equirectangular area approximation. Configurable via
`FORTYGUARD_MAX_TILE_SQ_MI`.

**This invalidates the spike's probe design**, which submitted a single ~34.9 mi²
polygon. That request is rejected on Basic and Startup plans. Fixed in
`scripts/fortyguard/run_fortyguard_probe.py`.

### 3.5 `filter_type` — 1–3 vs 1–4

- *Known Limitations*: **"`filter_type` must be 1 (Single Hour), 2 (Range of
  Hours), or 3 (Single Day)."**
- *Create Heatmap* endpoint page and the OpenAPI schema: **1–4**, where 4 is
  "Range of Days — week / month, ≤ 1 month".

**Resolution:** the main product path uses **`filter_type: 1` only**, which every
source agrees on. The Zod schema permits 1–4 so the probe can test 4, and the probe
records the answer.

### 3.6 Timezone of `start_time`

No source documents which timezone `start_time` is interpreted in. The one adjacent
clue is the *Create Heatmap* description of `time_of_measure`: **"hour of day
(0–23, UTC) at which the peak temperature occurs."** That is evidence about a
*different* field, not a contract about `start_time`.

**Resolution:** the product works in **America/Phoenix (UTC−7, no daylight
saving)**, sends the chosen wall-clock time unchanged, and records the assumption in
every run, every export and the UI. `--probe-timezone` tests it directly by
submitting 04:00 and 15:00 on the same date and comparing the returned means.

---

## 3bis. Direct answers from the organisers, 2026-08-03

An email from `hackathon@fortyguard.com` (2026-08-03, in reply to the
registration thread of `credoz.da@gmail.com`) answered five questions directly.
Where it conflicts with the public page, the email is more specific and more
recent, and it is first-party:

1. **Deadline confirmed:** 30 August 2026, 11:59 PM GST.
2. **Pre-sprint work is explicitly allowed:** *"Yes, you may begin building your
   project before the official sprint starts."* This supersedes the
   interpretation argument in §4 — the position is no longer inferred from
   silence, it is stated in writing.
3. **API key:** participants receive the **Premium plan**, all Temperature API
   endpoints, no credit quota or expiry concerns; keys stay valid until judging
   ends. (Premium documents a 50 mi² area ceiling; this project's 9 mi² tile
   ceiling remains, as conservative headroom.)
4. **Slack:** invitations sent the week before the sprint; the API key steps,
   technical support, the submission form and the exact GitHub collaborator
   account all arrive there.
5. **Submission requirements per the email:** public repository, **a 3-minute
   demo video**, a README, and a brief summary. *"A live demo is not
   required."* This **contradicts** the site FAQ (repo + live demo +
   collaborator). Resolution: satisfy the union — this project ships the live
   demo *and* prepares the 3-minute video.

## 4. Pre-development: what the rules do and do not say

> **Superseded in part by §3bis.** This section reasons from the *absence* of a
> rule. The 2026-08-03 organiser email answers two of its questions directly:
> pre-sprint work is permitted, and a three-minute demo video **is** required.
> It is kept because the disclosure position it argues for is the one still in
> force, not because the inference is still needed.

**Searched for and not found:** any statement prohibiting work before 18 August,
any rule about pre-existing code or datasets, any originality-window requirement,
any video requirement. The site has no separate rules or terms page — the only
policy link is `/privacy-policy`. The FAQ's "eligibility rules on this site" points
at no further document.

**What is stated:** a two-week *Build Sprint* window of 18–30 August, and that
FortyGuard data must be *central* to the project.

**Interpretation adopted:** absent an explicit prohibition, preparatory work is not
forbidden, but the published sprint window makes **disclosure the honest course**.
Therefore:

1. `README.md` and `docs/submission-draft.md` both carry a **Pre-existing work**
   section stating exactly what existed before 18 August 2026.
2. Nothing is backdated. The path-only data purge performed on 2026-08-23 keeps
   commit authors, dates, messages and this disclosure; it does not imply that
   the work began after the sprint.
3. If FortyGuard states a stricter rule, this project's position is disclosed and
   auditable rather than concealed.

### Pre-existing work to declare

| Artefact | Status before the Build Sprint |
|---|---|
| `docs/shadefirst_data_spike_report.md` | Existed — data feasibility spike, 2026-08-04 |
| `scripts/spike/analyze_shadefirst.py` | Existed — join and audit script |
| `outputs/joined_phoenix_stops.csv`, `outputs/spike_metrics.json` | Existed — spike outputs |
| Downloaded FortyGuard OpenAPI document | Existed — removed from the current tracked tree because it is not required and has no established redistribution permission |
| `scripts/fortyguard/run_fortyguard_probe.py` | Existed in an earlier form; **substantially rewritten** (tiling, timezone, field whitelist, capability probe) |
| Everything else — the whole application, the FortyGuard client, the scoring engine, the tests, the docs | **Created for this hackathon** |

No third-party code was copied. All dependencies are declared in `package.json`.

---

## 5. Dataset licensing

| Dataset | Terms found |
|---|---|
| City of Phoenix — Bus Stops (ArcGIS MapServer) | No item-specific bulk-redistribution permission found; raw extract removed from the tracked tree 2026-08-23. |
| Valley Metro — Bus Stops with Amenities (ArcGIS Online, flagged *Authoritative*) | **Established.** Exact item `35d5c9ae…` grants unrestricted sharing, modification and use; reviewed 2026-08-22. |
| Valley Metro — legacy Bus Stops layer | **Established.** Exact item `14920e15…` carries the same grant; reviewed 2026-08-22. |
| Valley Metro — quarterly ridership | Exact item `3f5363e0…` has empty `licenseInfo`; raw extract removed from the tracked tree 2026-08-23. |
| Shade Phoenix Plan story map | Cited as a published figure (3,164 sheltered stops, FY2024-25), not scraped or redistributed. |

**Correction.** This section previously said "no dataset is redistributed beyond
what the fetch scripts download for local analysis". That was false: four raw
extracts were committed publicly. Two licensed layers remain on `main`; the two
unresolved payloads remain public through PR #1's read-only ref.
Exact-item research established permission for the two Valley Metro bus-stop
layers. The City and quarterly-ridership raw extracts were removed rather than
licensed by inference. The GTFS archive is separately licensed ODC-BY.

No licence is inferred merely from an endpoint being open. Current-tree removal
did not resolve the repository-wide redistribution blocker; see
[`data-provenance.md` §8](data-provenance.md) for the full position, what has been
done, and what has deliberately not been. Every file carries a recorded SHA-256
and download timestamp either way.

---

## 6. Submission requirements — status

This table is the **requirement-by-requirement** record. The ordered list of
actions still to take, and who has to take them, is
[`submission-checklist.md`](submission-checklist.md); nothing there is marked done
on the strength of a plan.

| Requirement | Status |
|---|---|
| Public GitHub repository | **Done** — <https://github.com/Damso74/fortyguard-heat-priority-engine>. Recorded as public; re-confirm the remote and its visibility before submitting. |
| Live website / demo link | **Done and re-verified 2026-08-23** — <https://heat-priority-engine.vercel.app>. Production serves the pilot and Reports shows `Submission licensing: Ready`. Re-confirm on submission day. |
| Add the FortyGuard collaborator account | **Invitation created 2026-08-23; acceptance pending.** GitHub accepted a `read` invitation for `Hackathon-FG` (`hackathon@fortyguard.com`) on the clean public repository. Acceptance depends on that account; the repository is already publicly readable. |
| Submitted before 30 Aug 2026 GST | **Not done.** The form is distributed via Slack. Deadline 30 August 2026, 23:59 GST = 19:59 UTC = 12:59 America/Phoenix. |
| FortyGuard data central to the project | **Yes, demonstrated with real data.** The default pilot serves 450 cells from three completed activities across 27 Downtown stops; its thermal gate selects `EXPOSURE_ONLY`. See §7. |
| US geography | Yes — Phoenix, Arizona |
| Team ≤ 3 | Yes — solo registration confirmed 2026-07-29 |
| **3-minute demo video** | **Uploaded non-listed on the owner's instruction 2026-08-23:** <https://youtu.be/GW-F8puuu5I>. YouTube serves 2:32 with active English captions and reports no copyright issue. The ignored local MP4 remains 2:32.88 at 1440×810 with the owner's ElevenLabs voice clone, guided cursor, embedded English subtitles, normalized audio and the resolved licensing state. See [`demo-script.md`](demo-script.md). |
| README + brief summary | README written; the brief summary is [`submission-draft.md`](submission-draft.md), also not yet submitted anywhere. |
| **Raw-source redistribution rights** | **Resolved by clean replacement repository.** The original repository, whose PR ref retained the removed files, is private. This public repository starts at a verified clean root and contains neither raw extract nor the unneeded OpenAPI download. Pending permission requests also cover processed per-stop fields (§5, `data-provenance.md` §8). |
| Form declaration: repository created after kickoff | **Supported by current repository metadata.** GitHub records the clean public submission repository creation on 2026-08-23, after the 2026-08-18 onboarding/kickoff. The retained 2026-08-03 organiser email separately permits pre-sprint building. The checkbox remains a personal attestation for the owner. |

### What may be claimed at submission, and what may not

Stated here once so the submission text, the demo narration and the video cannot
drift from it:

| May be claimed | May **not** be claimed |
|---|---|
| A real FortyGuard pilot: 450 cells, three completed activities, 2024-07-15 at 08:00 / 14:00 / 20:00 | Live API calls from the deployment — there are none, by construction |
| 27 Downtown stops, all covered at all three hours | Central Phoenix, Full Phoenix, or any city-wide thermal conclusion |
| Product mode `EXPOSURE_ONLY`, selected by the gates | A local hotspot — the anomaly is `NOT_PERSISTENT` and excluded from the ranking |
| 3 robust priorities + 7 assumption-dependent candidates, capacity 10, weekday | That the 10 are a ranked list of equally supported findings |
| Estimated scenario exposure load, modelled, over 324 scenarios | A measured rider dose, people protected, degrees reduced, or dollars |
| Independent project on public open data | Endorsement by FortyGuard, the City of Phoenix or Valley Metro |

---

## 7. FortyGuard centrality and remaining risk

The FAQ says FortyGuard data **"must be central to your project."** It is central
in the shipped default: three completed Phoenix activities produce the thermal
factor, and the quality gate decides that the real pilot supports exposure but
not a persistent local anomaly. The deployment reads the attested snapshot
offline and cannot spend credits.

The remaining scope risk is geographic, not synthetic: the reviewed footprint
covers 27 Downtown stops and must not be presented as Central or Full Phoenix.
The submission and demo script state that boundary explicitly.

---

*Compiled 2026-08-04; live-data sections updated 2026-08-19; §6 consolidated
2026-08-22. Re-verify §2 and §3 against the official page before submitting: the
page has already been revised once, and nothing in this repository can detect a
third revision.*
