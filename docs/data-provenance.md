# Data provenance

Every dataset here is downloaded by a script that asserts the service-reported
record count, refuses a short or empty page, and records the SHA-256 of the exact
bytes used. `npm run data:check-distributed` verifies every retained raw artefact,
the generated application dataset and the exclusion of the two unresolved raw
extracts without touching the network. It runs inside `npm run verify`.

Machine-readable form: `data/manifests/source-provenance.json` and
`data/manifests/generated-dataset.json`.

---

## 1. City of Phoenix — Bus Stops

| Field | Value |
|---|---|
| Producer | City of Phoenix (Public GIS) |
| Endpoint | `https://maps.phoenix.gov/pub/rest/services/Public/BusStops/MapServer/0` |
| Query | `where=1=1`, `outFields=*`, `outSR=4326`, `f=geojson` |
| Downloaded | 2026-08-04 |
| Records | **4,104** (service-reported count matched exactly) |
| Service last edit | **not published** |
| Service time reference | `US Mountain Standard Time` (i.e. America/Phoenix, no DST) |
| `copyrightText` | `Aarti Dua` |
| Projection | native EPSG:4326, requested EPSG:4326 |
| Artefact | `data/raw/phoenix_bus_stops.geojson`, 1,655,996 bytes |
| SHA-256 | `00bce32aa1ce6c677fefb73a96dcf72173047c9dc4779874d21344b8dd7130e7` |
| Fields used | `STOP_ID`, `NEXTRIDEID`, `RIDERSHIP`, `NBR_SHELTERS` |

**Known limitations**

- The service publishes no `lastEditDate`, so its freshness **cannot be proven**.
- `RIDERSHIP` has no documented unit, period or collection date. Distribution:
  min 0, median 9, P90 65, P99 ≈ 173, max 609. Present on 4,029 of 4,104 records.
- `NBR_SHELTERS` is populated on **20** of 4,104 records (0.49%) and contradicts
  the City's own published sheltered-stop total. It is never read as an inventory.

---

## 2. Valley Metro — Bus Stops with Amenities (Phoenix jurisdiction)

The identity and geometry source. Flagged *Authoritative* by the publisher.

| Field | Value |
|---|---|
| Producer | Valley Metro (ArcGIS Online) |
| Endpoint | `https://services2.arcgis.com/2t1927381mhTgWNC/arcgis/rest/services/BusStopsWAmenities/FeatureServer/0` |
| Query | `where=Juris='Phoenix'`, `outFields=*`, `outSR=4326`, `f=geojson` |
| Downloaded | 2026-08-04 |
| Records | **4,289** (4,288 with `Status='Active'`) |
| Service last edit | **2026-07-27T20:47:16Z** |
| `copyrightText` | `Valley Metro Service Planning GIS` |
| Description | stops effective July 2026 |
| Artefact | `data/raw/valley_metro_phoenix_stops.geojson`, 4,200,259 bytes |
| SHA-256 | `05ee48522e85e352ff9eeca57222177c29487f357339d41ecb7e4f9020ee200d` |
| Fields used | `stop_id`, `stop_code`, `stop_name`, `stop_desc`, `Status`, `Routes`, `Shelters`, `Shelter`, `Shade` |

**Known limitations**

- Integer field `Shelters` is 0 or null on **every** Phoenix record.
- Text field `Shelter` equals `"1"` on **exactly one** Phoenix record.
- `Shade` is empty on every Phoenix record.
- These three fields cannot be read as an amenity inventory, and are never
  interpreted as "no shelter" anywhere in this project.

---

## 2b. Valley Metro — bus stop ridership by quarter and day category

**The ridership source the product actually computes on.** It replaced the City's
`RIDERSHIP` integer, which publishes no unit and no period.

| Field | Value |
|---|---|
| Producer | Valley Metro (`Ridership.dbo.BusRidershipByQuarterForPortal`) |
| Endpoint | `.../BusStopQuarterlyRidership/FeatureServer/0` |
| Query | `where=Juris='Phoenix'`, attribute-only table |
| Records | **9,024** rows (Weekday and Weekend per stop, several quarters) |
| Service last edit | **2024-12-16** |
| Artefact | `data/raw/valley_metro_quarterly_ridership.json` |
| Field used | `F2024_4` — FY2024 Q4, the latest quarter passing our completeness checks |
| Unit | **average daily riders per stop** |
| Period | **quarterly average, split Weekday / Weekend** |

Phoenix Weekday 2024 Q4: 4,021 stops, min 0, max 165.94, mean 10.5, **sum
42,221 riders/day**.

### Why "passing our completeness checks", and not "the last complete quarter"

