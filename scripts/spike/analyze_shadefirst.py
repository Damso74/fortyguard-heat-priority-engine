#!/usr/bin/env python3
"""Audit and join the public Phoenix / Valley Metro bus-stop datasets.

This deliberately does not infer that blank or zero amenity fields mean
"unshaded": Phoenix's official totals show that those fields are incomplete.
"""

from __future__ import annotations

import csv
import json
import math
from pathlib import Path
from statistics import median


ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data" / "raw"
OUTPUTS = ROOT / "outputs"


def load_json(path: Path):
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def as_int(value):
    if value in (None, ""):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def haversine_km(a, b):
    lat1, lon1 = math.radians(a[0]), math.radians(a[1])
    lat2, lon2 = math.radians(b[0]), math.radians(b[1])
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * 6371.0088 * math.asin(math.sqrt(h))


def percentile(values, fraction):
    ordered = sorted(values)
    if not ordered:
        return None
    index = (len(ordered) - 1) * fraction
    low = math.floor(index)
    high = math.ceil(index)
    if low == high:
        return ordered[low]
    return ordered[low] * (high - index) + ordered[high] * (index - low)


def greedy_diverse_sample(rows, count=10):
    """Choose high-ridership, spatially varied stops inside one compact AOI."""
    # Roughly 0.10 x 0.10 degrees around central Phoenix: under the documented
    # 50 mi² Premium heatmap limit after a small buffer is added.
    pool = [
        row
        for row in rows
        if 33.40 <= row["latitude"] <= 33.50
        and -112.13 <= row["longitude"] <= -112.03
        and row["ridership"] is not None
        and row["ridership"] > 0
    ]
    if len(pool) < count:
        raise RuntimeError(f"Only {len(pool)} eligible candidate stops")

    max_ridership = max(math.log1p(row["ridership"]) for row in pool)
    chosen = [max(pool, key=lambda row: row["ridership"])]
    remaining = [row for row in pool if row["stop_id"] != chosen[0]["stop_id"]]

    while len(chosen) < count:
        def score(row):
            min_distance = min(
                haversine_km(
                    (row["latitude"], row["longitude"]),
                    (item["latitude"], item["longitude"]),
                )
                for item in chosen
            )
            ridership_score = math.log1p(row["ridership"]) / max_ridership
            distance_score = min(min_distance / 5.0, 1.0)
            return 0.60 * ridership_score + 0.40 * distance_score

        next_row = max(remaining, key=score)
        chosen.append(next_row)
        remaining = [row for row in remaining if row["stop_id"] != next_row["stop_id"]]

    return chosen


