# FortyGuard capability report

**Status: real Phoenix pilot captured and committed.** The app serves 450 cells
from three completed, already-paid FortyGuard activities. No deployed route can
submit a request or spend a credit.

## Reviewed capability

| Question | Evidence | Decision |
|---|---|---|
| Value field | All 450 returned features carry numeric `average_temperature`, `min_temperature` and `max_temperature`. | `average_temperature` confirmed for this product. |
| Semantics | FortyGuard describes `tcm` as a temperature snapshot produced by its Large Temperature Models. | Modelled temperature per returned tile; not an in-situ measurement. |
| Unit | The official Create Heatmap documentation says `tcm` returns temperature in °C per tile. | Literal `°C` confirmed. |
| Timezone | The response omits timezone metadata. Against an America/Phoenix baseline, the three-point local interpretation has MAE 1.1103 °C and RMSE 1.7226 °C; UTC has MAE 3.8354 °C and RMSE 5.6527 °C. | AOI-local wall clock empirically confirmed for this Phoenix pilot (UTC RMSE 3.28× worse), not vendor-contract confirmed. The unchanged transmitted values are attested. |

Primary documentation: [Create Heatmap](https://docs-api.fortyguard.com/docs/create-heatmap),
[Authentication](https://docs-api.fortyguard.com/docs/authentication), and
[Quickstart](https://docs-api.fortyguard.com/docs/quickstart).

The reviewed answers live in
`data/manifests/fortyguard-capability.json`. Their capability fingerprint is
bound into the snapshot attestation. Changing any answer invalidates the
snapshot until it is deliberately re-imported or re-captured.

## Capture

| Property | Value |
|---|---|
| Analysis date | 2024-07-15 |
| Phoenix hours | 08:00, 14:00, 20:00 |
| Analytic | `tcm` |
| Granularity | 100 m |
| Completed activities | 3 |
| Returned cells | 150 per hour, 450 total |
| Spatial means | 34.3686 °C, 39.7108 °C, 39.1268 °C |
| Returned footprint | -112.0777453 / 33.4416587 to -112.0669919 / 33.4550458 |
| Snapshot mode | `LIVE_FORTYGUARD` at capture; `CACHED_REAL_DATA` when served |

The submitted polygon was slightly larger than the returned 150-cell footprint.
The app’s pilot AOI is deliberately clipped to the identical footprint returned
at all three hours. It is not represented as Central or Full Phoenix coverage.

The reproducible, network-free importer is:

```bash
npm run fortyguard:import-pilot -- --input-dir /path/to/original/captures
```

It verifies the date, hours, analytic, granularity, submitted AOI, returned
footprint, status, feature count and activity ids; hashes each raw envelope; then
writes the content-addressed snapshot through the production snapshot validator.

## Quality-gate result

The pilot covers every stop in the returned footprint, but the thermal surface
is spatially uniform and its local anomaly does not persist across held-out
hours. The product therefore selects `EXPOSURE_ONLY`:

- confirmed absolute heat conditions the transit-burden calculation;
- ridership and scheduled waiting discriminate between stops;
- the anomaly axis is excluded from ranking;
- no hotspot, shelter effect or city-wide thermal claim is made.

This is a positive product behaviour, not a hidden failure: a municipal system
must be able to say “heat is widespread; prioritise operational exposure” rather
than manufacture local hotspots.

## Observed contract deviations

Two valid recent-date Phoenix requests returned `Completed` with zero cells and
consumed 8,440 credits in total. This conflicts with the documented principle
that unsuccessful work is not charged. The app rejects empty results and never
commits them. The open vendor questions are:

1. What is the actual freshness boundary for heatmaps?
2. Should `Completed` with `n_cells: 0` be charged?
3. Can heatmap responses expose explicit units, timezone and normalized timestamps?
