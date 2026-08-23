#!/usr/bin/env python3
"""Build the single dataset the application reads.

This joins four official sources into one record per active Phoenix stop:

1. **Identity and geometry** — Valley Metro *Bus Stops with Amenities*
   (``Juris='Phoenix'``, effective July 2026).
2. **Ridership** — Valley Metro *BusStopQuarterlyRidership*: quarterly average
   daily ridership per stop, split by day category. This replaces the City's
   ``RIDERSHIP`` integer, which publishes no unit and no period; that field is
   retained only as a cross-check under the name ``legacyRidershipIndex``.
3. **Scheduled service** — the official GTFS feed, reduced to departures per
   hour per route on a representative weekday.
4. **Shelter status** — deliberately absent. Hard-coded ``unknown``.

Nothing here is inferred. A stop with no ridership row gets ``null``, not zero;
a stop with no scheduled service gets ``null``, not an empty timetable.

Run after ``fetch_arcgis.py`` and ``fetch_gtfs.py``.
"""

from __future__ import annotations

import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "data" / "raw"
GENERATED = ROOT / "data" / "generated"
MANIFESTS = ROOT / "data" / "manifests"

# ---------------------------------------------------------------------------
# Ridership quarters
# ---------------------------------------------------------------------------
# Valley Metro's quarters are FISCAL (July-June), not calendar. FY2024 Q4 is
# therefore April-June 2024. See the fetcher's known_limitations for the
# evidence; Valley Metro publishes no data dictionary, so this is inferred.
#
# FY2024 Q4 is the latest quarter PASSING THE COMPLETENESS CHECKS BELOW, which
# are run here on every build and whose results are written into the dataset.
# They are this project's own checks: Valley Metro publishes no completeness
# flag, no data dictionary and no revision notice for this layer, so nothing
# independent reconciles them. The two preceding quarters exist so temporal
# drift can be a *sourced* scenario rather than an invented multiplier.
RIDERSHIP_BASE_QUARTER = "2024_4"
RIDERSHIP_QUARTERS = ("2024_4", "2024_3", "2024_2")

QUARTER_LABELS = {
    "2024_4": "FY2024 Q4 — Apr–Jun 2024",
    "2024_3": "FY2024 Q3 — Jan–Mar 2024",
    "2024_2": "FY2024 Q2 — Oct–Dec 2023",
}

DAY_TYPES = ("weekday", "saturday", "sunday")

# Ridership is published for two day categories only. Each analysis day type
# draws from one of them; the weekend average is applied to Saturday and to
# Sunday separately because the source does not split the two.
RIDERSHIP_CATEGORY_FOR_DAY_TYPE = {
    "weekday": "weekday",
    "saturday": "weekend",
    "sunday": "weekend",
}

# ---------------------------------------------------------------------------
# Completeness checks — executable, not prose
# ---------------------------------------------------------------------------
# A quarter passes when it survives both. These are the ONLY grounds on which
# this project calls a quarter usable, and they are deliberately weak claims:
# passing them does not establish that a quarter is complete, only that it does
# not exhibit the two failure signatures that are detectable without an
# independent control total.
#
#   1. TOTAL RETENTION — the Phoenix weekday sum must be at least this share of
#      the largest weekday sum across the quarters examined. Later published
#      quarters fall to 45%, 13% and 6%; a real network does not lose that much
#      ridership between consecutive quarters while its timetable is unchanged.
#   2. REPORTING BREADTH — at least this share of stops that report in the
#      best-covered quarter must also report here. A quarter that keeps its
#      total but loses most of its stops is a partial extract.
MIN_TOTAL_RETENTION = 0.60
MIN_STOP_RETENTION = 0.60


def load_json(path: Path):
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def sha256_of_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def as_int(value):
    if value in (None, ""):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def as_float(value):
    if value in (None, ""):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number == number else None  # reject NaN


