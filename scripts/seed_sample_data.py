"""Seed sample timeline data for local development and testing.

This script injects realistic encrypted GPS snapshots for `person.test` into
`.storage/zeitachse_snapshots.enc` using the key from `core.config_entries`.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

from cryptography.fernet import Fernet


def main() -> None:
    repo_root = Path(__file__).resolve().parent.parent
    config_entries_path = repo_root / ".storage" / "core.config_entries"
    snapshots_path = repo_root / ".storage" / "zeitachse_snapshots.enc"

    if not config_entries_path.exists():
        print(f"Error: Config entries file not found at {config_entries_path}")
        return

    config_entries = json.loads(config_entries_path.read_text())
    zeitachse_entry = None
    for entry in config_entries.get("data", {}).get("entries", []):
        if entry.get("domain") == "zeitachse":
            zeitachse_entry = entry
            break

    if not zeitachse_entry:
        print(
            "Error: Zeitachse integration entry not found in .storage/core.config_entries"
        )
        return

    encryption_key = zeitachse_entry.get("data", {}).get("encryption_key")
    if not encryption_key:
        print("Error: encryption_key not found in zeitachse config entry")
        return

    fernet = Fernet(encryption_key.encode())

    # Berlin sample coordinates over the last few hours
    sample_stops = [
        {
            "name": "Brandenburger Tor",
            "lat": 52.516275,
            "lon": 13.377704,
            "state": "away",
            "count": 6,
        },
        {
            "name": "Reichstag",
            "lat": 52.518600,
            "lon": 13.376100,
            "state": "away",
            "count": 4,
        },
        {
            "name": "Unter den Linden",
            "lat": 52.517000,
            "lon": 13.388000,
            "state": "away",
            "count": 2,
        },
        {
            "name": "Museumsinsel",
            "lat": 52.520000,
            "lon": 13.400000,
            "state": "away",
            "count": 8,
        },
        {
            "name": "Alexanderplatz",
            "lat": 52.521918,
            "lon": 13.413215,
            "state": "away",
            "count": 6,
        },
        {
            "name": "Zuhause",
            "lat": 52.520000,
            "lon": 13.405000,
            "state": "home",
            "count": 12,
        },
    ]

    now = datetime.now(timezone.utc)
    total_points = sum(stop["count"] for stop in sample_stops)
    current_time = now - timedelta(minutes=5 * total_points)

    snapshots = []
    for stop in sample_stops:
        for _ in range(stop["count"]):
            snapshots.append(
                {
                    "timestamp": current_time.isoformat(),
                    "latitude": stop["lat"],
                    "longitude": stop["lon"],
                    "state": stop["state"],
                }
            )
            current_time += timedelta(minutes=5)

    data = {"person.test": snapshots}

    payload = json.dumps(data, separators=(",", ":")).encode()
    encrypted = fernet.encrypt(payload)

    snapshots_path.parent.mkdir(parents=True, exist_ok=True)
    snapshots_path.write_bytes(encrypted)

    print(f"Successfully seeded {len(snapshots)} sample snapshots for person.test!")
    print(f"Encrypted data written to: {snapshots_path}")
    print(
        "Restart Home Assistant or reload Zeitachse to view the timeline at http://localhost:8123/zeitachse"
    )


if __name__ == "__main__":
    main()
