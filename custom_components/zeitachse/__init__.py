"""Zeitachse integration."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
import inspect
import logging
from typing import Any

from homeassistant.components import frontend, panel_custom
from homeassistant.components.http import StaticPathConfig
from homeassistant.const import EVENT_HOMEASSISTANT_STARTED
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.event import async_call_later, async_track_time_interval
from homeassistant.helpers.typing import ConfigType
from homeassistant.loader import async_get_integration

from .const import (
    CONF_ENABLE_DASHBOARD,
    CONF_ENCRYPTION_KEY,
    CONF_INTERVAL_MINUTES,
    CONF_TRACKED_PERSONS,
    DEFAULT_ENABLE_DASHBOARD,
    DEFAULT_INTERVAL_MINUTES,
    DOMAIN,
    RUNTIME_DATA_KEY,
    SNAPSHOT_STORAGE_FILE,
)
from .poi_lookup import PoiLookupService
from .storage import EncryptedSnapshotStorage, UserPreferenceStorage
from .websocket_api import ZeitachseRuntimeData, async_register_websocket_api

_LOGGER = logging.getLogger(__name__)
PANEL_REGISTRATION_RETRY_DELAY = 30
FRONTEND_URL_PATH = "/zeitachse_static"


async def _maybe_await(value: Any) -> None:
    """Await value when it is awaitable."""
    if inspect.isawaitable(value):
        await value


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
        tracked_persons = self._tracked_persons()
        stored_count = 0
        failed_count = 0
        _LOGGER.debug(
            "Collecting Zeitachse snapshots at %s for %d tracked persons",
            now,
            len(tracked_persons),
        )
        for person_entity_id in tracked_persons:
            state = self._hass.states.get(person_entity_id)
            if state is None:
                _LOGGER.debug("Skipping snapshot for %s: state not found", person_entity_id)
                continue
            latitude = state.attributes.get("latitude")
            longitude = state.attributes.get("longitude")
            if latitude is None or longitude is None:
                _LOGGER.debug(
                    "Skipping snapshot for %s: missing coordinates",
                    person_entity_id,
                )
                continue

            snapshot = {
                "timestamp": now,
                "latitude": latitude,
                "longitude": longitude,
                "state": state.state,
            }
            try:
                await self._storage.async_append(person_entity_id, snapshot)
                stored_count += 1
                _LOGGER.debug(
                    "Stored snapshot for %s with state '%s'",
                    person_entity_id,
                    state.state,
                )
            except Exception:  # noqa: BLE001
                failed_count += 1
                _LOGGER.exception("Failed to store snapshot for %s", person_entity_id)

        _LOGGER.debug(
            "Finished Zeitachse snapshot collection at %s: stored=%d, failed=%d",
            now,
            stored_count,
            failed_count,
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
                FRONTEND_URL_PATH,
                hass.config.path("custom_components/zeitachse/frontend"),
                False,
            )
        ]
    )
    integration = await async_get_integration(hass, DOMAIN)
    panel_module_url = f"{FRONTEND_URL_PATH}/zeitachse-panel.js?v={integration.version}"
    panel_registration = panel_custom.async_register_panel(
        hass,
        webcomponent_name="zeitachse-panel",
        frontend_url_path="zeitachse",
        module_url=panel_module_url,
        sidebar_title="Zeitachse",
        sidebar_icon="mdi:timeline-clock",
        require_admin=False,
        config={},
    )
    await _maybe_await(panel_registration)
    card_module_url = f"{FRONTEND_URL_PATH}/zeitachse-card.js?v={integration.version}"
    if hasattr(frontend, "async_add_extra_js_url"):
        add_result = frontend.async_add_extra_js_url(hass, card_module_url)
        await _maybe_await(add_result)
    elif hasattr(frontend, "add_extra_js_url"):
        frontend.add_extra_js_url(hass, card_module_url)
    hass.data[DOMAIN]["panel_registered"] = True


def _schedule_panel_registration(hass: HomeAssistant) -> None:
    """Register now, retry at startup, then retry once again after a short delay."""
    async def _async_try_register_panel(context: str) -> None:
        if hass.data[DOMAIN].get("panel_registered"):
            return
        try:
            await _async_register_panel(hass)
        except Exception:  # noqa: BLE001
            _LOGGER.exception(
                "Failed to register Zeitachse sidebar panel (%s)",
                context,
            )

    hass.async_create_task(_async_try_register_panel("initial attempt"))

    async def _async_retry_register_panel(_: Any) -> None:
        if hass.data[DOMAIN].get("panel_registered"):
            return
        await _async_try_register_panel("startup retry")
        if not hass.data[DOMAIN].get("panel_registered"):
            async_call_later(
                hass,
                PANEL_REGISTRATION_RETRY_DELAY,
                _async_delayed_retry_register_panel,
            )

    async def _async_delayed_retry_register_panel(_: Any) -> None:
        await _async_try_register_panel("delayed retry")

    hass.bus.async_listen_once(EVENT_HOMEASSISTANT_STARTED, _async_retry_register_panel)


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
    poi_lookup = PoiLookupService(hass)
    tracker = TrackingManager(hass, entry, storage)
    await tracker.async_start()

    runtime = ZeitachseRuntimeData(entry, storage, preferences, poi_lookup)
    if not hass.data[DOMAIN].get("websocket_registered"):
        await async_register_websocket_api(hass, runtime)
        hass.data[DOMAIN]["websocket_registered"] = True
    else:
        hass.data[RUNTIME_DATA_KEY] = runtime

    if entry.options.get(
        CONF_ENABLE_DASHBOARD,
        entry.data.get(CONF_ENABLE_DASHBOARD, DEFAULT_ENABLE_DASHBOARD),
    ):
        _schedule_panel_registration(hass)

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
