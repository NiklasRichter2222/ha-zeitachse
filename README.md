# ha-zeitachse

HACS-kompatible Home-Assistant-Integration für eine einfache "Zeitachse" ähnlich zu Google Timeline.

## Features

- Config Flow zur Einrichtung in Home Assistant
- Kein automatisches Tracking ohne explizit ausgewählte Personen
- Admin-konfigurierbare Liste von `person`-Entitäten für das Tracking
- Einstellbares Snapshot-Intervall (in Minuten)
- Positionsdaten werden verschlüsselt in `.storage/zeitachse_snapshots.enc` gespeichert
- Optionales Sidebar-Dashboard mit Karte und ein-/ausblendbarer Zeitachse pro Person
- Lovelace-Kachel `zeitachse-card` für bestehende Dashboards
- Standardmäßig ist im Dashboard nur die eigene Person aktiviert (wenn zuordenbar)
- Farbige Darstellung je Person

## Installation (HACS)

1. Repository in HACS als benutzerdefiniertes Repository hinzufügen (Kategorie: Integration).
2. Integration **Zeitachse** installieren.
3. Home Assistant neu starten.
4. Unter **Einstellungen → Geräte & Dienste → Integration hinzufügen** nach **Zeitachse** suchen.
5. Browser einmal hart neu laden (Strg/Cmd+Shift+R), damit die Lovelace-Kachel sicher geladen wird.

## Konfiguration

Bei der Einrichtung/Optionen:

- **Zu trackende Personen** (`person.*`) auswählen
- **Intervall in Minuten** setzen
- **Dashboard in der Seitenleiste aktivieren** optional ein-/ausschalten

## Dashboard & Kachel

- Bei aktivierter Option **Dashboard in der Seitenleiste** erscheint links ein Eintrag **Zeitachse**.
- Für ein bestehendes Dashboard kann eine manuelle Karte mit Typ `zeitachse-card` hinzugefügt werden.

Ohne ausgewählte Personen wird niemand getrackt.
