#!/usr/bin/env python3
"""FortyGuard capability planner and response parser. It performs no submission.

This script used to submit. It had its own ``urllib`` POST to ``/v1/heatmap``, its
own polling loop, and its own capture routine that walked the tile plan and bought
every tile — a complete second implementation of the one operation in this project
that spends money, sitting alongside the TypeScript one in ``lib/fortyguard/``.

Two implementations of a billable path is one too many. Every safety property the
capture engine gained — the single-shot POST, the submission budget, the intent
journal, the cross-process lock, the ambiguity stop — existed in exactly one of
them, and this was the other one.

So this file no longer talks to the network at all. There is one submission path
in this repository and it is ``scripts/fortyguard/capture.mjs`` →
``lib/fortyguard/capture.ts``. What remains here is the half of the probe that
never needed a socket:

**Plan** (default) — build the tile plan for the ten-stop panel, apply the
timezone strategy from the capability manifest, and print the exact request bodies
a capture would submit together with the billable count. Useful for reviewing a
capture before authorising it, and for checking that every panel stop falls inside
a tile.

**Parse** (``--parse FILE``) — read responses that were already captured and
answer the capability questions from them: which property carries the value, how
well covered it is, what the observed spread looks like, and — when the bundle
contains two readings taken at different local hours — what the pair implies about
which timezone ``start_time`` was interpreted in.

Neither mode needs, reads or accepts an API key.

The answers this produces are transcribed into
``data/manifests/fortyguard-capability.json`` **by a human**, deliberately. That
file gates whether the product may say "°C", and nothing automatic should be able
to flip it.

Usage::

    python scripts/fortyguard/run_fortyguard_probe.py
    python scripts/fortyguard/run_fortyguard_probe.py --date 2026-08-03 --max-tile-sq-mi 9
    python scripts/fortyguard/run_fortyguard_probe.py --parse outputs/fortyguard_raw_capture.json
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import statistics
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

try:  # Python 3.9+
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover - the project pins 3.11
    ZoneInfo = None


ROOT = Path(__file__).resolve().parents[2]
PANEL = ROOT / "outputs" / "fortyguard_10_stop_panel.csv"
OUTPUTS = ROOT / "outputs"
CAPABILITY = ROOT / "data" / "manifests" / "fortyguard-capability.json"

# America/Phoenix is UTC-7 all year: Arizona does not observe daylight saving.
# Resolved through the IANA database where available so the constant is a
# fallback rather than the source of truth.
PHOENIX_ZONE = "America/Phoenix"
PHOENIX_FALLBACK = timezone(timedelta(hours=-7), PHOENIX_ZONE)

EARTH_RADIUS_M = 6_371_008.8
SQ_M_PER_SQ_MI = 2_589_988.110336

# Closed whitelist, ordered by specificity. Mirrors lib/fortyguard/value-field.ts.
TCM_FIELD_WHITELIST = (
    "tcm",
    "temperature_celsius",
    "temperature_c",
    "temp_celsius",
    "temp_c",
    "air_temperature",
    "ambient_temperature",
    "temperature",
    "temp",
)

MIN_FIELD_COVERAGE = 0.9


def phoenix_tz():
    if ZoneInfo is not None:
        try:
            return ZoneInfo(PHOENIX_ZONE)
        except Exception:  # noqa: BLE001 - tzdata may be absent on a bare image
            pass
    return PHOENIX_FALLBACK


# --------------------------------------------------------------------------- #
# Geometry
# --------------------------------------------------------------------------- #

def haversine_m(a, b):
    lat1, lon1 = math.radians(a[0]), math.radians(a[1])
    lat2, lon2 = math.radians(b[0]), math.radians(b[1])
    h = (
        math.sin((lat2 - lat1) / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    )
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(h))


def bbox_area_sq_mi(bbox):
    min_lon, min_lat, max_lon, max_lat = bbox
    mid_lat = (min_lat + max_lat) / 2
    width = haversine_m((mid_lat, min_lon), (mid_lat, max_lon))
    height = haversine_m((min_lat, min_lon), (max_lat, min_lon))
    return width * height / SQ_M_PER_SQ_MI


def _layout(bbox, rows, cols):
    min_lon, min_lat, max_lon, max_lat = bbox
    lon_edges = [
        max_lon if col == cols else min_lon + col * (max_lon - min_lon) / cols
        for col in range(cols + 1)
    ]
    lat_edges = [
        max_lat if row == rows else min_lat + row * (max_lat - min_lat) / rows
        for row in range(rows + 1)
    ]
    return [
        (lon_edges[col], lat_edges[row], lon_edges[col + 1], lat_edges[row + 1])
        for row in range(rows)
        for col in range(cols)
    ]


def plan_tiles(bbox, max_sq_mi):
    """Partition the bbox into tiles, each under the ceiling. No gaps, no overlaps."""
    min_lon, min_lat, max_lon, max_lat = bbox
    mid_lat = (min_lat + max_lat) / 2
    width_m = haversine_m((mid_lat, min_lon), (mid_lat, max_lon))
    height_m = haversine_m((min_lat, min_lon), (max_lat, min_lon))
    aspect = width_m / height_m if height_m else 1.0

    cols = rows = 1
    for _ in range(4096):
        tiles = _layout(bbox, rows, cols)
        if max(bbox_area_sq_mi(tile) for tile in tiles) <= max_sq_mi:
            break
        if aspect * (rows / cols) >= 1:
            cols += 1
        else:
            rows += 1
    tiles = _layout(bbox, rows, cols)

    oversized = [tile for tile in tiles if bbox_area_sq_mi(tile) > max_sq_mi + 1e-9]
    if oversized:
        raise RuntimeError(
            f"Tile {oversized[0]} is {bbox_area_sq_mi(oversized[0]):.3f} mi2, above the "
            f"ceiling of {max_sq_mi} mi2. Refusing to plan it."
        )
    return tiles, rows, cols


def ring_for(bbox):
    min_lon, min_lat, max_lon, max_lat = bbox
    return [
        [min_lon, min_lat],
        [max_lon, min_lat],
        [max_lon, max_lat],
        [min_lon, max_lat],
        [min_lon, min_lat],
    ]


def point_in_ring(lon, lat, ring):
    inside = False
    previous = ring[-1]
    for current in ring:
        x1, y1 = previous[:2]
        x2, y2 = current[:2]
        if (y1 > lat) != (y2 > lat):
            crossing = (x2 - x1) * (lat - y1) / (y2 - y1) + x1
            if lon < crossing:
                inside = not inside
        previous = current
    return inside


def point_in_geometry(lon, lat, geometry):
    kind = (geometry or {}).get("type")
    coordinates = (geometry or {}).get("coordinates") or []
    polygons = (
        [coordinates] if kind == "Polygon" else coordinates if kind == "MultiPolygon" else []
    )
    for polygon in polygons:
        if not polygon or not point_in_ring(lon, lat, polygon[0]):
            continue
        if any(point_in_ring(lon, lat, hole) for hole in polygon[1:]):
            continue
        return True
    return False


def ring_centroid(ring):
    twice_area = x = y = 0.0
    for index in range(len(ring)):
        x1, y1 = ring[index - 1][:2]
        x2, y2 = ring[index][:2]
        cross = x1 * y2 - x2 * y1
        twice_area += cross
        x += (x1 + x2) * cross
        y += (y1 + y2) * cross
    if abs(twice_area) < 1e-12:
        return (
            sum(vertex[0] for vertex in ring) / len(ring),
            sum(vertex[1] for vertex in ring) / len(ring),
        )
    return x / (3 * twice_area), y / (3 * twice_area)


# --------------------------------------------------------------------------- #
# Response shape                                                              #
# --------------------------------------------------------------------------- #

def find_feature_collection(value, path="$", depth=0):
    if depth > 8:
        return None, None
    if isinstance(value, dict):
        if value.get("type") == "FeatureCollection" and isinstance(value.get("features"), list):
            return value, path
        for key, child in value.items():
            found, found_path = find_feature_collection(child, f"{path}.{key}", depth + 1)
            if found is not None:
                return found, found_path
    elif isinstance(value, list):
        for index, child in enumerate(value):
            found, found_path = find_feature_collection(child, f"{path}[{index}]", depth + 1)
            if found is not None:
                return found, found_path
    return None, None


# --------------------------------------------------------------------------- #
# Value field                                                                 #
# --------------------------------------------------------------------------- #

def resolve_value_field(features, override=None):
    """Closed whitelist. Fails on ambiguity rather than picking one.

    Note what this does and does not establish. It identifies **which property to
    read**. It does not establish that the property is a temperature, and it does
    not establish a unit. Those are separate questions with separate flags in the
    capability manifest, answered by a human reading the evidence below.
    """
    observed = sorted({key for feature in features for key in (feature.get("properties") or {})})

    def coverage(name):
        numeric = sum(
            isinstance((feature.get("properties") or {}).get(name), (int, float))
            and not isinstance((feature.get("properties") or {}).get(name), bool)
            for feature in features
        )
        return numeric / len(features) if features else 0.0

    if override:
        if override not in observed:
            raise RuntimeError(f"Override field {override!r} absent. Observed: {observed}")
        found = coverage(override)
        if found < MIN_FIELD_COVERAGE:
            raise RuntimeError(
                f"Override field {override!r} is numeric on only {found:.1%} of features"
            )
        return override, found, "override", observed

    qualified = [
        (name, coverage(name))
        for name in TCM_FIELD_WHITELIST
        if name in observed and coverage(name) >= MIN_FIELD_COVERAGE
    ]

    if not qualified:
        raise RuntimeError(
            "No whitelisted tcm value field found.\n"
            f"  whitelist: {', '.join(TCM_FIELD_WHITELIST)}\n"
            f"  observed : {', '.join(observed) or '(none)'}\n"
            "Re-run with --temperature-field <name> once you have confirmed the correct one."
        )
    if len(qualified) > 1:
        raise RuntimeError(
            f"Ambiguous value field: {', '.join(name for name, _ in qualified)} all qualify. "
            "Refusing to guess. Re-run with --temperature-field <name>."
        )
    return qualified[0][0], qualified[0][1], "whitelist", observed


# --------------------------------------------------------------------------- #
# Statistics                                                                  #
# --------------------------------------------------------------------------- #

def percentile(values, fraction):
    if not values:
        return None
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    position = fraction * (len(ordered) - 1)
    low = math.floor(position)
    high = math.ceil(position)
    if low == high:
        return ordered[low]
    return ordered[low] + (ordered[high] - ordered[low]) * (position - low)


def ranks(values):
    order = sorted(range(len(values)), key=lambda index: values[index])
    output = [0.0] * len(values)
    index = 0
    while index < len(order):
        end = index
        while end + 1 < len(order) and values[order[end + 1]] == values[order[index]]:
            end += 1
        average = (index + end) / 2 + 1
        for position in range(index, end + 1):
            output[order[position]] = average
        index = end + 1
    return output


def spearman(left, right):
    if len(left) < 2 or len(left) != len(right):
        return None
    x, y = ranks(left), ranks(right)
    x_mean, y_mean = statistics.mean(x), statistics.mean(y)
    numerator = sum((a - x_mean) * (b - y_mean) for a, b in zip(x, y))
    denominator = math.sqrt(
        sum((a - x_mean) ** 2 for a in x) * sum((b - y_mean) ** 2 for b in y)
    )
    return None if denominator == 0 else numerator / denominator


# --------------------------------------------------------------------------- #
# Timezone strategy — the same two strategies lib/fortyguard/timezone.ts applies #
# --------------------------------------------------------------------------- #

def apply_timezone_strategy(strategy, analysis_date, local_time):
    """Return what would actually be transmitted for one requested local hour.

    The civil DATE is recomputed from the instant, not carried over: 19:00 on
    3 August in Phoenix is 02:00 on 4 August UTC, and converting the time while
    keeping the date is a bug that only shows itself either side of midnight.
    """
    hour, minute = (int(part) for part in local_time.split(":"))
    year, month, day = (int(part) for part in analysis_date.split("-"))
    local = datetime(year, month, day, hour, minute, tzinfo=phoenix_tz())
    as_utc = local.astimezone(timezone.utc)

    if strategy == "convert_to_utc":
        transmitted_date = as_utc.date().isoformat()
        transmitted_time = as_utc.strftime("%H:%M")
    else:
        transmitted_date = analysis_date
        transmitted_time = local_time

    return {
        "requested_local_date": analysis_date,
        "requested_local_time": local_time,
        "requested_local_iso": local.isoformat(),
        "transmitted_date": transmitted_date,
        "transmitted_time": transmitted_time,
        "transmitted_iso_utc": as_utc.isoformat().replace("+00:00", "Z"),
        "crosses_day_boundary": transmitted_date != analysis_date,
    }


# --------------------------------------------------------------------------- #
# Input                                                                       #
# --------------------------------------------------------------------------- #

def phoenix_today():
    return datetime.now(phoenix_tz()).date()


def load_panel():
    if not PANEL.exists():
        raise SystemExit(
            f"Missing {PANEL.relative_to(ROOT)}. "
            "Run `python scripts/spike/analyze_shadefirst.py` first."
        )
    with PANEL.open("r", encoding="utf-8", newline="") as handle:
        rows = list(csv.DictReader(handle))

    stops = []
    seen = set()
    for row in rows:
        if row["stop_id"] in seen:
            continue
        seen.add(row["stop_id"])
        row["latitude"] = float(row["latitude"])
        row["longitude"] = float(row["longitude"])
        row["ridership"] = int(row["ridership"])
        stops.append(row)
    return stops


def load_capability():
    with CAPABILITY.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def parse_args():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--date",
        help="Reference date YYYY-MM-DD, interpreted as America/Phoenix. "
             "Default: yesterday in Phoenix, which is always fully historical.",
    )
    parser.add_argument("--time", action="append", dest="times",
                        help="Snapshot time HH:MM; repeat. Default 11:00, 14:00, 17:00.")
    parser.add_argument("--temperature-field",
                        help="Property to read when parsing. Selects a FIELD only: it does not "
                             "establish that the field is a temperature, and it does not "
                             "establish a unit. Those are separate manifest flags.")
    parser.add_argument("--granularity", type=int, choices=(60, 80, 100), default=60)
    parser.add_argument("--max-tile-sq-mi", type=float, default=9.0,
                        help="Conservative ceiling below the smallest documented plan limit (10 mi2).")
    parser.add_argument("--parse", metavar="FILE",
                        help="Answer the capability questions from responses already captured. "
                             "Reads a JSON file; makes no request.")
    parser.add_argument("--out", metavar="FILE",
                        help="Where to write the JSON report. Defaults under outputs/.")
    args = parser.parse_args()
    if not args.times:
        args.times = ["11:00", "14:00", "17:00"]
    if not args.date:
        args.date = (phoenix_today() - timedelta(days=1)).isoformat()
    return args


# --------------------------------------------------------------------------- #
# Plan                                                                        #
# --------------------------------------------------------------------------- #

def build_plan(args, stops, capability):
    lons = [stop["longitude"] for stop in stops]
    lats = [stop["latitude"] for stop in stops]
    margin = 0.01
    bbox = (min(lons) - margin, min(lats) - margin, max(lons) + margin, max(lats) + margin)

    tiles, rows, cols = plan_tiles(bbox, args.max_tile_sq_mi)
    strategy = capability["timezone"]["strategy"]
    schedule = [apply_timezone_strategy(strategy, args.date, time) for time in args.times]

    uncovered = [
        stop["stop_id"]
        for stop in stops
        if not any(
            point_in_ring(stop["longitude"], stop["latitude"], ring_for(tile)) for tile in tiles
        )
    ]

    requests = []
    for entry in schedule:
        for index, tile in enumerate(tiles):
            requests.append(
                {
                    "tile": index,
                    "requested_local_time": entry["requested_local_time"],
                    "body": {
                        "polygon_aoi": {
                            "type": "FeatureCollection",
                            "features": [
                                {
                                    "type": "Feature",
                                    "properties": {},
                                    "geometry": {
                                        "type": "Polygon",
                                        "coordinates": [ring_for(tile)],
                                    },
                                }
                            ],
                        },
                        "date_time": {
                            "start_date": entry["transmitted_date"],
                            "start_time": entry["transmitted_time"],
                            "filter_type": 1,
                        },
                        "granularity": args.granularity,
                        "analytic_type": "tcm",
                    },
                }
            )

    return {
        "kind": "heat-priority-engine/fortyguard-request-plan",
        "generated_by": "scripts/fortyguard/run_fortyguard_probe.py",
        "submits": False,
        "analysis_date": args.date,
        "timezone": PHOENIX_ZONE,
        "timezone_strategy": strategy,
        "timezone_strategy_confirmed": capability["timezone"]["confirmed"],
        "granularity_meters": args.granularity,
        "max_tile_sq_mi": args.max_tile_sq_mi,
        "tile_grid": {"rows": rows, "cols": cols},
        "tiles": [
            {"index": index, "bbox": list(tile), "area_sq_mi": round(bbox_area_sq_mi(tile), 3)}
            for index, tile in enumerate(tiles)
        ],
        "stops": len(stops),
        "stops_outside_every_tile": uncovered,
        "schedule": schedule,
        "billable_submissions": len(requests),
        "requests": requests,
    }


def report_plan(plan):
    print(f"analysis date       {plan['analysis_date']} ({plan['timezone']})")
    print(
        f"timezone strategy   {plan['timezone_strategy']}"
        f" ({'confirmed' if plan['timezone_strategy_confirmed'] else 'UNCONFIRMED'})"
    )
    print(
        f"tiles               {len(plan['tiles'])}"
        f" ({plan['tile_grid']['rows']}x{plan['tile_grid']['cols']})"
        f" at <= {plan['max_tile_sq_mi']} mi2"
    )
    print(f"stops               {plan['stops']}")
    print(f"billable submissions {plan['billable_submissions']}")
    print("\nrequest plan (local hour -> transmitted):")
    for entry in plan["schedule"]:
        print(
            f"  {entry['requested_local_time']} {entry['requested_local_iso']}"
            f"  ->  start_date={entry['transmitted_date']} start_time={entry['transmitted_time']}"
            f"  ({entry['transmitted_iso_utc']})"
            + ("  [crosses the civil day]" if entry["crosses_day_boundary"] else "")
        )

    if plan["stops_outside_every_tile"]:
        print(
            "\nFAIL: these panel stops fall outside every tile: "
            + ", ".join(plan["stops_outside_every_tile"])
        )
        return 1

    print(
        "\nNothing was submitted: this script has no network code. To actually capture, review the\n"
        "plan above and then run, deliberately:\n\n"
        "  npm run fortyguard:capture -- --aoi central-phoenix --date "
        f"{plan['analysis_date']} \\\n"
        "      --confirm-spend --max-new-submissions "
        f"{plan['billable_submissions']}\n"
    )
    return 0


# --------------------------------------------------------------------------- #
# Parse                                                                       #
# --------------------------------------------------------------------------- #

def readings_from(document):
    """Accept either a list of labelled readings or a single raw status payload."""
    if isinstance(document, list):
        return [
            {
                "label": str(entry.get("label") or entry.get("start_time") or index),
                "payload": entry.get("response", entry),
            }
            for index, entry in enumerate(document)
        ]
    if isinstance(document, dict) and isinstance(document.get("readings"), list):
        return readings_from(document["readings"])
    return [{"label": "single", "payload": document}]


def parse_bundle(path, override):
    with Path(path).open("r", encoding="utf-8") as handle:
        document = json.load(handle)

    results = []
    for reading in readings_from(document):
        collection, found_at = find_feature_collection(reading["payload"])
        entry = {
            "label": reading["label"],
            "feature_collection_path": found_at,
            "features": 0,
            "observed_properties": [],
            "value_field": None,
            "value_field_source": None,
            "value_field_coverage": None,
            "mean_value": None,
            "p10": None,
            "p90": None,
            "error": None,
        }
        if collection is None:
            entry["error"] = "no FeatureCollection found in this payload"
            results.append(entry)
            continue

        features = collection.get("features") or []
        entry["features"] = len(features)
        try:
            field, coverage, source, observed = resolve_value_field(features, override)
        except RuntimeError as error:
            entry["error"] = str(error)
            entry["observed_properties"] = sorted(
                {key for feature in features for key in (feature.get("properties") or {})}
            )
            results.append(entry)
            continue

        values = [
            (feature.get("properties") or {}).get(field)
            for feature in features
        ]
        numeric = [
            value for value in values
            if isinstance(value, (int, float)) and not isinstance(value, bool)
        ]
        entry.update(
            {
                "observed_properties": observed,
                "value_field": field,
                "value_field_source": source,
                "value_field_coverage": round(coverage, 4),
                "mean_value": round(statistics.mean(numeric), 3) if numeric else None,
                "p10": round(percentile(numeric, 0.1), 3) if numeric else None,
                "p90": round(percentile(numeric, 0.9), 3) if numeric else None,
            }
        )
        results.append(entry)

    return results


def timezone_evidence(results):
    """What a pair of readings taken at different local hours implies.

    If ``start_time`` is read as Phoenix wall clock, a mid-afternoon request is far
    hotter than an early-morning one. If it is read as UTC, 04:00 UTC is 21:00 the
    previous evening in Phoenix and 15:00 UTC is 08:00 local, so the gap narrows
    sharply and can invert.

    The measured pair is reported. No conclusion is drawn here, and nothing is
    written to the manifest: a human reads this and decides.
    """
    usable = [entry for entry in results if entry.get("mean_value") is not None]
    if len(usable) < 2:
        return {
            "comparable_readings": len(usable),
            "note": "Fewer than two readings carried values; no timezone inference is possible.",
        }
    ordered = sorted(usable, key=lambda entry: entry["label"])
    return {
        "comparable_readings": len(ordered),
        "readings": [
            {"label": entry["label"], "mean_value": entry["mean_value"]} for entry in ordered
        ],
        "spread_between_extremes": round(
            max(entry["mean_value"] for entry in ordered)
            - min(entry["mean_value"] for entry in ordered),
            3,
        ),
        "note": (
            "A large gap in the direction of the later local hour is consistent with "
            "start_time being read as local wall clock. A narrow or inverted gap is "
            "consistent with it being read as UTC. This is evidence, not a conclusion: "
            "transcribe it into data/manifests/fortyguard-capability.json by hand."
        ),
    }


def report_parse(results, evidence):
    for entry in results:
        print(f"reading {entry['label']}")
        if entry["error"]:
            print(f"  error            {entry['error']}")
            continue
        print(f"  collection at    {entry['feature_collection_path']}")
        print(f"  features         {entry['features']}")
        print(f"  value field      {entry['value_field']} (via {entry['value_field_source']})")
        print(f"  numeric coverage {entry['value_field_coverage']:.1%}")
        print(f"  mean / p10 / p90 {entry['mean_value']} / {entry['p10']} / {entry['p90']}")
        print(f"  observed props   {', '.join(entry['observed_properties'])}")
    print("\ntimezone evidence")
    print(json.dumps(evidence, indent=2))
    print(
        "\nSelecting a field answers ONE of four questions. It does not establish that the field\n"
        "holds a temperature, that its unit is degrees Celsius, or which timezone start_time was\n"
        "read in. Each has its own flag in data/manifests/fortyguard-capability.json, and each is\n"
        "set by a human after reading evidence like the above.\n"
    )
    return 0 if any(entry["value_field"] for entry in results) else 1


# --------------------------------------------------------------------------- #
# Entry point                                                                 #
# --------------------------------------------------------------------------- #

def main() -> None:
    args = parse_args()
    capability = load_capability()
    OUTPUTS.mkdir(parents=True, exist_ok=True)

    if args.parse:
        results = parse_bundle(args.parse, args.temperature_field)
        evidence = timezone_evidence(results)
        destination = Path(args.out) if args.out else OUTPUTS / "fortyguard_probe_report.json"
        destination.write_text(
            json.dumps(
                {
                    "kind": "heat-priority-engine/fortyguard-probe-report",
                    "submits": False,
                    "source": str(args.parse),
                    "readings": results,
                    "timezone_evidence": evidence,
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        code = report_parse(results, evidence)
        print(f"wrote {destination.relative_to(ROOT)}")
        sys.exit(code)

    plan = build_plan(args, load_panel(), capability)
    destination = Path(args.out) if args.out else OUTPUTS / "fortyguard_request_plan.json"
    destination.write_text(json.dumps(plan, indent=2) + "\n", encoding="utf-8")
    code = report_plan(plan)
    print(f"wrote {destination.relative_to(ROOT)}")
    sys.exit(code)


if __name__ == "__main__":
    main()
