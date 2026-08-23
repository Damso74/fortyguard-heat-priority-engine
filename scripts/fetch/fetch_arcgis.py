#!/usr/bin/env python3
"""Idempotent, paginated download of the public ArcGIS layers this project uses.

Design rules (these exist because a silently truncated layer would corrupt every
downstream metric):

* the authoritative record count is read first with ``returnCountOnly``;
* pages are requested with ``resultOffset`` / ``resultRecordCount`` bounded by the
  layer's own ``maxRecordCount``;
* a run fails loudly when the number of returned features does not match the
  authoritative count, when a page comes back empty before the count is reached,
  or when the server still reports ``exceededTransferLimit`` on the last page;
* an existing, non-empty dataset is never replaced by an empty or short response;
* output is sorted by ``OBJECTID`` so a re-run of an unchanged layer produces a
  byte-identical file and therefore an identical SHA-256.

Usage::

    python scripts/fetch/fetch_arcgis.py                # fetch everything
    python scripts/fetch/fetch_arcgis.py --only phoenix_bus_stops
    python scripts/fetch/fetch_arcgis.py --check        # verify hashes, no network write
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "data" / "raw"
MANIFESTS = ROOT / "data" / "manifests"

USER_AGENT = "heat-priority-engine/1.0 (FortyGuard Hackathon 26; public open-data client)"
REQUEST_TIMEOUT = 120
MAX_RETRIES = 4


# --------------------------------------------------------------------------- #
# Source registry
# --------------------------------------------------------------------------- #

SOURCES: dict[str, dict[str, Any]] = {
    "phoenix_bus_stops": {
        "title": "City of Phoenix — Bus Stops",
        "producer": "City of Phoenix (Public GIS)",
        "layer_url": "https://maps.phoenix.gov/pub/rest/services/Public/BusStops/MapServer/0",
        "where": "1=1",
        "out_fields": "*",
        "geojson": RAW / "phoenix_bus_stops.geojson",
        "metadata": RAW / "bus_stops_layer_metadata.json",
        "expected_min_records": 4000,
        "fields_used": ["STOP_ID", "NEXTRIDEID", "RIDERSHIP", "NBR_SHELTERS"],
        "known_limitations": [
            "No lastEditDate is published by the service, so freshness cannot be proven.",
            "RIDERSHIP has no documented unit, period, or collection date.",
            "NBR_SHELTERS is populated on 20 of 4104 records and contradicts the City's own "
            "published sheltered-stop total; it must not be read as an inventory.",
        ],
        "terms": "City of Phoenix public open data endpoint; no auth required. "
                 "No machine-readable licence is published on the layer.",
    },
    "valley_metro_phoenix_stops": {
        "title": "Valley Metro — Bus Stops with Amenities (Phoenix jurisdiction)",
        "producer": "Valley Metro (ArcGIS Online, flagged Authoritative)",
        "layer_url": "https://services2.arcgis.com/2t1927381mhTgWNC/arcgis/rest/services/BusStopsWAmenities/FeatureServer/0",
        "where": "Juris='Phoenix'",
        "out_fields": "*",
        "geojson": RAW / "valley_metro_phoenix_stops.geojson",
        "metadata": RAW / "valley_metro_bus_stops_metadata.json",
        "expected_min_records": 4200,
        "fields_used": [
            "stop_id", "stop_code", "stop_name", "stop_desc",
            "Status", "Routes", "Shelters", "Shelter", "Shade",
        ],
        "known_limitations": [
            "Integer field `Shelters` is 0 or null on every Phoenix record.",
            "Text field `Shelter` equals '1' on exactly one Phoenix record.",
            "`Shade` is empty on every Phoenix record.",
            "These three fields cannot be read as an amenity inventory and are never "
            "interpreted as 'no shelter' by this project.",
        ],
        "terms": (
            "Valley Metro ArcGIS item 35d5c9ae3c26409aa3d1574f110409e7 grants users "
            "the right to freely share, modify, and use the data for any purpose without "
            "restriction; reviewed 2026-08-22. "
            "https://www.arcgis.com/home/item.html?id=35d5c9ae3c26409aa3d1574f110409e7"
        ),
    },
    "valley_metro_quarterly_ridership": {
        "title": "Valley Metro — bus stop ridership by fiscal quarter and day category (Phoenix)",
        "producer": "Valley Metro (ArcGIS Online, Ridership.dbo.BusStopQuarterlyRidership)",
        # The newer of the two services publishing this table. Chosen over
        # BusStopQuarterlyRidership/0 because it was edited 2025-04-25 rather
        # than 2024-12-16, carries both `tot*` (quarter total) and `avg*`
        # (average daily) rather than `avg` alone, and reaches back to FY2022 Q3
        # — which is what makes the temporal-drift scenarios possible.
        "layer_url": "https://services2.arcgis.com/2t1927381mhTgWNC/arcgis/rest/services/BusRidershipByQuarterForPortal/FeatureServer/6",
        "where": "Juris='Phoenix'",
        "out_fields": "*",
        "geometry": False,
        "geojson": RAW / "valley_metro_quarterly_ridership.json",
        "metadata": RAW / "valley_metro_quarterly_ridership_metadata.json",
        "expected_min_records": 7000,
        "fields_used": ["StopID", "Day_Category", "avg2024_4", "avg2024_3", "avg2024_2"],
        "known_limitations": [
            "Quarters are FISCAL, not calendar. Valley Metro's fiscal year runs July-June, so "
            "avg2024_4 covers April-June 2024. Evidence: the sibling layer RidershipDataPortal_Bus "
            "describes itself as 'bus stops as of October 27, 2014' and its earliest quarter is "
            "Q2015_2, which is Oct-Dec 2014 only under a July-June fiscal year. Valley Metro "
            "publishes no data dictionary for the field, so this reading is inferred, not stated.",
            "Quarters after avg2024_4 are published but demonstrably incomplete. Phoenix weekday "
            "totals: 2024_3 = 50738, 2024_4 = 43092, then 2025_1 = 19324 (45% of the previous "
            "quarter), 2025_2 = 5413, 2025_3 = 2522. Individual stops fall from ~41 riders/day to "
            "0.26. avg2024_4 is therefore the most recent defensible quarter.",
            "The layer does not state whether a value counts boardings only or boardings plus "
            "alightings. If alightings are included every exposure estimate is an over-estimate, "
            "because alighting riders do not wait. Recorded as assumption A2.",
            "avg* and tot* are published as STRINGS, so server-side numeric statistics silently "
            "return zero. They are parsed client-side.",
            "The ridership period (Apr-Jun 2024) does not match the GTFS schedule (July 2026) or "
            "the thermal analysis date. Handled as the temporal-drift scenario dimension.",
            "Rows with no StopID or an unrecognised day category are discarded, never guessed.",
        ],
        "terms": "Valley Metro public ArcGIS Online feature service; the item publishes no licence terms.",
    },
    "valley_metro_phoenix_stops_2023": {
        "title": "Valley Metro — legacy Bus Stops layer (Phoenix jurisdiction)",
        "producer": "Valley Metro (ArcGIS Online, legacy service)",
        "layer_url": "https://services2.arcgis.com/2t1927381mhTgWNC/arcgis/rest/services/ValleyMetroBusStops/FeatureServer/0",
        "where": "Juris='Phoenix'",
        "out_fields": "*",
        "geojson": RAW / "valley_metro_phoenix_stops_2023.geojson",
        "metadata": RAW / "valley_metro_legacy_stops_metadata.json",
        "expected_min_records": 4700,
        "fields_used": ["StopID", "Photo", "Shelter", "Shade", "Status"],
        "known_limitations": [
            "Last edited 2023-07-27; superseded by BusStopsWAmenities.",
            "Native projection is EPSG:2868; this fetcher requests outSR=4326.",
            "Photo is empty for the overwhelming majority of Phoenix records.",
            "Retained only as a historical cross-check, never as a current inventory.",
        ],
        "terms": (
            "Valley Metro ArcGIS item 14920e153e6b4afc973f0509b41077e1 grants users "
            "the right to freely share, modify, and use the data for any purpose without "
            "restriction; reviewed 2026-08-22. "
            "https://www.arcgis.com/home/item.html?id=14920e153e6b4afc973f0509b41077e1"
        ),
    },
}


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #

def _get_json(url: str, params: dict[str, Any]) -> Any:
    query = urllib.parse.urlencode(params)
    full = f"{url}?{query}"
    last_error: Exception | None = None
    for attempt in range(MAX_RETRIES):
        try:
            request = urllib.request.Request(full, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
            last_error = error
            time.sleep(2 ** attempt)
            continue
        # ArcGIS reports application errors inside an HTTP 200 body.
        if isinstance(payload, dict) and "error" in payload:
            raise RuntimeError(f"ArcGIS error for {url}: {payload['error']}")
        return payload
    raise RuntimeError(f"Failed to fetch {url} after {MAX_RETRIES} attempts: {last_error}")


def _layer_metadata(layer_url: str) -> dict[str, Any]:
    return _get_json(layer_url, {"f": "json"})


def _record_count(layer_url: str, where: str) -> int:
    payload = _get_json(
        f"{layer_url}/query", {"where": where, "returnCountOnly": "true", "f": "json"}
    )
    count = payload.get("count")
    if not isinstance(count, int):
        raise RuntimeError(f"Layer {layer_url} did not return an integer count: {payload}")
    return count


def _fetch_all_features(
    layer_url: str,
    where: str,
    out_fields: str,
    page_size: int,
    expected: int,
    geometry: bool = True,
) -> list[dict[str, Any]]:
    """Page through a layer and refuse to return a short result.

    ``geometry=False`` fetches an attribute-only table (``f=json``), which is how
    the quarterly ridership layer is published; the rows are wrapped into the
    same feature shape so downstream serialisation is identical.
    """
    features: list[dict[str, Any]] = []
    offset = 0
    guard = 0
    while offset < expected:
        guard += 1
        if guard > 1000:
            raise RuntimeError(f"Pagination guard tripped for {layer_url}")
        params: dict[str, Any] = {
            "where": where,
            "outFields": out_fields,
            "resultOffset": offset,
            "resultRecordCount": page_size,
        }
        if geometry:
            params.update({"returnGeometry": "true", "outSR": 4326, "f": "geojson"})
        else:
            params.update({"returnGeometry": "false", "f": "json"})

        payload = _get_json(f"{layer_url}/query", params)

        if not geometry:
            rows = payload.get("features")
            if isinstance(rows, list):
                payload = {
                    "features": [
                        {"type": "Feature", "properties": row.get("attributes") or {}, "geometry": None}
                        for row in rows
                    ]
                }
        page = payload.get("features")
        if not isinstance(page, list):
            raise RuntimeError(
                f"Layer {layer_url} returned no feature array at offset {offset}: "
                f"{list(payload)[:8]}"
            )
        if not page:
            raise RuntimeError(
                f"Layer {layer_url} returned an empty page at offset {offset} while "
                f"{expected - len(features)} of {expected} records were still missing. "
                "Refusing to write a partial dataset."
            )
        features.extend(page)
        offset += len(page)
        if payload.get("exceededTransferLimit") and len(page) < page_size:
            raise RuntimeError(
                f"Layer {layer_url} reported exceededTransferLimit on a short page; "
                "pagination contract is not honoured by this service."
            )

    if len(features) != expected:
        raise RuntimeError(
            f"Layer {layer_url} returned {len(features)} features but the service "
            f"reported {expected}. Refusing to write an inconsistent dataset."
        )
    return features


# --------------------------------------------------------------------------- #
# Serialisation
# --------------------------------------------------------------------------- #

def _feature_sort_key(feature: dict[str, Any]) -> tuple[int, str]:
    properties = feature.get("properties") or {}
    for key in ("OBJECTID", "objectid", "OBJECTID_1", "FID"):
        value = properties.get(key)
        if isinstance(value, int):
            return (value, "")
    identifier = feature.get("id")
    if isinstance(identifier, int):
        return (identifier, "")
    return (2**62, json.dumps(feature, sort_keys=True))


def _canonical_geojson(features: list[dict[str, Any]]) -> str:
    ordered = sorted(features, key=_feature_sort_key)
    document = {"type": "FeatureCollection", "features": ordered}
    return json.dumps(document, ensure_ascii=False, indent=1, sort_keys=False) + "\n"


def sha256_of_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def sha256_of_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


# --------------------------------------------------------------------------- #
# Driver
# --------------------------------------------------------------------------- #

def fetch_source(key: str, spec: dict[str, Any]) -> dict[str, Any]:
    layer_url = spec["layer_url"]
    print(f"[{key}] describing {layer_url}", file=sys.stderr)
    layer = _layer_metadata(layer_url)
    page_size = min(int(layer.get("maxRecordCount") or 1000), 2000)
    count = _record_count(layer_url, spec["where"])
    print(f"[{key}] service reports {count} records; page size {page_size}", file=sys.stderr)

    if count < spec["expected_min_records"]:
        raise RuntimeError(
            f"[{key}] service reports only {count} records, below the guard of "
            f"{spec['expected_min_records']}. Refusing to overwrite a known-good dataset."
        )

    features = _fetch_all_features(
        layer_url,
        spec["where"],
        spec["out_fields"],
        page_size,
        count,
        geometry=spec.get("geometry", True),
    )
    text = _canonical_geojson(features)
    digest = sha256_of_text(text)

    destination: Path = spec["geojson"]
    destination.parent.mkdir(parents=True, exist_ok=True)
    unchanged = destination.exists() and sha256_of_file(destination) == digest
    if unchanged:
        print(f"[{key}] unchanged ({digest[:12]}…)", file=sys.stderr)
    else:
        # newline="" disables the platform newline translation that would
        # otherwise write CRLF on Windows and make the recorded hash — computed
        # on the LF text — disagree with the bytes actually on disk.
        destination.write_text(text, encoding="utf-8", newline="")
        print(f"[{key}] wrote {destination.name} ({digest[:12]}…)", file=sys.stderr)

    last_edit = None
    editing = layer.get("editingInfo") or {}
    if isinstance(editing.get("lastEditDate"), (int, float)):
        last_edit = datetime.fromtimestamp(
            editing["lastEditDate"] / 1000, tz=timezone.utc
        ).isoformat()

    metadata = {
        "key": key,
        "title": spec["title"],
        "producer": spec["producer"],
        "layer_url": layer_url,
        "query_where": spec["where"],
        "downloaded_at_utc": datetime.now(timezone.utc).isoformat(),
        "service_last_edit_utc": last_edit,
        "service_description": (layer.get("description") or "").strip() or None,
        "record_count": len(features),
        "service_reported_count": count,
        "max_record_count": layer.get("maxRecordCount"),
        "requested_projection": "EPSG:4326",
        "native_projection_wkid": (
            (layer.get("extent") or {}).get("spatialReference") or {}
        ).get("latestWkid")
        or ((layer.get("extent") or {}).get("spatialReference") or {}).get("wkid"),
        "geometry_type": layer.get("geometryType"),
        "service_time_reference": (layer.get("preferredTimeReference") or {}).get("timeZone"),
        "service_copyright_text": (layer.get("copyrightText") or "").strip() or None,
        "available_fields": [field.get("name") for field in layer.get("fields") or []],
        "fields_used_by_this_project": spec["fields_used"],
        "known_limitations": spec["known_limitations"],
        "terms_of_use": spec["terms"],
        "artifact": {
            "path": str(destination.relative_to(ROOT)).replace("\\", "/"),
            "sha256": digest,
            "bytes": len(text.encode("utf-8")),
        },
    }
    metadata_path: Path = spec["metadata"]
    metadata_path.write_text(
        json.dumps(metadata, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
        newline="",
    )
    return metadata


def check_source(key: str, spec: dict[str, Any]) -> dict[str, Any]:
    geojson: Path = spec["geojson"]
    metadata_path: Path = spec["metadata"]
    if not geojson.exists():
        raise SystemExit(f"[{key}] missing {geojson}; run the fetcher without --check")
    if not metadata_path.exists():
        raise SystemExit(f"[{key}] missing {metadata_path}; run the fetcher without --check")
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    actual = sha256_of_file(geojson)
    recorded = metadata["artifact"]["sha256"]
    status = "OK" if actual == recorded else "HASH MISMATCH"
    print(f"[{key}] {status} {actual[:12]}… vs manifest {recorded[:12]}…", file=sys.stderr)
    if actual != recorded:
        raise SystemExit(f"[{key}] hash mismatch — the raw dataset was modified in place")
    return metadata


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--only", action="append", choices=sorted(SOURCES))
    parser.add_argument(
        "--check",
        action="store_true",
        help="verify recorded hashes without contacting the network",
    )
    args = parser.parse_args()

    selected = args.only or sorted(SOURCES)
    MANIFESTS.mkdir(parents=True, exist_ok=True)

    manifest_entries = []
    for key in selected:
        spec = SOURCES[key]
        entry = check_source(key, spec) if args.check else fetch_source(key, spec)
        manifest_entries.append(entry)

    if not args.check and set(selected) == set(SOURCES):
        provenance = {
            "generated_at_utc": datetime.now(timezone.utc).isoformat(),
            "generator": "scripts/fetch/fetch_arcgis.py",
            "sources": manifest_entries,
        }
        path = MANIFESTS / "source-provenance.json"
        path.write_text(
            json.dumps(provenance, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
            newline="",
        )
        print(f"wrote {path.relative_to(ROOT)}", file=sys.stderr)

    print(json.dumps({"sources": [e["key"] for e in manifest_entries]}, indent=2))


if __name__ == "__main__":
    main()
