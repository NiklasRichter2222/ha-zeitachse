# ha-zeitachse ⏱️📍

HACS-kompatible Home-Assistant-Integration für eine verschlüsselte Zeitachse und Standort-Historie (ähnlich wie Google Timeline).

---

## ✨ Features

- **Datenschutz & Verschlüsselung**: Positionsdaten werden mit Fernet symmetrisch verschlüsselt in `.storage/zeitachse_snapshots.enc` abgelegt.
- **Kein ungefragtes Tracking**: Nur explizit im Config-Flow ausgewählte `person`-Entitäten werden aufgezeichnet.
- **Einstellbares Intervall**: Snapshot-Takt frei wählbar (in Minuten).
- **Sidebar-Dashboard**: Interaktive Leaflet-Karte mit Zeitachsen-Filter (`1h`, `1d`, `1w`, `1m`, `1j`), animiertem Routenverlauf und Aufenthaltsliste.
- **POI & Zonen-Erkennung**: Automatische Erkennung von Home-Assistant-Zonen und OpenStreetMap/Nominatim POIs (mit Caching und Rate-Limiting).
- **Lovelace-Karten**:
  - `zeitachse-map-card` (Kartenansicht mit Filtern und Zoom)
  - `zeitachse-timeline-card` (vertikale Chronik für eine Person)
- **Vollständige Testabdeckung**: Automatisierte Pytest-Testsuite und Ruff-Linter integriert.

---

## 🚀 Schnellstart: Lokal starten & ausprobieren

Das Repository ist so vorbereitet, dass du Home Assistant und die Integration sofort lokal ohne externe Abhängigkeiten starten und testen kannst.

### 1. Home Assistant lokal starten

Führe einfach das Startskript im Hauptordner aus:

```bash
./scripts/run_dev.sh
```

*Alternativ manuell:*
```bash
source .venv/bin/activate
hass -c .
```

Home Assistant startet und ist unter **[http://localhost:8123](http://localhost:8123)** erreichbar.

- **Benutzer:** `test`
- **Passwort:** `1234`
*(Oder erstelle beim ersten Start einen eigenen Admin-Account, falls du mit einer frischen Instanz beginnst).*

### 2. Testdaten einspielen (GPS-Punkte generieren)

Damit du die Zeitachse und die Karte sofort mit realistischen Wegpunkten (z. B. Brandenburger Tor, Reichstag, Alexanderplatz) testen kannst, führe das Seed-Skript aus:

```bash
source .venv/bin/activate
python scripts/seed_sample_data.py
```

Lade anschließend die Seite im Browser neu (**Strg+Shift+R** oder **Cmd+Shift+R**) und klicke in der Seitenleiste auf **Zeitachse**.

---

## 🧪 Tests & Code-Qualität ausführen

Die Integration verfügt über eine umfassende Testsuite mit 32 Unit-Tests für Storage, POI-Lookup, Config Flow, Tracking und WebSocket APIs.

### Alle Tests & Linter mit einem Befehl:

```bash
./scripts/run_tests.sh
```

### Manuelle Test-Befehle:

```bash
source .venv/bin/activate

# 1. Pytest Unit-Tests ausführen
pytest

# 2. Pytest mit ausführlicher Ausgabe
pytest -v

# 3. Linter & Code-Formatierung prüfen
ruff check .

# 4. Automatische Linter-Korrekturen
ruff check --fix .
```

---

## 📁 Projektstruktur

```text
ha-zeitachse/
├── custom_components/
│   └── zeitachse/
│       ├── __init__.py           # Integration Lifecycle & TrackingManager
│       ├── config_flow.py        # UI Setup Flow & Optionen
│       ├── const.py              # Konstanten, Limits & Farbpaletten
│       ├── manifest.json         # HA Integration Manifest & HACS Info
│       ├── poi_lookup.py         # HA Zonen & OpenStreetMap Nominatim Resolver
│       ├── storage.py            # Fernet-verschlüsselter Speicher & Benutzereinstellungen
│       ├── websocket_api.py      # WebSocket Endpunkte für Frontend & Karten
│       └── frontend/
│           ├── zeitachse-panel.js    # Sidebar Panel WebComponent
│           ├── zeitachse-card.js     # Lovelace Map & Timeline Cards
│           ├── leaflet-shadow-css.js # Leaflet CSS Injection Helper
│           └── map-utils.js          # Geometrie & Zeit-Hilfsfunktionen
├── tests/
│   ├── test_config_flow.py       # Tests für Config & Options Flow
│   ├── test_init.py              # Tests für Setup, Unload & TrackingManager
│   ├── test_poi_lookup.py        # Tests für Zonen, Caching & OSM POI
│   ├── test_storage.py           # Tests für Verschlüsselung & Pruning
│   └── test_websocket_api.py     # Tests für WebSocket Handler
├── scripts/
│   ├── run_dev.sh                # Startet Home Assistant lokal
│   ├── run_tests.sh              # Führt Compileall, Ruff & Pytest aus
│   └── seed_sample_data.py       # Erstellt verschlüsselte GPS-Demodaten
├── configuration.yaml            # Lokale Home Assistant Dev-Konfiguration
└── requirements.txt              # Entwicklungs- & Test-Abhängigkeiten
```

---

## ⚙️ Wie die Integration funktioniert

1. **Tracking**: Der `TrackingManager` fragt im eingestellten Intervall (z. B. alle 5 Minuten) die Koordinaten (`latitude`, `longitude`) der konfigurierten `person`-Entitäten ab.
2. **Verschlüsselung**: Jeder Snapshot wird mit einem integrationsspezifischen Fernet-Schlüssel verschlüsselt in `.storage/zeitachse_snapshots.enc` gespeichert.
3. **Aufenthalts-Erkennung**: Zusammenhängende Snapshots innerhalb eines Radius (Standard: 75m) werden automatisch zu Aufenthalten gruppiert.
4. **POI-Lookup**: Für Standorte wird zuerst geprüft, ob eine Home-Assistant-`zone` zutrifft; andernfalls wird OpenStreetMap Nominatim abgefragt (mit integriertem Cache und 1s Rate-Limit).
5. **Visualisierung**: Das Sidebar-Panel und die Lovelace-Karten laden die Punkte über sichere WebSocket-Befehle (`zeitachse/get_timeline`, `zeitachse/list_people`).

---

## 📦 Installation in Produktiv-Systemen (HACS)

1. In HACS als benutzerdefiniertes Repository hinzufügen:
   - URL: `https://github.com/NiklasRichter2222/ha-zeitachse`
   - Kategorie: `Integration`
2. Integration **Zeitachse** herunterladen.
3. Home Assistant neu starten.
4. Unter **Einstellungen → Geräte & Dienste → Integration hinzufügen** nach **Zeitachse** suchen.
5. Gewünschte Personen und Optionen auswählen.
6. Browser mit **Strg+Shift+R** (Hard Refresh) neu laden.
