#!/usr/bin/env python3
"""Download the official Valley Metro GTFS feed and derive per-stop service frequency.

Why this exists: metric A needs an *expected wait time*, and expected wait comes
from scheduled headways. Without a published schedule there is no defensible way
to estimate how long a rider stands at a stop, and the metric would collapse back
into a weighted guess.

Source: City of Phoenix Open Data, dataset ``valley-metro-bus-schedule``,
licensed **ODC-BY**. That licence is explicit, which is more than can be said for
the ArcGIS layers.

Output: ``data/generated/stop_service_frequency.json`` — for each stop, the
scheduled departure times per route, **for each of three day types**. Everything
downstream reads that file; nothing downstream re-parses GTFS.

Definitions used here, all of which are assumptions and are recorded as such:

* **Day type** — ``weekday``, ``saturday`` and ``sunday`` are extracted
  separately. Weekend ridership must never be paired with a weekday timetable,
  and Saturday and Sunday are not interchangeable in this feed: Saturday runs
  5,476 trips against Sunday's 4,815.
* **Service pattern for a day type** — the *most frequent* set of active
  ``service_id`` values across the dates of that day type in the feed's active
  period. Modal, not maximal: picking the date with the most trips selects an
  outlier (a school-plus-special day) and calls it typical. Ties break on trip
  count, then on the sorted service ids, so the choice is deterministic.
* **Departure** — one row in ``stop_times.txt`` at that stop, on a trip belonging
  to the chosen service pattern, with a non-empty ``departure_time``. The last
  stop of a trip is excluded: nobody boards there to wait.
* **Time** — minutes past the start of the **service day**, preserved as GTFS
  states them. A 25:10 departure is stored as 1510, not silently wrapped to 70.
  Projection onto a clock hour happens once, in ``lib/metrics/exposure.ts``,
  where it is a named assumption with a test rather than a lost fact here.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import sys
import urllib.request
import zipfile
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "data" / "raw"
GENERATED = ROOT / "data" / "generated"
MANIFESTS = ROOT / "data" / "manifests"

GTFS_URL = (
    "https://www.phoenixopendata.com/dataset/3eae9a4a-98b9-40c8-8df7-8c00c1756235/"
    "resource/28ccc0a5-49c8-495c-b91f-193de5ce2cb7/download/googletransit.zip"
)
GTFS_DATASET_PAGE = "https://www.phoenixopendata.com/dataset/valley-metro-bus-schedule"
GTFS_LICENCE = "Open Data Commons Attribution License (ODC-BY)"

USER_AGENT = "heat-priority-engine/1.0 (FortyGuard Hackathon 26; public open-data client)"

DAY_TYPES = ("weekday", "saturday", "sunday")

MINUTES_PER_DAY = 1440


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def canonical_sha256(document: dict) -> str:
    """Hash of the document with volatile fields removed.

    ``generatedAtUtc`` changes on every run by construction, so a hash that
    includes it can never be reproduced and is therefore useless as a
    verification target. The canonical hash is taken over the document with that
    key dropped at the top level, keys sorted, and separators fixed — so a clean
    clone that re-derives the same data gets the same digest.
    """
    stripped = {key: value for key, value in document.items() if key != "generatedAtUtc"}
    text = json.dumps(stripped, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


class _Redirected(Exception):
    """Carries the redirect target out of band.

    The message is deliberately generic: the location is a presigned URL holding
    an AWS access key id and signature, and an exception message ends up in
    tracebacks and logs.
    """

    def __init__(self, location: str) -> None:
        super().__init__("redirected to a presigned URL (not logged)")
        self.location = location


class _CaptureRedirect(urllib.request.HTTPRedirectHandler):
    """Stop at the redirect instead of following it."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D102
        raise _Redirected(newurl)