Later quarters **are** published. They are not used because they fail the checks
this project can run: Phoenix weekday totals fall 43,092 → 19,324 → 5,413 →
2,522, and individual stops drop from ~41 riders/day to 0.26. A fall that steep
is far better explained by partial reporting than by a 94% collapse in ridership.

Those checks are **ours alone, and nothing independent reconciles them.** Valley
Metro publishes no completeness flag, no data dictionary and no revision notice
for this layer. So the defensible claim is narrow:

- **What we can say:** FY2024 Q4 is the latest quarter that does not fail our
  monotonicity and per-stop implausibility checks.
- **What we cannot say:** that FY2024 Q4 is itself complete. It may under-report
  by an amount no check here would detect, in which case every exposure value is
  proportionally low.

If a reconciliation against a published control total ever becomes available,
this section should be replaced with what that establishes and the wording
upgraded. Until then the product says "latest quarter passing our completeness
checks" everywhere, and never "last complete quarter".

**Known limitations**

- The layer does **not** state whether a value counts boardings only or boardings
  plus alightings. Exposure estimates built on it are an **upper bound** if
  alightings are included, because alighting riders do not wait. Recorded as
  assumption A2.
- The quarter used is FY2024 Q4, while the geometry layer is effective July 2026.
  The two describe slightly different networks.
- 890 rows carry no `StopID` or an unrecognised day category and are discarded
  rather than guessed. A further 28 stops have a row whose 2024 Q4 values are
  blank for both day categories; those are treated as *no ridership*, not as an
  empty record.

---

## 2c. Valley Metro — GTFS static schedule

**The headway source.** Without it there is no defensible expected wait, and
metric A does not exist.

| Field | Value |
|---|---|
| Producer | Valley Metro, published by City of Phoenix Open Data |
| Dataset | `valley-metro-bus-schedule` |
| Download | `https://www.phoenixopendata.com/dataset/.../googletransit.zip` |
| **Licence** | **Open Data Commons Attribution License (ODC-BY)** — permits redistribution with attribution |
| Updated | 2026-07-27 |
| Artefact | `data/raw/valley_metro_gtfs.zip`, 7,110,085 bytes |
| Derived | `data/generated/stop_service_frequency.json` |
| Stops with service | **7,908**; **380,596** weekday departures counted |
| Join to the stop layer | **99.46%** — 4,265 of 4,288 active Phoenix stops |

Definitions applied, all recorded in the derived file:

- **Representative weekday** — the service set active on the modal weekday of the
  feed's active period, chosen by trip count so a holiday or school-only calendar
  cannot masquerade as a typical day.
- **Departure** — one `stop_times` row at the stop on a representative-weekday
  trip, **excluding the final stop of each trip** (nobody waits there to board).
  7,854 such rows were excluded.
- **Hour** — local clock hour of `departure_time`; GTFS times ≥ 24:00 wrap modulo 24.

**Known limitations:** scheduled service, not observed service. Cancellations,
detours and real-time deviation are not represented. Frequency is a proxy for when
riders are present, not a measurement of it (assumption A1).

**A note on the download.** The CKAN endpoint 302s to a presigned S3 URL carrying
an AWS access key id and signature. That URL is used once, in memory, and is never
logged or written to a manifest — only the stable CKAN URL is recorded. A test
asserts the metadata contains no `AKIA` or `X-Amz-Signature`.

---

## 3. Valley Metro — legacy Bus Stops layer

Retained only as a historical cross-check. Not used for any product value.

| Field | Value |
|---|---|
| Endpoint | `https://services2.arcgis.com/2t1927381mhTgWNC/arcgis/rest/services/ValleyMetroBusStops/FeatureServer/0` |
| Query | `where=Juris='Phoenix'` |
| Records | **4,758** |
| Service last edit | **2023-07-28T01:46:16Z** — superseded |
| `copyrightText` | `Valley Metro CSD GIS` |
| Native projection | **EPSG:2868**; the fetcher requests `outSR=4326` |
| Artefact | `data/raw/valley_metro_phoenix_stops_2023.geojson`, 5,613,540 bytes |
| SHA-256 | `5852dfd52b6f8549b31fbeb53f4c6027f2a3e4b70be7263ab789aa594741644e` |
| Fields used | `StopID`, `Photo`, `Shelter`, `Shade`, `Status` |

**Known limitations:** stop data stops in March 2023, amenity data in December
2022, only three shelter records attributed to Phoenix, and `Photo` is empty for
the overwhelming majority of Phoenix records. Too stale and too sparse to
reconstruct the missing inventory.

---

## 4. Generated analysis dataset

