"""Seed sample timeline data for local development and testing.

This script injects realistic encrypted GPS snapshots into
`.storage/zeitachse_snapshots.enc` using the key from `core.config_entries`.
If no `zeitachse` entry exists yet on a fresh clone, it automatically creates one.
"""

from __future__ import annotations

import contextlib
import json
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

from cryptography.fernet import Fernet


def _ensure_zeitachse_entry(config_entries_path: Path) -> dict:
    """Load or create the zeitachse config entry in .storage/core.config_entries."""
    if config_entries_path.exists():
        config_entries = json.loads(config_entries_path.read_text(encoding="utf-8"))
    else:
        config_entries = {
            "version": 1,
            "minor_version": 5,
            "key": "core.config_entries",
            "data": {"entries": []},
        }

    entries = config_entries.setdefault("data", {}).setdefault("entries", [])
    for entry in entries:
        if entry.get("domain") == "zeitachse":
            return entry

    # Discover person entity from auth or default to person.test
    tracked_persons = ["person.test"]
    person_storage = config_entries_path.parent / "person"
    if person_storage.exists():
        with contextlib.suppress(OSError, json.JSONDecodeError):
            person_data = json.loads(person_storage.read_text(encoding="utf-8"))
            items = person_data.get("data", {}).get("items", [])
            discovered = [
                f"person.{item['id']}"
                for item in items
                if isinstance(item, dict) and item.get("id")
            ]
            if discovered:
                tracked_persons = discovered

    now_iso = datetime.now(UTC).isoformat()
    new_entry = {
        "created_at": now_iso,
        "data": {
            "enable_dashboard": True,
            "encryption_key": Fernet.generate_key().decode(),
            "interval_minutes": 5,
            "name": "zeitachse",
            "person_colors": {p: "#03a9f4" for p in tracked_persons},
            "stay_distance_meters": 75,
            "stay_min_snapshots": 6,
            "tile_provider": "local_osm",
            "tile_url": "",
            "tracked_persons": tracked_persons,
        },
        "disabled_by": None,
        "discovery_keys": {},
        "domain": "zeitachse",
        "entry_id": uuid.uuid4().hex[:26].upper(),
        "minor_version": 1,
        "modified_at": now_iso,
        "options": {},
        "pref_disable_new_entities": False,
        "pref_disable_polling": False,
        "source": "user",
        "subentries": [],
        "title": "zeitachse",
        "unique_id": None,
        "version": 1,
    }
    entries.append(new_entry)
    config_entries_path.parent.mkdir(parents=True, exist_ok=True)
    config_entries_path.write_text(
        json.dumps(config_entries, indent=2), encoding="utf-8"
    )
    print(f"Created new Zeitachse config entry in {config_entries_path}")
    return new_entry


def main() -> None:
    repo_root = Path(__file__).resolve().parent.parent
    config_entries_path = repo_root / ".storage" / "core.config_entries"
    snapshots_path = repo_root / ".storage" / "zeitachse_snapshots.enc"
    poi_cache_path = repo_root / ".storage" / "zeitachse_poi_cache"

    zeitachse_entry = _ensure_zeitachse_entry(config_entries_path)
    entry_data = {
        **zeitachse_entry.get("data", {}),
        **zeitachse_entry.get("options", {}),
    }
    encryption_key = entry_data.get("encryption_key")
    if not encryption_key:
        print("Error: encryption_key not found in zeitachse config entry")
        return

    tracked_persons = entry_data.get("tracked_persons") or ["person.test"]
    fernet = Fernet(encryption_key.encode())

    # Sample stops with varying stay durations to test LOD overlap culling and 1h/1d/1w/1m/1y ranges
    sample_stops = [
        {
            "name": "Brandenburger Tor",
            "lat": 52.51628,
            "lon": 13.37770,
            "state": "not_home",
            "count": 8,
            "category": "tourism",
        },
        {
            "name": "Reichstag",
            "lat": 52.51860,
            "lon": 13.37610,
            "state": "not_home",
            "count": 6,
            "category": "historic",
        },
        {
            "name": "Unter den Linden",
            "lat": 52.51700,
            "lon": 13.38800,
            "state": "not_home",
            "count": 3,
            "category": "road",
        },
        {
            "name": "Museumsinsel",
            "lat": 52.52000,
            "lon": 13.40000,
            "state": "not_home",
            "count": 14,
            "category": "tourism",
        },
        {
            "name": "Alexanderplatz",
            "lat": 52.52192,
            "lon": 13.41322,
            "state": "not_home",
            "count": 10,
            "category": "place",
        },
        {
            "name": "Zuhause",
            "lat": 52.52000,
            "lon": 13.40500,
            "state": "home",
            "count": 24,
            "category": "zone",
        },
    ]

    now = datetime.now(UTC)
    data = {}
    for idx, person_id in enumerate(tracked_persons):
        lat_offset = idx * 0.0012
        lon_offset = idx * 0.0015
        snapshots = []

        # Historical stays at 120d, 45d, 15d, 4d ago so 1w, 1m, 1y have rich data
        for days_ago in (120, 45, 15, 4):
            hist_time = now - timedelta(days=days_ago, hours=6)
            for stop in sample_stops:
                for _ in range(stop["count"]):
                    snapshots.append(
                        {
                            "timestamp": hist_time.isoformat(),
                            "latitude": round(stop["lat"] + lat_offset, 5),
                            "longitude": round(stop["lon"] + lon_offset, 5),
                            "state": stop["state"],
                        }
                    )
                    hist_time += timedelta(minutes=5)

        # Recent stays ending now
        total_recent = sum(stop["count"] for stop in sample_stops)
        current_time = now - timedelta(minutes=5 * total_recent)
        for stop in sample_stops:
            for _ in range(stop["count"]):
                snapshots.append(
                    {
                        "timestamp": current_time.isoformat(),
                        "latitude": round(stop["lat"] + lat_offset, 5),
                        "longitude": round(stop["lon"] + lon_offset, 5),
                        "state": stop["state"],
                    }
                )
                current_time += timedelta(minutes=5)

        data[person_id] = snapshots

    payload = json.dumps(data, separators=(",", ":")).encode()
    encrypted = fernet.encrypt(payload)

    snapshots_path.parent.mkdir(parents=True, exist_ok=True)
    snapshots_path.write_bytes(encrypted)

    # Also pre-populate POI cache so labels appear immediately even offline
    poi_cache_data = {}
    for idx, _ in enumerate(tracked_persons):
        lat_offset = idx * 0.0012
        lon_offset = idx * 0.0015
        for stop in sample_stops:
            lat = round(stop["lat"] + lat_offset, 5)
            lon = round(stop["lon"] + lon_offset, 5)
            poi_cache_data[f"{lat},{lon}"] = {
                "name": stop["name"],
                "display_name": f"{stop['name']}, Berlin",
                "category": stop["category"],
                "type": stop["category"],
                "url": "https://www.openstreetmap.org/",
            }
    poi_store = {
        "version": 1,
        "minor_version": 1,
        "key": "zeitachse_poi_cache",
        "data": poi_cache_data,
    }
    poi_cache_path.write_text(json.dumps(poi_store, indent=2), encoding="utf-8")

    total_seeded = sum(len(v) for v in data.values())
    print(
        f"Successfully seeded {total_seeded} sample snapshots for {', '.join(tracked_persons)}!"
    )
    print(f"Encrypted data written to: {snapshots_path}")
    print(
        "Restart Home Assistant or reload Zeitachse to view the timeline at http://localhost:8123/zeitachse"
    )


if __name__ == "__main__":
    main()

