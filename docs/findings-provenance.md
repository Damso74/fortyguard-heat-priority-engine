# Findings provenance

This page separates real Phoenix evidence, derived planning outputs and the
synthetic fallback. Check it before quoting a number.

## Real Phoenix evidence

| Finding | Provenance |
|---|---|
| 4,288 active Phoenix transit stops | Valley Metro authoritative layer, hash-pinned and rebuilt in verification. |
| 3,991 stops with published ridership | Valley Metro quarterly ridership, FY2024 Q4 selected by executable completeness checks. |
| Weekday / Saturday / Sunday service | Official GTFS; 7,854 / 5,476 / 4,815 trips in the modal patterns. |
| 450 Downtown Phoenix thermal cells | Three completed FortyGuard `tcm` activities, 150 cells at 08:00, 14:00 and 20:00 on 2024-07-15. |
| Spatial means 34.3686 / 39.7108 / 39.1268 °C | `average_temperature`, documented `tcm` unit, immutable snapshot hashes. |
| 27 stops inside the returned pilot footprint | Polygon containment against the returned cell rings; all 27 receive all three hours. |

The snapshot records the activity ids, transmitted hours, raw-envelope SHA-256
digests, capability fingerprint, cell rings, surface digest and attestation
digest. The deployment reads it offline; it does not call FortyGuard.

## Derived pilot output

The default run is `CACHED_REAL_DATA`, capacity 10, weekday. It uses the real
thermal surface, published average ridership and scheduled service to calculate
an **estimated scenario exposure load**. It is a model, not a measured dose:

- nobody counted riders by hour;
- scheduled waits are not observed waits;
- the 30 °C reference is FortyGuard’s analytics default, not a health threshold;
- the thermal date (2024), ridership quarter (2024) and GTFS schedule (2026) do
  not describe one simultaneous observed day.

The pilot’s anomaly validation is `NOT_PERSISTENT`, so the app excludes that axis
and selects `EXPOSURE_ONLY`. Do not quote any hotspot or causal intervention claim.

## Synthetic fallback

Requests that do not match the committed pilot snapshot use the deterministic
fixture only when `DATA_MODE=auto` or `demo`. Every such run is permanently
labelled `DEMO — SYNTHETIC`; its temperature-derived ranks are demonstrations of
the method and not findings about Phoenix. `DATA_MODE=cached_real` fails instead
of falling back.

## Claims still blocked

- a stop is unsheltered;
- an intervention reduces temperature;
- a number of people are protected;
- dollars saved or implementation cost;
- endorsement by the City of Phoenix, Valley Metro or FortyGuard;
- city-wide conclusions from the Downtown pilot.