| Field | Value |
|---|---|
| Generator | `scripts/generate/build_analysis_dataset.py` |
| Artefact | `data/generated/phoenix_transit_stops.json`, 1,238,008 bytes |
| SHA-256 | `df6f5f81b4ef7e2dcf15c3b353fd5808bd5eb92e67fac3d2a5cbeac46bd1aebd` |
| Records | **4,288** active stops |
| With published ridership | **4,004** (93.38%) |
| Shelter status known | **0** |

Per-field classification:

| Field | Classification | Source |
|---|---|---|
| `id`, `code`, `name`, `description`, `lat`, `lon`, `routes` | **REAL** | Valley Metro amenities layer |
| `publishedRidership` | **REAL**, unit undocumented | Phoenix `RIDERSHIP` |
| `matchMethod` | **DERIVED** | exact `stop_id` join, `stop_code` fallback |
| `shelterStatus` | **UNKNOWN**, always | no usable source |

---

## 5. The join

Key: Valley Metro `stop_id` → Phoenix `STOP_ID`. No geographic join is needed on
the nominal path.

| Check | Result |
|---|---|
| Exact `stop_id` matches | **4,072** |
| `stop_code` fallback matches | **0** |
| Coverage of the Phoenix layer | **99.22%** |
| Phoenix records unmatched | 32 |
| Active Valley Metro stops unmatched | 216 |
| Median coordinate delta between matched pairs | **0.04 m** |
| P95 coordinate delta | **0.06 m** |

A 0.04 m median delta is strong evidence the two layers describe the same physical
assets. The 216 unmatched active stops are likely additions or scope differences,
but the absence of a date on the ridership field prevents confirming that.

---

## 6. Non-machine-readable source

**Shade Phoenix Plan story map** —
<https://storymaps.arcgis.com/stories/fc03d8a6a86e4f998169205dc8705e56>

Cited for one figure: **3,164 sheltered stops (78%) in FY2024-25**, after 81 new
installations. This single number is what makes the published amenity fields
provably incomplete rather than merely sparse, and is therefore the reason
`shelterStatus` is permanently `unknown`.

Cited, not scraped or redistributed.

---

## 7. Reproducing all of it

```bash
npm run data:fetch      # re-download; byte-identical if upstream is unchanged
npm run data:generate   # rebuild the joined dataset
npm run data:baseline   # regenerate outputs/spike_metrics.json
npm run data:check      # after fetch, verify every source hash without another network call
npm test                # assert all 19 baseline metrics and every hash
```

The fetcher refuses to overwrite a known-good dataset with a short response: it
compares against the service-reported count, guards on a minimum record count, and
fails loudly on an empty page or a lingering `exceededTransferLimit`.

Files are written with `newline=""` so the bytes on disk are identical to the text
that was hashed. Without that, Windows newline translation makes every recorded
hash wrong — a bug this project shipped for exactly one test run.

---

## 8. Licensing

**Status: `RESOLVED BY CLEAN REPOSITORY`.** The owner selected the conservative
removal path on 2026-08-23. The original repository was made private because its
read-only PR ref retained the removed payloads; the public submission repository
starts at a verified clean root commit and inherits none of those refs or objects.
No missing licence is inferred from silence.

### What is actually in this repository

Two raw ArcGIS source files are committed and public; the two unresolved
extracts are excluded from the tracked tree:

| Tracked file | Source | Published licence / decision |
|---|---|---|
| `data/raw/phoenix_bus_stops.geojson` | City of Phoenix — Bus Stops (ArcGIS MapServer) | **Not tracked.** Removed 2026-08-23 because no item-specific bulk-redistribution permission was found. |
| `data/raw/valley_metro_phoenix_stops.geojson` | Valley Metro — Bus Stops with Amenities (ArcGIS Online) | **Established 2026-08-22.** The exact ArcGIS item grants unrestricted sharing, modification and use. |
| `data/raw/valley_metro_phoenix_stops_2023.geojson` | Valley Metro — legacy Bus Stops layer | **Established 2026-08-22.** The exact ArcGIS item grants unrestricted sharing, modification and use. |
| `data/raw/valley_metro_quarterly_ridership.json` | Valley Metro — BusStopQuarterlyRidership | **Not tracked.** Removed 2026-08-23 because the exact item has an empty `licenseInfo`. |

`data/raw/valley_metro_gtfs.zip` is separately published under the **Open Data
Commons Attribution License (ODC-BY)**, which permits redistribution with
attribution.

### The contradiction this section used to contain

This document previously claimed the ArcGIS layers were not redistributed beyond
local fetches. That was false: committing them publicly is redistribution. The
claim is corrected, and exact-item research now settles two of the four rows.

