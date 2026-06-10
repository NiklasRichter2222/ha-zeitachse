# ha-zeitachse

HACS-kompatible Home-Assistant-Integration für eine einfache Zeitachse ähnlich zu Google Timeline.

## Features

- Config Flow zur Einrichtung in Home Assistant
- Kein automatisches Tracking ohne explizit ausgewählte Personen
- Admin-konfigurierbare Liste von `person`-Entitäten für das Tracking
- Einstellbares Snapshot-Intervall (in Minuten)
- Positionsdaten werden verschlüsselt in `.storage/zeitachse_snapshots.enc` gespeichert
- Optionales Sidebar-Dashboard mit Karte und ein-/ausblendbarer Zeitachse pro Person
- Lovelace-Karten:
  - `zeitachse-map-card` (nur Karte)
  - `zeitachse-timeline-card` (nur Timeline)
- Zeitraum-Filter (`1h`, `1d`, `1w`, `1m`, `1j`) sowie Aufenthaltsliste inkl. POI-Namen

## Installation (HACS)

1. Repository in HACS als benutzerdefiniertes Repository hinzufügen (Kategorie: Integration).
2. Integration **Zeitachse** installieren.
3. Home Assistant neu starten.
4. Unter **Einstellungen → Geräte & Dienste → Integration hinzufügen** nach **Zeitachse** suchen.
5. Browser einmal hart neu laden (Strg/Cmd+Shift+R), damit Frontend-Dateien neu geladen werden.

## Entwicklung in VS Code (Schritt für Schritt)

Diese Schritte sind für lokale Weiterentwicklung gedacht (ohne HACS-Paketbau).

### 1) Voraussetzungen installieren

- Git
- Python 3.12 (oder die Version deiner Home-Assistant-Instanz)
- Visual Studio Code
- VS-Code-Erweiterungen:
  - Python (ms-python.python)
  - Pylance (ms-python.vscode-pylance)
  - EditorConfig (optional)

### 2) Repository klonen und in VS Code öffnen

```bash
git clone https://github.com/NiklasRichter2222/ha-zeitachse.git
cd ha-zeitachse
code .
```

### 3) Python-Umgebung für lokale Checks anlegen

Im Projektordner:

```bash
python -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
```

`requirements.txt` ist aktuell **nicht nötig**, weil Laufzeit-Abhängigkeiten der Integration über `custom_components/zeitachse/manifest.json` verwaltet werden (z. B. `cryptography>=42.0.0`).

### 4) Home-Assistant-Testumgebung vorbereiten

1. Erstelle ein separates Home-Assistant-Config-Verzeichnis, z. B. `~/ha-dev-config`.
2. Kopiere den Ordner `custom_components/zeitachse` aus diesem Repository nach `~/ha-dev-config/custom_components/zeitachse`.
3. Lege (falls noch nicht vorhanden) `~/ha-dev-config/configuration.yaml` an.

Minimalbeispiel:

```yaml
default_config:
```

Wichtig: Für **Zeitachse** ist keine YAML-Konfiguration nötig; die Einrichtung läuft über den UI-Config-Flow.

Optionales `person`-Beispiel (falls du noch keine `person.*`-Entitäten hast):

```yaml
person:
  - name: Max
    id: max
    device_trackers:
      - device_tracker.max_phone
```

### 5) Home Assistant mit deiner Dev-Config starten

Starte Home Assistant mit diesem Config-Ordner (Container/Core je nach Setup). Danach:

1. **Einstellungen → Geräte & Dienste → Integration hinzufügen → Zeitachse**
2. Zu trackende `person.*`-Entitäten auswählen
3. Intervall und weitere Optionen setzen

### 6) Frontend-Änderungen testen

- Nach Änderungen an `custom_components/zeitachse/frontend/*.js`:
  1. Home Assistant neu starten
  2. Browser hart neu laden (Strg/Cmd+Shift+R)

### 7) Schnelle lokale Validierung vor Commits

Im Repo:

```bash
python -m compileall custom_components/zeitachse
```

## Konfiguration & Nutzung

- Bei aktivierter Option **Dashboard in der Seitenleiste** erscheint links der Eintrag **Zeitachse**.
- `zeitachse-timeline-card` zeigt genau eine Person (`person`) und unterstützt `height_rows`.
- `zeitachse-map-card` unterstützt `people`, `range`, `center`, `zoom`, `interactive`.
- Aufenthaltsregeln werden in den Integrations-Optionen gesetzt:
  - Mindestanzahl an Snapshots für „verweilend“
  - Erlaubte Positionsabweichung in Metern
- Option **„gespeicherte Zeitachsen-Daten ersetzen“** löscht beim Speichern bestehende Verlaufspunkte.

Ohne ausgewählte Personen wird niemand getrackt.
