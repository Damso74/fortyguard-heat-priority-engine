# Deployment

Target: **Vercel**. Configuration is committed in `vercel.json` and
`next.config.mjs`. No database or auth provider is required. The deployed app
reads the reviewed FortyGuard snapshot offline; only basemap tiles are fetched
at runtime.

---

## Preconditions

```bash
npm run verify      # must be green before deploying
```

The build is a standard Next.js App Router build. The generated dataset is imported
statically in `lib/data/stops.ts`, so it is always included in the deployment
bundle — there is no runtime filesystem assumption.

---

## Environment variables to set in Vercel

Project → Settings → Environment Variables. Everything except
`NEXT_PUBLIC_MAP_STYLE_URL` is **server-only** and is never bundled into client
JavaScript.

| Variable | Production value | Notes |
|---|---|---|
| `FORTYGUARD_API_KEY` | *(unset)* | The deployed product has no live capture path and does not need the key. |
| `FORTYGUARD_API_BASE_URL` | `https://api.fortyguard.com` | |
| `FORTYGUARD_AUTH_HEADER` | `api-key` | |
| `FORTYGUARD_MAX_TILE_SQ_MI` | `9` | Under the smallest documented plan limit |
| `FORTYGUARD_MAX_CONCURRENCY` | `2` | |
| `FORTYGUARD_POLL_TIMEOUT_SECONDS` | `600` | Must stay under the function `maxDuration` × poll budget |
| `FORTYGUARD_RESULT_HOST_ALLOWLIST` | `api.fortyguard.com` | SSRF guard |
| `RUN_LIVE_FORTYGUARD` | `0`, always, in every Vercel environment | Read **only** by the local capture CLI. Setting it here enables nothing: no deployed code can submit |
| `DATA_MODE` | `auto` | |
| `PRODUCT_MODE` | `auto` | Let the gates decide |
| `NEXT_PUBLIC_MAP_STYLE_URL` | *(empty)* | Empty uses the key-free OpenFreeMap Positron style |

**Never** paste the key into a `NEXT_PUBLIC_*` variable. `lib/config/server-env.ts`
throws if it is imported from client code, and `npm run scan:secrets` fails the
build if a server secret name appears in a browser-served asset.

---

## First deployment

```bash
npm i -g vercel
vercel login
vercel link                 # create or link the project

# set only the non-secret runtime values from the table when they differ from defaults

vercel --prod
```

## Preview deployment

```bash
vercel                      # preview, no --prod
```

Set `DEPLOY_PREVIEW=1` locally if you want the preview step to be part of a
scripted release; nothing in the application reads it, it exists to gate an
operator's own automation.

## Verifying a deployment

```bash
curl -s https://<deployment>/api/fortyguard/status | jq
```

Expected with no key:

```json
{ "configured": false, "liveEnabled": false, "authHeaderName": "api-key", "maxTileSqMi": 9 }
```

This endpoint returns booleans and configuration names only. It never returns the
key, a prefix of it, or its length.

Then load the site and confirm:

1. `/` renders the overview and the eight-module navigation;
2. `/heat` reports the three stored Phoenix hours and the provenance boundary;
3. `/planner` shows `3 robust priorities + 7 assumption-dependent candidates`;
4. a mission can be submitted and accepted, producing plan version 2;
5. `/scenarios`, `/reports` and `/methodology` render without a dead route;
6. `/api/fortyguard/status` never reveals a key or key-derived value.

---

## Live capture stays local

There is no live FortyGuard path in the deployed product. A capture is a local
operator action requiring `RUN_LIVE_FORTYGUARD=1`, `--confirm-spend`, a positive
`--max-new-submissions`, and a server-only API key. The CLI refuses to run when
it detects Vercel, Lambda, Netlify, Cloudflare Pages, GitHub Actions or `CI`.
After review, a newly captured immutable snapshot can be committed and deployed.

---

## Repository publication

The official form names **`Hackathon-FG`** (`hackathon@fortyguard.com`). It
accepted read permission; GitHub reconfirmed role `read` with no pending invite
on 2026-08-24. Access was granted after the public-repository licensing blocker
recorded in `data-provenance.md` §8 was resolved
([`data-provenance.md` §8](data-provenance.md); ordering in
[`submission-checklist.md`](submission-checklist.md)):

```bash
# add the required collaborator
gh api -X PUT repos/Damso74/fortyguard-heat-priority-engine/collaborators/Hackathon-FG \
  -f permission=pull
```

**Before every final push**, confirm:

```bash
npm run scan:secrets        # must report clean
git ls-files | grep -E '^\.env' | grep -v '\.env\.example'   # must return nothing
```

`.gitignore` already excludes `.env*` (except `.env.example`), `data/live/`, raw
FortyGuard response dumps, `pids/` and `__pycache__/`.

---

## Two things this deployment depends on

### The build command must be `npm run build`

`vercel.json` used to set `buildCommand: "next build"`, which skips the `prebuild`
step that copies MapLibre's worker out of `node_modules` into `public/`. That file
is gitignored — deliberately, so a stale hand-copied worker cannot drift from the
installed version — so it was absent from every deployment. The map then rendered
raster basemap tiles, which need no worker, while every GeoJSON source stayed
silently empty: the page looked alive and carried no data.

The command is now `npm run build`, and `postbuild` fails the build if the asset
is missing or does not match `node_modules`. Do not change either back.

### Exports need the run and the export to reach the same instance

An export is a frozen representation of a completed run, so `/api/plans/export`
looks the run up in a per-process store that `/api/plans` writes to. If a platform
routes the two requests to different instances, the export returns `409` with a
message saying the run is not held and asking for a re-run.

That is the safe direction — the alternative is re-executing the engine, which
produces a second audit trail with new timestamps for a run that already happened
— but it is a real limitation. Making it durable needs shared storage and is a
deployment decision; the proposed design, deliberately unbuilt, is in
[`post-submission-architecture.md`](post-submission-architecture.md).

## Rollback

Vercel keeps every deployment. Promote a previous one from the dashboard, or:

```bash
vercel rollback <deployment-url>
```

Nothing in the application holds state, so a rollback is complete — there is no
migration to reverse and no cache to invalidate.