### Exact-source decision matrix

Portal-wide terms are not projected onto an unrelated endpoint. Permission is
asserted only when it is attached to the exact item or supplied directly by the
publisher.

| Tracked file | Exact source endpoint | Publisher of record | Terms that apply | Attribution required | Covers bulk redistribution? |
|---|---|---|---|---|---|
| `phoenix_bus_stops.geojson` | `maps.phoenix.gov/pub/.../BusStops/MapServer/0` | City service containing Valley Metro stop data; ownership of this extract is not stated | No item-specific licence found. City copyright/open-data terms reviewed 2026-08-22 do not grant bulk redistribution for this endpoint. | City attribution is supplied, but attribution alone is not permission. | **No — unresolved; remove absent direct permission.** |
| `valley_metro_phoenix_stops.geojson` | [ArcGIS item `35d5c9ae…`](https://www.arcgis.com/home/item.html?id=35d5c9ae3c26409aa3d1574f110409e7) | `ValleyMetro_GIS`, Valley Metro ArcGIS organisation | Exact-item `licenseInfo`, reviewed 2026-08-22: users may freely share, modify and use the data for any purpose without restriction. | None required by the item; Valley Metro is still attributed as provenance. | **Yes.** |
| `valley_metro_phoenix_stops_2023.geojson` | [ArcGIS item `14920e15…`](https://www.arcgis.com/home/item.html?id=14920e153e6b4afc973f0509b41077e1) | `ValleyMetro_GIS`, Valley Metro ArcGIS organisation | Same unrestricted exact-item grant, reviewed 2026-08-22. | None required by the item; Valley Metro is still attributed as provenance. | **Yes.** |
| `valley_metro_quarterly_ridership.json` | [ArcGIS item `3f5363e0…`](https://www.arcgis.com/home/item.html?id=3f5363e04eb74869aa9c67079318719f) | `ValleyMetro`, Valley Metro ArcGIS organisation | Public item, but `licenseInfo` is empty as reviewed 2026-08-22. | Unknown. | **No — unresolved; remove absent direct permission.** |
| `valley_metro_gtfs.zip` | City of Phoenix Open Data | City of Phoenix | **ODC-BY** | Attribution | **Yes.** |
| `fortyguard_openapi.json` | FortyGuard | FortyGuard | **Not tracked.** Removed from the current tree on 2026-08-23 because no redistribution permission was established and the application does not need it. | Unknown. | **No — remove absent direct permission.** |

**Silence is still not permission.** The two exact Valley Metro grants are
asserted because they are attached to the items themselves. No licence is
asserted for the City or quarterly-ridership extracts, so their raw files are
not tracked. Keeping them would require direct written permission that
explicitly covers the bulk extract.

### What has been done about it

1. A test checks the tracked inventory, the two exact-item grants and the absence
   of the two unresolved raw extracts.
2. Every source URL, query, download timestamp, record count and SHA-256 remains
   recorded in `data/manifests/source-provenance.json` and per-layer metadata.
3. `npm run data:unredistribute` was run on 2026-08-23. It removed only the City
   and quarterly-ridership extracts and kept both licensed Valley Metro layers.
4. The unneeded FortyGuard OpenAPI download was removed from the current tracked
   tree because its redistribution terms are not published.
5. `npm run verify` checks the committed generated-dataset digest and rebuilds
   the GTFS derivative from its licensed archive. A full data regeneration is an
   explicit developer operation after `npm run data:fetch`, not a clean-clone
   verification claim.

### What has deliberately not been done

- **No licence has been invented**, and no permission has been implied from
  silence.
- **No claim of permission for the removed files has been made.** Their URLs,
  queries and historical hashes remain as provenance facts, not redistributed
  source payloads.
- **The 2026-08-23 history rewrite was path-only.** It removed the two payloads
  from every commit reachable from the old `main` branch, but GitHub's read-only
  PR ref retained them. That entire repository is now a private archive. The
  public submission repository was created independently from the clean snapshot
  and begins at one root commit. This does not claim the earlier publication
  never happened, and the pre-sprint work remains disclosed.

### Consequence

The tracked tree and the complete public history are clean. The pending
permission requests also ask whether processed per-stop fields may be
redistributed; any reply and conditions must be recorded, but the two raw
payloads themselves are not present in the public repository. Verification is
network-independent. Full regeneration of the joined dataset requires explicitly
fetching the two excluded source inputs first.

Basemap: OpenFreeMap © OpenMapTiles, data from OpenStreetMap — attributed in the map
control and in `lib/geo/map-style.ts`.