def download(url: str) -> bytes:
    """Fetch the GTFS archive, following the CKAN redirect by hand.

    CKAN 302s to a **presigned S3 URL**. Two things break the automatic redirect:

    1. urllib percent-re-encodes the query string, turning ``%2F`` in the
       credential into ``%252F`` and invalidating the signature;
    2. the ``Location`` carries an explicit ``:443``, so urllib sends
       ``Host: s3.amazonaws.com:443`` while the signature — which covers
       ``SignedHeaders=host`` — was computed over the default-port form.

    Both yield 403. So the redirect is captured, the redundant port is stripped,
    and the location is opened verbatim.

    The resolved URL is used once, in memory. It is never logged, printed or
    written to a manifest; only the stable CKAN download URL is recorded as
    provenance.
    """
    headers = {"User-Agent": f"Mozilla/5.0 (compatible; {USER_AGENT})", "Accept": "*/*"}
    opener = urllib.request.build_opener(_CaptureRedirect)

    try:
        with opener.open(urllib.request.Request(url, headers=headers), timeout=300) as response:
            return response.read()
    except _Redirected as redirect:
        location = redirect.location.replace("s3.amazonaws.com:443", "s3.amazonaws.com")
        try:
            with urllib.request.urlopen(
                urllib.request.Request(location, headers=headers), timeout=300
            ) as response:
                return response.read()
        except urllib.error.HTTPError as error:
            # Re-raise without the signed URL attached.
            raise RuntimeError(
                f"Presigned GTFS download failed with HTTP {error.code}. "
                "Re-run: the CKAN signature expires after 24 hours."
            ) from None


def read_table(archive: zipfile.ZipFile, name: str) -> list[dict[str, str]]:
    if name not in archive.namelist():
        raise RuntimeError(f"GTFS feed is missing {name}")
    with archive.open(name) as handle:
        text = io.TextIOWrapper(handle, encoding="utf-8-sig", newline="")
        return list(csv.DictReader(text))


def optional_table(archive: zipfile.ZipFile, name: str) -> list[dict[str, str]]:
    return read_table(archive, name) if name in archive.namelist() else []


def parse_service_day_minutes(value: str) -> int | None:
    """GTFS clock time to minutes past the start of the **service day**.

    Times of 24:00:00 and beyond denote the small hours of the following calendar
    day while still belonging to *this* service day. They are returned as they
    are — 25:10 becomes 1510, not 70 — because collapsing them here destroys the
    distinction between "01:10 tomorrow, on today's service" and "01:10 today, on
    yesterday's service". Projection onto a clock hour is a modelling decision
    and belongs where it can be named and tested, not in a parser.

    Keeping the *time* rather than only the hour is what makes a real headway
    distribution computable: counting departures per hour throws away exactly the
    information that distinguishes an even 10-minute service from two buses
    arriving together followed by a 50-minute hole.
    """
    parts = (value or "").strip().split(":")
    if len(parts) < 2:
        return None
    try:
        hours = int(parts[0])
        minutes = int(parts[1])
    except ValueError:
        return None
    if hours < 0 or minutes < 0 or minutes > 59:
        return None
    return hours * 60 + minutes


def day_type_of(day: date) -> str:
    weekday = day.weekday()
    if weekday <= 4:
        return "weekday"
    return "saturday" if weekday == 5 else "sunday"


def active_services_by_date(
    calendar: list[dict[str, str]],
    calendar_dates: list[dict[str, str]],
) -> dict[date, set[str]]:
    """Reconstruct, per calendar date, the set of active ``service_id`` values.

    Full GTFS semantics: a ``calendar.txt`` row is active on a date inside its
    ``start_date``/``end_date`` window when that date's weekday flag is ``1``;
    ``calendar_dates.txt`` then *adds* (``exception_type=1``) or *removes*
    (``exception_type=2``) services on specific dates. Feeds using only
    ``calendar_dates.txt`` — which is what Valley Metro publishes — fall out of
    the same code path with an empty base.
    """
    weekday_columns = (
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
        "sunday",
    )
    by_date: dict[date, set[str]] = defaultdict(set)

    for row in calendar:
        service_id = (row.get("service_id") or "").strip()
        if not service_id:
            continue
        try:
            start = datetime.strptime(row["start_date"], "%Y%m%d").date()
            end = datetime.strptime(row["end_date"], "%Y%m%d").date()
        except (KeyError, ValueError):
            continue
        if end < start:
            continue
        current = start
        while current <= end:
            if row.get(weekday_columns[current.weekday()]) == "1":
                by_date[current].add(service_id)
            current += timedelta(days=1)

    for row in calendar_dates:
        service_id = (row.get("service_id") or "").strip()
        try:
            day = datetime.strptime(row["date"], "%Y%m%d").date()
        except (KeyError, ValueError):
            continue
        if not service_id:
            continue
        exception = row.get("exception_type")
        if exception == "1":
            by_date[day].add(service_id)
        elif exception == "2":
            by_date[day].discard(service_id)

    return {day: services for day, services in by_date.items() if services}


