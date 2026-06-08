"""Zeitachse integration."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

from homeassistant.components import panel_custom
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.event import async_track_time_interval
from homeassistant.helpers.typing import ConfigType

from .const import (
    CONF_ENABLE_DASHBOARD,
    CONF_ENCRYPTION_KEY,
    CONF_INTERVAL_MINUTES,
    CONF_TRACKED_PERSONS,
    DEFAULT_ENABLE_DASHBOARD,
    DEFAULT_INTERVAL_MINUTES,
    DOMAIN,
    SNAPSHOT_STORAGE_FILE,
)
from .storage import EncryptedSnapshotStorage, UserPreferenceStorage
from .websocket_api import ZeitachseRuntimeData, async_register_websocket_api


class TrackingManager:
    """Manage periodic snapshot collection."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry, storage: EncryptedSnapshotStorage) -> None:
        """Initialize tracker."""
        self._hass = hass
        self._entry = entry
        self._storage = storage
        self._unsub = None

    def _tracked_persons(self) -> list[str]:
        return self._entry.options.get(
            CONF_TRACKED_PERSONS,
            self._entry.data.get(CONF_TRACKED_PERSONS, []),
        )

    async def _async_collect_snapshot(self, *_: Any) -> None:
        now = datetime.now(UTC).isoformat()
        for person_entity_id in self._tracked_persons():
            state = self._hass.states.get(person_entity_id)
            if state is None:
                continue
            latitude = state.attributes.get("latitude")
            longitude = state.attributes.get("longitude")
            if latitude is None or longitude is None:
                continue

            await self._storage.async_append(
                person_entity_id,
                {
                    "timestamp": now,
                    "latitude": latitude,
                    "longitude": longitude,
                    "state": state.state,
                },
            )

    async def async_start(self) -> None:
        """Start periodic tracking."""
        minutes = self._entry.options.get(
            CONF_INTERVAL_MINUTES,
            self._entry.data.get(CONF_INTERVAL_MINUTES, DEFAULT_INTERVAL_MINUTES),
        )
        self._unsub = async_track_time_interval(
            self._hass,
            self._async_collect_snapshot,
            timedelta(minutes=int(minutes)),
        )

    async def async_stop(self) -> None:
        """Stop periodic tracking."""
        if self._unsub:
            self._unsub()
            self._unsub = None


async def _async_register_panel(hass: HomeAssistant) -> None:
    """Register panel assets and sidebar entry once."""
    if hass.data[DOMAIN].get("panel_registered"):
        return

    await hass.http.async_register_static_paths(
        [
            StaticPathConfig(
                "/zeitachse_static",
                hass.config.path("custom_components/zeitachse/frontend"),
                False,
            )
        ]
    )
    panel_custom.async_register_panel(
        hass,
        webcomponent_name="zeitachse-panel",
        frontend_url_path="zeitachse",
        module_url="/zeitachse_static/zeitachse-panel.js",
        sidebar_title="Zeitachse",
        sidebar_icon="mdi:timeline-clock",
        require_admin=False,
        config={},
    )
    hass.data[DOMAIN]["panel_registered"] = True


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Set up integration from YAML (unused)."""
    hass.data.setdefault(DOMAIN, {})
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Zeitachse from a config entry."""
    hass.data.setdefault(DOMAIN, {})

    storage = EncryptedSnapshotStorage(
        hass,
        SNAPSHOT_STORAGE_FILE,
        entry.data[CONF_ENCRYPTION_KEY],
    )
    preferences = UserPreferenceStorage(hass)
    tracker = TrackingManager(hass, entry, storage)
    await tracker.async_start()

    runtime = ZeitachseRuntimeData(entry, storage, preferences)
    if not hass.data[DOMAIN].get("websocket_registered"):
        await async_register_websocket_api(hass, runtime)
        hass.data[DOMAIN]["websocket_registered"] = True
    else:
        hass.data["zeitachse_runtime"] = runtime

    if entry.options.get(
        CONF_ENABLE_DASHBOARD,
        entry.data.get(CONF_ENABLE_DASHBOARD, DEFAULT_ENABLE_DASHBOARD),
    ):
        await _async_register_panel(hass)

    hass.data[DOMAIN][entry.entry_id] = {
        "tracker": tracker,
        "runtime": runtime,
    }

    entry.async_on_unload(entry.add_update_listener(_async_update_listener))
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    runtime = hass.data[DOMAIN].pop(entry.entry_id)
    tracker: TrackingManager = runtime["tracker"]
    await tracker.async_stop()
    return True


async def _async_update_listener(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Reload on options update."""
    await hass.config_entries.async_reload(entry.entry_id)
