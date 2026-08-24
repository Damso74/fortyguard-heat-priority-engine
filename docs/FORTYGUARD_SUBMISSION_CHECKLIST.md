# FortyGuard final submission checklist

Last rule review: **24 August 2026**. Internal target: **26 August 2026**.
Official deadline: **30 August 2026, 23:59 GST (UTC+4)** = 19:59 UTC = 21:59
Europe/Berlin. The official page says no late submissions.

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
| Public GitHub repository | `CONFIRMÉ` | <https://github.com/Damso74/fortyguard-heat-priority-engine>; public HTTP access and clean history verified 2026-08-24. |
| Repository created after kickoff | `CONFIRMÉ` | GitHub creation time `2026-08-23T17:41:51Z`; kickoff was 18 August. Pre-existing work remains disclosed in the README. |
| FortyGuard collaborator | `CONFIRMÉ` | GitHub permissions API reports `Hackathon-FG` role `read`; no pending invitation on 2026-08-24. |
| Live demo without login/install | `CONFIRMÉ` | <https://heat-priority-engine.vercel.app>; desktop and 412×915 browser checks passed, with no console error or error overlay. |
| Working demo video, maximum 3 minutes | `CONFIRMÉ` | <https://youtu.be/GW-F8puuu5I>; 152.921 seconds, captions control present, video available. |
| Owner listens to and approves final narration | `À VÉRIFIER HUMAINEMENT` | The owner must approve voice, pronunciation and pacing end to end. |
| README and project summary | `CONFIRMÉ` | [`README.md`](../README.md) and [`submission/PROJECT_SUMMARY.md`](submission/PROJECT_SUMMARY.md). |
| Architecture and evidence pack | `CONFIRMÉ` | [`submission/ARCHITECTURE.md`](submission/ARCHITECTURE.md) and [`submission/EVIDENCE.md`](submission/EVIDENCE.md). |
| Required technologies and U.S. data | `CONFIRMÉ` | FortyGuard Temperature API data is central; Phoenix, Arizona is the real pilot geography. |
| Judging alignment | `CONFIRMÉ` | Impact/relevance 40%, technical execution 35%, innovation 15%, communication 10%; evidence mapping is in [`submission/EVIDENCE.md`](submission/EVIDENCE.md). |
| Code licence decision | `À VÉRIFIER HUMAINEMENT` | No separate open-source licence is declared. Public access permits review, not reuse; dataset licences are explicit. Official rules say the author retains ownership and grants FortyGuard a showcase licence. |
| Registered email, API key and personal declarations | `À VÉRIFIER HUMAINEMENT` | Enter only in the official form. Never place the key in Git, chat or browser-visible code. |
| Final Google Form submission | `À FAIRE` | [Official six-page form](https://docs.google.com/forms/d/e/1FAIpQLSdheKfejq4uAk5dNluoaH6yBAL9N78-E1H8c_8FSnSMZKGlqQ/viewform). Latest resubmission before the deadline replaces earlier entries. |
| Submission confirmation recorded | `À FAIRE` | After sending, record the timestamp and submitted URLs in [`hackathon-compliance.md`](hackathon-compliance.md). |

No technical or publication requirement is currently `BLOQUÉ`.

## Seal findings

| Priority | Finding | Resolution |
|---|---|---|
| `P0` | Final form is not submitted. | Intentionally remains a human-only action because it requires a private API key and personal attestations. |
| `P1` | Repository documents still said the collaborator invitation was pending. | Corrected after GitHub confirmed accepted role `read` and no pending invite. |
| `P1` | The requested consolidated submission package and status vocabulary were absent. | Added this checklist and the four files under [`submission/`](submission/). |
| `P1` | README quick start used `npm install` although the lockfile and CI require reproducibility. | Replaced with `npm ci`; added direct submission and licence-status links. |
| `P2` | Cosmetic redesign, new features and dependency upgrades. | Deliberately not attempted. |

The detailed operational checklist remains in
[`submission-checklist.md`](submission-checklist.md).