def pick_modal_pattern(
    services_by_date: dict[date, set[str]],
    trips_per_service: Counter,
    day_type: str,
) -> tuple[set[str], dict[str, object]]:
    """The **most frequent** active-service set for one day type.

    Modal, not maximal. Selecting the date with the most trips picks whichever
    day happened to stack a school calendar on top of a special event and then
    calls it representative; in this feed 17 distinct weekday patterns exist and
    the trip counts differ by under 1.5%, so "the largest" is close to arbitrary.
    The pattern that occurs on the most dates is the one a rider actually meets.

    Ties break on total trips, then on the sorted service ids, so two runs over
    the same feed always choose the same pattern.
    """
    candidates = [
        (day, frozenset(services))
        for day, services in services_by_date.items()
        if day_type_of(day) == day_type
    ]
    if not candidates:
        raise RuntimeError(f"GTFS feed contains no {day_type} dates")

    occurrences = Counter(pattern for _, pattern in candidates)

    def sort_key(item: tuple[frozenset, int]) -> tuple:
        pattern, count = item
        trips = sum(trips_per_service.get(service, 0) for service in pattern)
        return (-count, -trips, tuple(sorted(pattern)))

    best_pattern, best_count = sorted(occurrences.items(), key=sort_key)[0]
    dates = sorted(day.isoformat() for day, pattern in candidates if pattern == best_pattern)

    return set(best_pattern), {
        "dayType": day_type,
        "method": "most frequent active-service set across dates of this day type "
                  "(modal, not maximum-trip)",
        "datesWithThisPattern": best_count,
        "datesOfThisDayType": len(candidates),
        "distinctPatterns": len(occurrences),
        "exampleDates": dates[:5],
        "serviceIds": sorted(best_pattern),
        "trips": sum(trips_per_service.get(service, 0) for service in best_pattern),
    }


def departures_for_services(
    stop_times: list[dict[str, str]],
    trips: list[dict[str, str]],
    services: set[str],
    route_name_by_id: dict[str, str],
) -> tuple[dict[str, dict[str, list[int]]], dict[str, int]]:
    """stop_id -> route -> sorted service-day departure minutes."""
    trip_index = {
        row["trip_id"]: row["route_id"] for row in trips if row.get("service_id") in services
    }

    last_sequence: dict[str, int] = {}
    for row in stop_times:
        trip_id = row.get("trip_id", "")
        if trip_id not in trip_index:
            continue
        try:
            sequence = int(row["stop_sequence"])
        except (KeyError, ValueError):
            continue
        if sequence > last_sequence.get(trip_id, -1):
            last_sequence[trip_id] = sequence

    collected: dict[str, dict[str, set[int]]] = defaultdict(lambda: defaultdict(set))
    counters = Counter()

    for row in stop_times:
        trip_id = row.get("trip_id", "")
        route_id = trip_index.get(trip_id)
        if route_id is None:
            continue
        try:
            sequence = int(row["stop_sequence"])
        except (KeyError, ValueError):
            continue
        if sequence == last_sequence.get(trip_id):
            counters["skippedFinalStopOfTrip"] += 1
            continue
        minute = parse_service_day_minutes(
            row.get("departure_time") or row.get("arrival_time") or ""
        )
        if minute is None:
            counters["skippedMissingTime"] += 1
            continue
        if minute >= MINUTES_PER_DAY:
            counters["departuresAfterMidnight"] += 1
        route_name = route_name_by_id.get(route_id, route_id)
        # A set: two trips of the same route scheduled to the same minute at the
        # same stop are one boarding opportunity, not two.
        collected[row["stop_id"]][route_name].add(minute)

    ordered = {
        stop_id: {route: sorted(minutes) for route, minutes in per_route.items()}
        for stop_id, per_route in collected.items()
    }
    return ordered, dict(counters)


