"""Constants for the Zeitachse integration."""

from __future__ import annotations

DOMAIN = "zeitachse"
CONF_TRACKED_PERSONS = "tracked_persons"
CONF_INTERVAL_MINUTES = "interval_minutes"
CONF_ENABLE_DASHBOARD = "enable_dashboard"
CONF_ENCRYPTION_KEY = "encryption_key"

DEFAULT_INTERVAL_MINUTES = 5
DEFAULT_ENABLE_DASHBOARD = True

SNAPSHOT_STORAGE_FILE = ".storage/zeitachse_snapshots.enc"
PREFERENCES_STORAGE_KEY = "zeitachse_user_preferences"
PREFERENCES_STORAGE_VERSION = 1
RUNTIME_DATA_KEY = "zeitachse_runtime"
MAX_SNAPSHOTS_PER_PERSON = 10000

WS_LIST_PEOPLE = "zeitachse/list_people"
WS_SET_ACTIVE_PEOPLE = "zeitachse/set_active_people"
WS_SET_PERSON_COLORS = "zeitachse/set_person_colors"
WS_SET_STAY_SETTINGS = "zeitachse/set_stay_settings"
WS_GET_TIMELINE = "zeitachse/get_timeline"
WS_GET_POI = "zeitachse/get_poi"

COLOR_PALETTE = [
    "#1f77b4",
    "#ff7f0e",
    "#2ca02c",
    "#d62728",
    "#9467bd",
    "#8c564b",
    "#e377c2",
    "#7f7f7f",
    "#bcbd22",
    "#17becf",
]