def main():
    OUTPUTS.mkdir(parents=True, exist_ok=True)

    city = load_json(DATA / "phoenix_bus_stops.geojson")["features"]
    valley = load_json(DATA / "valley_metro_phoenix_stops.geojson")["features"]
    historical = load_json(DATA / "valley_metro_phoenix_stops_2023.geojson")["features"]

    city_by_stop_id = {
        as_int(feature["properties"].get("STOP_ID")): feature
        for feature in city
        if as_int(feature["properties"].get("STOP_ID")) is not None
    }
    city_by_code = {
        as_int(feature["properties"].get("NEXTRIDEID")): feature
        for feature in city
        if as_int(feature["properties"].get("NEXTRIDEID")) is not None
    }
    old_by_stop_id = {
        as_int(feature["properties"].get("StopID")): feature
        for feature in historical
        if as_int(feature["properties"].get("StopID")) is not None
    }

    joined = []
    direct_matches = 0
    code_only_matches = 0
    no_city_match = 0
    coordinate_deltas_m = []
    matched_city_stop_ids = set()

    for feature in valley:
        props = feature["properties"]
        if props.get("Status") != "Active":
            continue
        stop_id = as_int(props.get("stop_id"))
        stop_code = as_int(props.get("stop_code"))
        city_feature = city_by_stop_id.get(stop_id)
        match_method = "stop_id"
        if city_feature is not None:
            direct_matches += 1
            matched_city_stop_ids.add(as_int(city_feature["properties"].get("STOP_ID")))
        else:
            city_feature = city_by_code.get(stop_code)
            match_method = "stop_code"
            if city_feature is not None:
                code_only_matches += 1
                matched_city_stop_ids.add(as_int(city_feature["properties"].get("STOP_ID")))
            else:
                no_city_match += 1
                match_method = "unmatched"

        longitude, latitude = feature["geometry"]["coordinates"][:2]
        city_props = city_feature["properties"] if city_feature else {}
        old_props = old_by_stop_id.get(stop_id, {}).get("properties", {})

        if city_feature and city_feature.get("geometry"):
            city_lon, city_lat = city_feature["geometry"]["coordinates"][:2]
            coordinate_deltas_m.append(
                haversine_km((latitude, longitude), (city_lat, city_lon)) * 1000
            )

        joined.append(
            {
                "stop_id": stop_id,
                "stop_code": stop_code,
                "name": props.get("stop_name") or "",
                "description": props.get("stop_desc") or "",
                "latitude": latitude,
                "longitude": longitude,
                "routes": props.get("Routes") or "",
                "ridership": as_int(city_props.get("RIDERSHIP")),
                "match_method": match_method,
                "city_nbr_shelters_raw": city_props.get("NBR_SHELTERS"),
                "valley_shelters_raw": props.get("Shelters"),
                "valley_shelter_raw": props.get("Shelter"),
                "valley_shade_raw": props.get("Shade"),
                "historical_photo_url": str(old_props.get("Photo") or "").strip(),
                "shelter_status": "unknown",
            }
        )

    ridership_values = [row["ridership"] for row in joined if row["ridership"] is not None]
    sample = greedy_diverse_sample(joined)
    sample_min_lon = min(row["longitude"] for row in sample)
    sample_max_lon = max(row["longitude"] for row in sample)
    sample_min_lat = min(row["latitude"] for row in sample)
    sample_max_lat = max(row["latitude"] for row in sample)
    sample_mid_lat = (sample_min_lat + sample_max_lat) / 2
    sample_width_km = haversine_km(
        (sample_mid_lat, sample_min_lon), (sample_mid_lat, sample_max_lon)
    )
    sample_height_km = haversine_km(
        (sample_min_lat, sample_min_lon), (sample_max_lat, sample_min_lon)
    )

    joined_path = OUTPUTS / "joined_phoenix_stops.csv"
    with joined_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(joined[0].keys()))
        writer.writeheader()
        writer.writerows(joined)

    sample_path = OUTPUTS / "fortyguard_10_stop_panel.csv"
    with sample_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(sample[0].keys()))
        writer.writeheader()
        writer.writerows(sample)

    metrics = {
        "sources": {
            "phoenix_city_bus_stops": len(city),
            "valley_metro_phoenix_stops": len(valley),
            "valley_metro_active_phoenix_stops": len(joined),
            "historical_valley_metro_phoenix_stops": len(historical),
        },
        "join": {
            "direct_stop_id_matches": direct_matches,
            "stop_code_only_matches": code_only_matches,
            "unmatched_valley_stops": no_city_match,
            "matched_total": direct_matches + code_only_matches,
            "match_rate_pct": round(100 * (direct_matches + code_only_matches) / len(joined), 2),
            "city_records_matched": len(matched_city_stop_ids),
            "city_records_unmatched": len(city) - len(matched_city_stop_ids),
            "city_coverage_pct": round(100 * len(matched_city_stop_ids) / len(city), 2),
            "coordinate_delta_median_m": round(median(coordinate_deltas_m), 2),
            "coordinate_delta_p95_m": round(percentile(coordinate_deltas_m, 0.95), 2),
        },
        "ridership": {
            "joined_non_null": len(ridership_values),
            "joined_completeness_pct": round(100 * len(ridership_values) / len(joined), 2),
            "min": min(ridership_values),
            "median": median(ridership_values),
            "p90": percentile(ridership_values, 0.90),
            "p99": percentile(ridership_values, 0.99),
            "max": max(ridership_values),
            "unit_or_period_documented": False,
        },
        "shelter_inventory": {
            "city_non_null": sum(
                feature["properties"].get("NBR_SHELTERS") is not None for feature in city
            ),
            "city_positive": sum(
                (feature["properties"].get("NBR_SHELTERS") or 0) > 0 for feature in city
            ),
            "valley_positive_integer": sum(
                (feature["properties"].get("Shelters") or 0) > 0 for feature in valley
            ),
            "valley_string_one": sum(
                str(feature["properties"].get("Shelter") or "").strip() == "1"
                for feature in valley
            ),
            "official_sheltered_stop_total_fy2025": 3164,
            "usable_for_unshaded_classification": False,
            "reason": "Published amenity fields contradict Phoenix's official sheltered-stop total.",
        },
        "candidate_panel": {
            "count": len(sample),
            "minimum_pairwise_distance_km": round(
                min(
                    haversine_km(
                        (a["latitude"], a["longitude"]),
                        (b["latitude"], b["longitude"]),
                    )
                    for index, a in enumerate(sample)
                    for b in sample[index + 1 :]
                ),
                3,
            ),
            "bbox": {
                "min_lon": sample_min_lon,
                "min_lat": sample_min_lat,
                "max_lon": sample_max_lon,
                "max_lat": sample_max_lat,
            },
            "approx_bbox_area_sq_km": round(sample_width_km * sample_height_km, 2),
            "approx_bbox_area_sq_mi": round(sample_width_km * sample_height_km / 2.58999, 2),
            "shelter_ground_truth_available": False,
        },
    }

    metrics_path = OUTPUTS / "spike_metrics.json"
    with metrics_path.open("w", encoding="utf-8", newline="") as handle:
        json.dump(metrics, handle, indent=2, ensure_ascii=False)
        handle.write("\n")

    print(json.dumps(metrics, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