def build_day_type_profiles(
    archive_bytes: bytes,
) -> tuple[dict[str, dict], dict[str, dict], dict]:
    with zipfile.ZipFile(io.BytesIO(archive_bytes)) as archive:
        stop_times = read_table(archive, "stop_times.txt")
        trips = read_table(archive, "trips.txt")
        routes = read_table(archive, "routes.txt")
        calendar = optional_table(archive, "calendar.txt")
        calendar_dates = optional_table(archive, "calendar_dates.txt")
        feed_info = optional_table(archive, "feed_info.txt")

    trips_per_service = Counter(trip.get("service_id", "") for trip in trips)
    route_name_by_id = {
        row["route_id"]: (
            row.get("route_short_name") or row.get("route_long_name") or row["route_id"]
        ).strip()
        for row in routes
    }

    services_by_date = active_services_by_date(calendar, calendar_dates)
    if not services_by_date:
        raise RuntimeError("GTFS feed defines no active service dates")

    patterns: dict[str, dict] = {}
    per_stop: dict[str, dict[str, dict]] = defaultdict(dict)
    counts: dict[str, dict] = {}

    for day_type in DAY_TYPES:
        services, note = pick_modal_pattern(services_by_date, trips_per_service, day_type)
        patterns[day_type] = note
        print(
            f"[gtfs] {day_type}: modal pattern on {note['datesWithThisPattern']}/"
            f"{note['datesOfThisDayType']} dates ({note['distinctPatterns']} distinct), "
            f"{note['trips']} trips",
            file=sys.stderr,
        )

        by_stop, counters = departures_for_services(
            stop_times, trips, services, route_name_by_id
        )
        total_departures = 0
        for stop_id, by_route in by_stop.items():
            hourly: Counter = Counter()
            total = 0
            after_midnight = 0
            for minutes in by_route.values():
                total += len(minutes)
                for minute in minutes:
                    if minute >= MINUTES_PER_DAY:
                        after_midnight += 1
                    hourly[(minute % MINUTES_PER_DAY) // 60] += 1
            total_departures += total
            per_stop[stop_id][day_type] = {
                # Actual scheduled departure minutes past the START OF THE
                # SERVICE DAY, sorted, per route. Values >= 1440 are genuine and
                # denote the small hours belonging to this service day.
                "byRoute": by_route,
                "hourlyDepartures": [hourly.get(hour, 0) for hour in range(24)],
                "dailyDepartures": total,
                "routeCount": len(by_route),
                "departuresAfterMidnight": after_midnight,
            }
        counts[day_type] = {
            "stopsWithService": len(by_stop),
            "departuresCounted": total_departures,
            **counters,
        }

    return dict(per_stop), counts, {"patterns": patterns, "feedInfo": feed_info[0] if feed_info else None}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="verify the stored hash, no network")
    parser.add_argument(
        "--rebuild",
        action="store_true",
        help="re-derive the profiles from the stored archive, no network",
    )
    args = parser.parse_args()

    RAW.mkdir(parents=True, exist_ok=True)
    GENERATED.mkdir(parents=True, exist_ok=True)
    MANIFESTS.mkdir(parents=True, exist_ok=True)

    archive_path = RAW / "valley_metro_gtfs.zip"
    metadata_path = RAW / "valley_metro_gtfs_metadata.json"

    if args.check:
        if not archive_path.exists() or not metadata_path.exists():
            raise SystemExit("GTFS artefacts missing; run without --check")
        recorded = json.loads(metadata_path.read_text(encoding="utf-8"))
        actual = sha256_bytes(archive_path.read_bytes())
        if actual != recorded["artifact"]["sha256"]:
            raise SystemExit(f"GTFS hash mismatch: {actual} vs {recorded['artifact']['sha256']}")
        derived_path = GENERATED / "stop_service_frequency.json"
        if not derived_path.exists():
            raise SystemExit("data/generated/stop_service_frequency.json missing; run --rebuild")
        derived = json.loads(derived_path.read_text(encoding="utf-8"))
        expected = recorded.get("derived", {}).get("canonicalSha256")
        actual_canonical = canonical_sha256(derived)
        if expected and actual_canonical != expected:
            raise SystemExit(
                f"GTFS derived canonical hash mismatch: {actual_canonical} vs {expected}"
            )
        print(f"[gtfs] OK archive {actual[:12]}… derived {actual_canonical[:12]}…", file=sys.stderr)
        return

    if args.rebuild:
        if not archive_path.exists():
            raise SystemExit("data/raw/valley_metro_gtfs.zip missing; run without --rebuild")
        payload = archive_path.read_bytes()
        print(f"[gtfs] rebuilding from the stored archive ({len(payload)} bytes)", file=sys.stderr)
    else:
        print(f"[gtfs] downloading {GTFS_URL}", file=sys.stderr)
        payload = download(GTFS_URL)
        if len(payload) < 1_000_000:
            raise RuntimeError(f"GTFS download is only {len(payload)} bytes; refusing to trust it")

    digest = sha256_bytes(payload)

    if not args.rebuild:
        if archive_path.exists() and sha256_bytes(archive_path.read_bytes()) == digest:
            print(f"[gtfs] unchanged ({digest[:12]}…)", file=sys.stderr)
        else:
            archive_path.write_bytes(payload)
            print(f"[gtfs] wrote {archive_path.name} ({digest[:12]}…)", file=sys.stderr)

    per_stop, counts, extra = build_day_type_profiles(payload)

    document = {
        "kind": "heat-priority-engine/stop-service-frequency",
        "version": 2,
        "generatedAtUtc": datetime.now(timezone.utc).isoformat(),
        "generator": "scripts/fetch/fetch_gtfs.py",
        "dayTypes": list(DAY_TYPES),
        "source": {
            "title": "Valley Metro Bus Schedule (GTFS static)",
            "producer": "Valley Metro, published by City of Phoenix Open Data",
            "datasetPage": GTFS_DATASET_PAGE,
            "downloadUrl": GTFS_URL,
            "licence": GTFS_LICENCE,
            "sha256": digest,
            "bytes": len(payload),
            "feedInfo": extra["feedInfo"],
        },
        "definitions": {
            "dayType": "weekday / saturday / sunday, extracted SEPARATELY. Weekend ridership must "
                       "never be paired with a weekday timetable, and Saturday and Sunday are not "
                       "interchangeable in this feed.",
            "servicePattern": "The MOST FREQUENT set of active service_ids across the dates of "
                              "that day type (modal). Not the date with the most trips: that "
                              "selects an outlier and calls it typical.",
            "byRoute": "Route name -> sorted scheduled departure MINUTES PAST THE START OF THE "
                       "SERVICE DAY. Values >= 1440 are genuine GTFS times of 24:00 or later and "
                       "denote the small hours still belonging to this service day; they are NOT "
                       "wrapped here. Actual times, not counts: a headway distribution cannot be "
                       "recovered from departures-per-hour.",
            "departure": "One stop_times row at the stop, on a trip in the chosen service "
                         "pattern, excluding the trip's final stop (nobody waits there to board). "
                         "Duplicate minutes within a route are collapsed: two trips scheduled to "
                         "the same minute are one boarding opportunity.",
            "hourlyDepartures": "Convenience roll-up onto the 24 CLOCK hours (minute mod 1440) "
                                "for coverage and demand-shape checks only. Nothing computes a "
                                "waiting time from it.",
            "departuresAfterMidnight": "How many departures of this stop and day type sit at or "
                                       "past 24:00. Reported so the service-day projection applied "
                                       "downstream is visible rather than silent.",
            "servicePatterns": extra["patterns"],
            "caveat": "Scheduled service, not observed service. Cancellations, detours, bunching "
                      "and real-time deviation are not represented.",
        },
        "counts": counts,
        "stops": per_stop,
    }

    text = json.dumps(document, ensure_ascii=False, separators=(",", ":")) + "\n"
    destination = GENERATED / "stop_service_frequency.json"
    destination.write_text(text, encoding="utf-8", newline="")

    metadata = {
        "key": "valley_metro_gtfs",
        "title": "Valley Metro Bus Schedule (GTFS static)",
        "producer": "Valley Metro, published by City of Phoenix Open Data",
        "dataset_page": GTFS_DATASET_PAGE,
        "download_url": GTFS_URL,
        "licence": GTFS_LICENCE,
        "downloaded_at_utc": document["generatedAtUtc"],
        "artifact": {"path": "data/raw/valley_metro_gtfs.zip", "sha256": digest, "bytes": len(payload)},
        "derived": {
            "path": "data/generated/stop_service_frequency.json",
            # Hash of the document WITHOUT generatedAtUtc: the file hash can never
            # be reproduced because that field changes on every run, so it is
            # useless as a verification target.
            "canonicalSha256": canonical_sha256(document),
            "dayTypes": list(DAY_TYPES),
            "stops_with_service": {day: counts[day]["stopsWithService"] for day in DAY_TYPES},
        },
        "known_limitations": [
            "Scheduled service only; real-time deviation is not represented.",
            "The service pattern for each day type is derived (modal), not published as such.",
            "Frequency is a proxy for when riders are present, not a measurement of it.",
            "The published ridership source splits Weekday / Weekend only, so the same weekend "
            "average is paired with the Saturday and the Sunday timetable separately.",
        ],
    }
    metadata_path.write_text(
        json.dumps(metadata, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline=""
    )

    print(json.dumps({"counts": counts, "canonicalSha256": metadata["derived"]["canonicalSha256"]}, indent=2))


if __name__ == "__main__":
    main()