def split_routes(value) -> list[str]:
    if not value:
        return []
    text = str(value).replace(";", ",").replace("/", ",")
    return sorted({part.strip() for part in text.split(",") if part.strip()})


def canonical_sha256_of_json_file(path: Path) -> str:
    """Canonical hash of a *generated* JSON artefact.

    The plain file digest of a generated file moves on every rebuild, because
    `generatedAtUtc` sits inside it. Recording that digest here made the dataset's
    own canonical hash depend on a timestamp two files away, so the dataset could
    never reproduce even though nothing about it had changed. Generated inputs
    are therefore referenced by their canonical hash; raw downloads, which carry
    no timestamp, keep their plain file digest.
    """
    with path.open("r", encoding="utf-8") as handle:
        return canonical_sha256(json.load(handle))


def canonical_sha256(document: dict) -> str:
    """Hash of the document with volatile fields removed.

    ``generatedAtUtc`` changes on every run by construction, so a hash including
    it can never be reproduced and is useless as a verification target. The
    canonical hash drops it, sorts keys and fixes separators, so a clean clone
    that re-derives the same data gets the same digest.
    """
    stripped = {key: value for key, value in document.items() if key != "generatedAtUtc"}
    text = json.dumps(stripped, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def available_quarters(rows: list[dict]) -> list[str]:
    """Every quarter the layer publishes an average column for, oldest first."""
    keys = set()
    for row in rows[:50]:
        for key in row.get("properties", {}):
            if key.startswith("avg"):
                keys.add(key[3:])
    return sorted(keys)


def run_completeness_checks(rows: list[dict]) -> dict:
    """Run the documented checks over every published quarter.

    Executable, so the claim "later quarters fail our checks" is regenerated from
    the data on every build rather than asserted from memory in prose. The result
    is written into the dataset and rendered by the product.

    What passing does NOT establish: that a quarter is complete. Without an
    independent control total these checks can only detect the two failure
    signatures below. A quarter under-reporting uniformly across every stop would
    pass both and is undetectable here.
    """
    quarters = available_quarters(rows)
    per_quarter: dict[str, dict] = {}

    for quarter in quarters:
        total = 0.0
        stops_reporting = 0
        for row in rows:
            properties = row["properties"]
            if (properties.get("Day_Category") or "").strip().lower() != "weekday":
                continue
            value = as_float(properties.get(f"avg{quarter}"))
            if value is None:
                continue
            stops_reporting += 1
            total += value
        per_quarter[quarter] = {
            "weekdayTotal": round(total, 1),
            "stopsReporting": stops_reporting,
        }

    best_total = max((entry["weekdayTotal"] for entry in per_quarter.values()), default=0.0)
    best_stops = max((entry["stopsReporting"] for entry in per_quarter.values()), default=0)

    for quarter, entry in per_quarter.items():
        total_retention = entry["weekdayTotal"] / best_total if best_total > 0 else 0.0
        stop_retention = entry["stopsReporting"] / best_stops if best_stops > 0 else 0.0
        failures = []
        if total_retention < MIN_TOTAL_RETENTION:
            failures.append(
                f"weekday total is {total_retention:.0%} of the best quarter "
                f"(minimum {MIN_TOTAL_RETENTION:.0%})"
            )
        if stop_retention < MIN_STOP_RETENTION:
            failures.append(
                f"only {stop_retention:.0%} of the best quarter's reporting stops appear "
                f"(minimum {MIN_STOP_RETENTION:.0%})"
            )
        entry["totalRetention"] = round(total_retention, 4)
        entry["stopRetention"] = round(stop_retention, 4)
        entry["passes"] = not failures
        entry["failures"] = failures

    passing = [quarter for quarter, entry in per_quarter.items() if entry["passes"]]
    latest_passing = max(passing) if passing else None

    return {
        "checks": {
            "minTotalRetention": MIN_TOTAL_RETENTION,
            "minStopRetention": MIN_STOP_RETENTION,
            "description": "A quarter passes when its Phoenix weekday total and its count of "
                           "reporting stops both stay within the stated share of the "
                           "best-covered quarter examined.",
            "whatPassingDoesNotEstablish": "That the quarter is complete. Without an independent "
                                           "control total these checks detect only partial "
                                           "extracts and collapsed totals; a quarter that "
                                           "under-reports uniformly across every stop passes both "
                                           "and is undetectable here. Valley Metro publishes no "
                                           "completeness flag, no data dictionary and no revision "
                                           "notice for this layer.",
            "independentlyReconciled": False,
        },
        "quarters": per_quarter,
        "latestPassing": latest_passing,
        "selected": RIDERSHIP_BASE_QUARTER,
        "selectedIsLatestPassing": latest_passing == RIDERSHIP_BASE_QUARTER,
    }


def main() -> None:
    GENERATED.mkdir(parents=True, exist_ok=True)
    MANIFESTS.mkdir(parents=True, exist_ok=True)

    city_path = RAW / "phoenix_bus_stops.geojson"
    valley_path = RAW / "valley_metro_phoenix_stops.geojson"
    ridership_path = RAW / "valley_metro_quarterly_ridership.json"
    frequency_path = GENERATED / "stop_service_frequency.json"

    for path in (city_path, valley_path, ridership_path, frequency_path):
        if not path.exists():
            raise SystemExit(f"Missing {path.relative_to(ROOT)} — run the fetch scripts first")

    city = load_json(city_path)["features"]
    valley = load_json(valley_path)["features"]
    ridership_rows = load_json(ridership_path)["features"]
    frequency = load_json(frequency_path)

    if frequency.get("version") != 2 or set(frequency.get("dayTypes", [])) != set(DAY_TYPES):
        raise SystemExit(
            "stop_service_frequency.json is not the per-day-type format. "
            "Run: python scripts/fetch/fetch_gtfs.py --rebuild"
        )

    completeness = run_completeness_checks(ridership_rows)
    selected = completeness["quarters"].get(RIDERSHIP_BASE_QUARTER, {})
    if not selected.get("passes", False):
        raise SystemExit(
            f"Base quarter {RIDERSHIP_BASE_QUARTER} fails the completeness checks: "
            f"{'; '.join(selected.get('failures', []))}"
        )
    # stderr: stdout carries only the JSON summary, which the reproducibility
    # check parses for the canonical hash.
    print(
        f"[dataset] completeness: latest passing quarter = {completeness['latestPassing']}, "
        f"selected = {RIDERSHIP_BASE_QUARTER}",
        file=sys.stderr,
    )

    # ---- index the City layer (legacy cross-check only) --------------------
    city_by_stop_id = {}
    city_by_code = {}
    for feature in city:
        properties = feature["properties"]
        stop_id = as_int(properties.get("STOP_ID"))
        if stop_id is not None:
            city_by_stop_id[stop_id] = feature
        code = as_int(properties.get("NEXTRIDEID"))
        if code is not None:
            city_by_code[code] = feature

    # ---- index documented ridership ----------------------------------------
    # stop_id -> quarter -> day category -> average daily riders
    ridership_by_stop: dict[int, dict[str, dict[str, float | None]]] = {}
    ridership_rows_discarded = 0
    for row in ridership_rows:
        properties = row["properties"]
        stop_id = as_int(properties.get("StopID"))
        category = (properties.get("Day_Category") or "").strip().lower()
        if stop_id is None or category not in {"weekday", "weekend"}:
            ridership_rows_discarded += 1
            continue
        bucket = ridership_by_stop.setdefault(
            stop_id, {quarter: {"weekday": None, "weekend": None} for quarter in RIDERSHIP_QUARTERS}
        )
        for quarter in RIDERSHIP_QUARTERS:
            # Published as strings; parsed here, never by the ArcGIS server,
            # whose numeric statistics silently return zero on a string column.
            bucket[quarter][category] = as_float(properties.get(f"avg{quarter}"))

    # ---- index scheduled service -------------------------------------------
    service_by_stop = frequency["stops"]

    # ---- build ---------------------------------------------------------------
    stops = []
    matched_ridership = 0
    matched_service = 0

    for feature in valley:
        properties = feature["properties"]
        if properties.get("Status") != "Active":
            continue

        stop_id = as_int(properties.get("stop_id"))
        stop_code = as_int(properties.get("stop_code"))

        geometry = feature.get("geometry") or {}
        coordinates = geometry.get("coordinates") or []
        if len(coordinates) < 2:
            raise RuntimeError(f"Stop {stop_id} has no usable geometry")
        longitude, latitude = float(coordinates[0]), float(coordinates[1])
        if not (-180 <= longitude <= 180 and -90 <= latitude <= 90):
            raise RuntimeError(f"Stop {stop_id} has out-of-range coordinates")

        city_feature = city_by_stop_id.get(stop_id) or city_by_code.get(stop_code)
        match_method = (
            "stop_id" if city_by_stop_id.get(stop_id)
            else "stop_code" if city_by_code.get(stop_code)
            else "unmatched"
        )
        city_properties = city_feature["properties"] if city_feature else {}

        # A row can exist while the published quarter is blank for both day
        # categories. That is "no ridership", not an empty object: emitting a
        # record with two nulls would make the field look present downstream.
        # A row can exist while the base quarter is blank for both day
        # categories. That is "no ridership", not an empty object.
        raw_rider = ridership_by_stop.get(stop_id)
        rider = None
        if raw_rider is not None:
            base = raw_rider.get(RIDERSHIP_BASE_QUARTER) or {}
            if base.get("weekday") is not None or base.get("weekend") is not None:
                rider = {
                    "baseQuarter": RIDERSHIP_BASE_QUARTER,
                    "byQuarter": {
                        quarter: {
                            "weekday": raw_rider[quarter]["weekday"],
                            "weekend": raw_rider[quarter]["weekend"],
                        }
                        for quarter in RIDERSHIP_QUARTERS
                    },
                }
                matched_ridership += 1

        # Service is carried PER DAY TYPE. Pairing a weekend ridership average
        # with a weekday timetable was a real defect: Saturday runs 5,476 trips
        # against a weekday's 7,854, so a weekend rider's wait is materially
        # longer than the weekday schedule implies.
        service_entry = service_by_stop.get(str(stop_id))
        service = None
        if service_entry:
            by_day_type = {}
            for day_type in DAY_TYPES:
                profile = service_entry.get(day_type)
                if not profile:
                    continue
                by_day_type[day_type] = {
                    "dailyDepartures": profile["dailyDepartures"],
                    "routeCount": profile["routeCount"],
                    "hourlyDepartures": profile["hourlyDepartures"],
                    # Scheduled departure minutes past the START OF THE SERVICE
                    # DAY, per route. Values >= 1440 are genuine GTFS times of
                    # 24:00 or later; the projection onto clock hours happens in
                    # lib/metrics/exposure.ts where it is a named assumption.
                    "routeDepartures": profile["byRoute"],
                    "departuresAfterMidnight": profile["departuresAfterMidnight"],
                }
            if by_day_type:
                matched_service += 1
                service = {"byDayType": by_day_type}

        stops.append(
            {
                "id": stop_id,
                "code": stop_code,
                "name": (properties.get("stop_name") or "").strip(),
                "description": (properties.get("stop_desc") or "").strip(),
                "lat": round(latitude, 6),
                "lon": round(longitude, 6),
                "routes": split_routes(properties.get("Routes")),
                "ridership": rider,
                "service": service,
                # The City's undocumented integer. Kept only so the two can be
                # compared; never used to compute anything.
                "legacyRidershipIndex": as_int(city_properties.get("RIDERSHIP")),
                "matchMethod": match_method,
                "shelterStatus": "unknown",
            }
        )

    stops.sort(key=lambda row: (row["id"] is None, row["id"] or 0))

    latitudes = [row["lat"] for row in stops]
    longitudes = [row["lon"] for row in stops]
    weekday_values = [
        row["ridership"]["byQuarter"][RIDERSHIP_BASE_QUARTER]["weekday"]
        for row in stops
        if row["ridership"]
        and row["ridership"]["byQuarter"][RIDERSHIP_BASE_QUARTER]["weekday"] is not None
    ]

    document = {
        "kind": "heat-priority-engine/transit-stops",
        "version": 2,
        "generatedAtUtc": datetime.now(timezone.utc).isoformat(),
        "generator": "scripts/generate/build_analysis_dataset.py",
        "provenance": {
            "geometryAndIdentity": {
                "source": "Valley Metro — Bus Stops with Amenities (Juris='Phoenix')",
                "file": "data/raw/valley_metro_phoenix_stops.geojson",
                "sha256": sha256_of_file(valley_path),
                "classification": "REAL",
            },
            "ridership": {
                "source": "Valley Metro — Ridership.dbo.BusStopQuarterlyRidership "
                          "(BusRidershipByQuarterForPortal/6), field "
                          f"avg{RIDERSHIP_BASE_QUARTER}",
                "file": "data/raw/valley_metro_quarterly_ridership.json",
                "sha256": sha256_of_file(ridership_path),
                "classification": "REAL",
                "unit": "average daily riders per stop",
                "baseQuarter": RIDERSHIP_BASE_QUARTER,
                "baseQuarterLabel": QUARTER_LABELS[RIDERSHIP_BASE_QUARTER],
                "quartersAvailable": {q: QUARTER_LABELS[q] for q in RIDERSHIP_QUARTERS},
                "fiscalYearNote": "Quarters are FISCAL (July-June), not calendar. Inferred from "
                                  "the sibling layer RidershipDataPortal_Bus, whose earliest "
                                  "quarter Q2015_2 aligns with its own description 'bus stops as "
                                  "of October 27, 2014' only under a July-June year. Valley Metro "
                                  "publishes no data dictionary for the field.",
                "quarterSelection": "The base quarter is the latest quarter passing the "
                                    "completeness checks recorded under completenessChecks. Those "
                                    "checks are this project's own and are NOT independently "
                                    "reconciled; passing them does not establish that the quarter "
                                    "is complete.",
                "completenessChecks": completeness,
                "periodMismatch": "The ridership period (Apr-Jun 2024) does not match the GTFS "
                                  "schedule (July 2026) or the thermal analysis date. This is the "
                                  "temporal-drift scenario dimension, not a rounding error.",
                "caveat": "The layer does not state whether a value counts boardings only or "
                          "boardings plus alightings. Exposure estimates built on it are an upper "
                          "bound if alightings are included, since alighting riders do not wait.",
            },
            "scheduledService": {
                "source": "Valley Metro GTFS static, via City of Phoenix Open Data (ODC-BY)",
                "file": "data/generated/stop_service_frequency.json",
                # Canonical, not the plain file digest: the file carries its own
                # generatedAtUtc, and referencing that here made this dataset's
                # hash depend on a timestamp two files away.
                "canonicalSha256": canonical_sha256_of_json_file(frequency_path),
                "classification": "REAL",
                "unit": "scheduled departure minutes past the start of the service day, per route, "
                        "for each of three day types",
                "dayTypes": list(DAY_TYPES),
                "servicePatterns": frequency["definitions"]["servicePatterns"],
                "dayTypeNote": "weekday / saturday / sunday are extracted separately. Weekend "
                               "ridership is never paired with a weekday timetable. The service "
                               "pattern for each day type is the MOST FREQUENT active-service set "
                               "across the dates of that day type, not the date with the most "
                               "trips.",
                "caveat": "Scheduled service, not observed service. Real-time deviation, "
                          "cancellations and detours are not represented.",
            },
            "legacyRidershipIndex": {
                "source": "City of Phoenix — Bus Stops, field RIDERSHIP",
                "file": "data/raw/phoenix_bus_stops.geojson",
                "sha256": sha256_of_file(city_path),
                "classification": "REAL",
                "unit": None,
                "period": None,
                "caveat": "No unit, period or collection date is published. Retained as a "
                          "cross-check only; no product value is computed from it.",
            },
            "shelterStatus": {
                "source": None,
                "classification": "UNKNOWN",
                "caveat": "Published amenity fields contradict Phoenix's own sheltered-stop "
                          "total (3164 in FY2024-25). No null or zero is read as 'no shelter'.",
            },
        },
        "counts": {
            "activeStops": len(stops),
            "withDocumentedRidership": matched_ridership,
            "withScheduledService": matched_service,
            "ridershipCoveragePct": round(100 * matched_ridership / len(stops), 2),
            "serviceCoveragePct": round(100 * matched_service / len(stops), 2),
            "weekdayRidershipSum": round(sum(weekday_values), 1),
            "shelterStatusKnown": 0,
            "ridershipRowsDiscarded": ridership_rows_discarded,
            "serviceCoverageByDayType": {
                day_type: sum(
                    1 for row in stops if row["service"] and day_type in row["service"]["byDayType"]
                )
                for day_type in DAY_TYPES
            },
        },
        "dayTypes": {
            "analysed": list(DAY_TYPES),
            "ridershipCategory": RIDERSHIP_CATEGORY_FOR_DAY_TYPE,
            "note": "Each analysis day type pairs its OWN timetable with the ridership category "
                    "the source publishes for it. The published Weekend average is applied to "
                    "Saturday and to Sunday separately because Valley Metro does not split the "
                    "two; the timetables are genuinely different (Saturday 5,476 trips, Sunday "
                    "4,815).",
        },
        "bbox": {
            "minLon": min(longitudes),
            "minLat": min(latitudes),
            "maxLon": max(longitudes),
            "maxLat": max(latitudes),
        },
        "stops": stops,
    }

    destination = GENERATED / "phoenix_transit_stops.json"
    text = json.dumps(document, ensure_ascii=False, separators=(",", ":")) + "\n"
    destination.write_text(text, encoding="utf-8", newline="")

    manifest = {
        "generatedAtUtc": document["generatedAtUtc"],
        "artifact": {
            "path": "data/generated/phoenix_transit_stops.json",
            # `sha256` is the digest of the file as written and therefore moves
            # with generatedAtUtc. `canonicalSha256` drops that field and is the
            # value a clean-clone rebuild must reproduce; it is what the
            # verification step and CI compare.
            "sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
            "canonicalSha256": canonical_sha256(document),
            "bytes": len(text.encode("utf-8")),
            "records": len(stops),
        },
        "derivedFrom": [
            {"path": "data/raw/valley_metro_phoenix_stops.geojson", "sha256": sha256_of_file(valley_path)},
            {"path": "data/raw/valley_metro_quarterly_ridership.json", "sha256": sha256_of_file(ridership_path)},
            {
                "path": "data/generated/stop_service_frequency.json",
                "canonicalSha256": canonical_sha256_of_json_file(frequency_path),
            },
            {"path": "data/raw/phoenix_bus_stops.geojson", "sha256": sha256_of_file(city_path)},
        ],
    }
    (MANIFESTS / "generated-dataset.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline=""
    )

    print(json.dumps({**document["counts"],
                      "canonicalSha256": manifest["artifact"]["canonicalSha256"],
                      "bytes": manifest["artifact"]["bytes"]}, indent=2))


if __name__ == "__main__":
    main()
