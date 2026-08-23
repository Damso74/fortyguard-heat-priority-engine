# Invalid thermal snapshots, kept deliberately

Nothing in this directory is read at runtime. The snapshot store is
`data/generated/thermal-snapshots/`, and it holds **real captures only** —
`lib/fortyguard/snapshot-store.ts` refuses to write anything else and
`npm run check:snapshots` fails CI on anything else.

These two files were found *in* the production store. They are kept here because
each is a worked example of a failure the store must reject, and a regression
test reads them:

| File | What it is | Why it must be rejected |
|---|---|---|
| `INVALID_fabricated-real-empty.json` | `LIVE_FORTYGUARD` / `REAL`, activity ids `act-1` and `act-2`, `unitConfirmed: true`, **zero cells** | Every one of those four things independently: no cells, placeholder activity ids, a confirmed Celsius unit the capability manifest does not support, and a surface digest computed over cells the file does not contain |
| `INVALID_synthetic-in-production-store.json` | A valid `DEMO_SYNTHETIC` snapshot | Synthetic layers are generated on demand by `lib/fortyguard/demo-fixture.ts`. A synthetic file in the production store adds nothing and creates exactly the real-or-not ambiguity the store exists to remove |

Both are schema **version 2** and would now also fail on version alone. That is
not the point — the tests assert the *substantive* rejections, so removing the
version check would not make either file loadable.

The fabricated file is the reason `realCaptureFailures` exists. It claimed to be
a real Phoenix measurement, it was committed, it was hash-consistent enough to sit
in a diff unnoticed, and it contained no data at all.
