# FortyGuard final submission checklist

Last rule review: **24 August 2026**. Internal target: **26 August 2026**.
Official deadline: **30 August 2026, 23:59 GST (UTC+4)** = 19:59 UTC = 21:59
Europe/Berlin. The official page says no late submissions.

Release evidence updated: **26 August 2026**.

Status meanings:

- `CONFIRMÉ` — backed by a command, public response or retained artefact.
- `À FAIRE` — known action not completed.
- `À VÉRIFIER HUMAINEMENT` — requires the owner's judgement or attestation.
- `BLOQUÉ` — cannot proceed without a missing external prerequisite.

| Requirement | Status | Evidence |
|---|---|---|
| Global, virtual eligibility | `CONFIRMÉ` | [Official eligibility FAQ](https://www.fortyguard.com/hackathon26): global participation; U.S. geography required by data coverage. Phoenix is in scope. |
| Team size 1–3 | `CONFIRMÉ` | Official FAQ; project is registered as a solo entry. |
| FortyGuard data is central | `CONFIRMÉ` | Three completed activities, 450 stored real cells and 27 covered Downtown stops; see [`findings-provenance.md`](findings-provenance.md). |
| Other datasets respect licences | `CONFIRMÉ` | Raw extracts without redistribution terms are excluded from the complete public history; retained source rights and hashes are in [`data-provenance.md`](data-provenance.md). |
| Public GitHub repository | `CONFIRMÉ` | <https://github.com/Damso74/fortyguard-heat-priority-engine>; verified product head `e6240dbf`, no inherited pull-request refs. |
| Repository created after kickoff | `CONFIRMÉ` | GitHub creation time `2026-08-23T17:41:51Z`; kickoff was 18 August. Pre-existing work remains disclosed in the README. |
| FortyGuard collaborator | `CONFIRMÉ` | GitHub permissions API reports `Hackathon-FG` role `read`; no pending invitation on 2026-08-26. |
| Live demo without login/install | `CONFIRMÉ` | <https://heat-priority-engine.vercel.app>; deployment `dpl_BGtEM9GUGfUErhWj3WRArxMhA6ji` is `READY` from `e6240dbf`; all eight routes returned HTTP 200 and the production browser check found no console error. |
| Working demo video, maximum 3 minutes | `CONFIRMÉ` | <https://youtu.be/LPq0Tn6YX9w>; 1:25, non-listed, English captions and no copyright issue reported by YouTube. |
| Owner authorises final publication | `CONFIRMÉ` | Explicit `GO FINAL` instruction received on 26 August 2026. |
| README and project summary | `CONFIRMÉ` | [`README.md`](../README.md) and [`submission/PROJECT_SUMMARY.md`](submission/PROJECT_SUMMARY.md). |
| Architecture and evidence pack | `CONFIRMÉ` | [`submission/ARCHITECTURE.md`](submission/ARCHITECTURE.md) and [`submission/EVIDENCE.md`](submission/EVIDENCE.md). |
| Required technologies and U.S. data | `CONFIRMÉ` | FortyGuard Temperature API data is central; Phoenix, Arizona is the real pilot geography. |
| Judging alignment | `CONFIRMÉ` | Impact/relevance 40%, technical execution 35%, innovation 15%, communication 10%; evidence mapping is in [`submission/EVIDENCE.md`](submission/EVIDENCE.md). |
| Code licence decision | `À VÉRIFIER HUMAINEMENT` | No separate open-source licence is declared. Public access permits review, not reuse; dataset licences are explicit. Official rules say the author retains ownership and grants FortyGuard a showcase licence. |
| Registered email, API key and personal declarations | `CONFIRMÉ` | Supplied directly in the official form under the owner's explicit `GO FINAL` authorisation; no secret was added to Git or application code. |
| Final Google Form submission | `CONFIRMÉ` | [Official six-page form](https://docs.google.com/forms/d/e/1FAIpQLSdheKfejq4uAk5dNluoaH6yBAL9N78-E1H8c_8FSnSMZKGlqQ/viewform) confirmed “Your project is submitted” on 26 August 2026 at 18:51 Europe/Berlin. |
| Submission confirmation recorded | `CONFIRMÉ` | Timestamp and final public URLs are recorded in [`hackathon-compliance.md`](hackathon-compliance.md) and [`submission/EVIDENCE.md`](submission/EVIDENCE.md). |

No technical or publication requirement is currently `BLOQUÉ`.

## Seal findings

| Priority | Finding | Resolution |
|---|---|---|
| `P0` | Final form was not submitted. | Resolved under the owner's explicit `GO FINAL` authorisation; Google Forms confirmed receipt. |
| `P1` | Repository documents still said the collaborator invitation was pending. | Corrected after GitHub confirmed accepted role `read` and no pending invite. |
| `P1` | The requested consolidated submission package and status vocabulary were absent. | Added this checklist and the four files under [`submission/`](submission/). |
| `P1` | README quick start used `npm install` although the lockfile and CI require reproducibility. | Replaced with `npm ci`; added direct submission and licence-status links. |
| `P2` | Jury-facing readability and novice projection. | Focused UX refinements shipped and verified on 26 August without changing the deterministic decision engine. |

The detailed operational checklist remains in
[`submission-checklist.md`](submission-checklist.md).
