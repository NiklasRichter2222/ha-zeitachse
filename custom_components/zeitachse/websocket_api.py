"""WebSocket API for Zeitachse panel."""

from __future__ import annotations

import inspect
import logging
from datetime import UTC, datetime
from typing import Any

import voluptuous as vol
from homeassistant.components import websocket_api
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv

from .const import (
    COLOR_PALETTE,
    CONF_PERSON_COLORS,
    CONF_STAY_DISTANCE_METERS,
    CONF_STAY_MIN_SNAPSHOTS,
    CONF_TRACKED_PERSONS,
    DEFAULT_STAY_DISTANCE_METERS,
    DEFAULT_STAY_MIN_SNAPSHOTS,
    MAX_STAY_DISTANCE_METERS,
    MAX_STAY_MIN_SNAPSHOTS,
    MIN_STAY_DISTANCE_METERS,
    MIN_STAY_MIN_SNAPSHOTS,
    RUNTIME_DATA_KEY,
    WS_GET_POI,
    WS_GET_TIMELINE,
    WS_LIST_PEOPLE,
    WS_PRELOAD_POIS,
    WS_SET_ACTIVE_PEOPLE,
    WS_SET_PERSON_COLORS,
    WS_SET_STAY_SETTINGS,
)
from .poi_lookup import PoiLookupService
from .storage import EncryptedSnapshotStorage, UserPreferenceStorage

_LOGGER = logging.getLogger(__name__)


async def _maybe_await(value: Any) -> Any:
    """Await value if awaitable."""
    if inspect.isawaitable(value):
        return await value
    return value


def _to_utc_datetime(val: Any) -> datetime | None:
    """Convert input string or datetime to UTC datetime."""
    if isinstance(val, datetime):
        return val if val.tzinfo else val.replace(tzinfo=UTC)
    if isinstance(val, str):
        try:
            dt = datetime.fromisoformat(val)
            return dt if dt.tzinfo else dt.replace(tzinfo=UTC)
        except (ValueError, TypeError):
            return None
    return None


class ZeitachseRuntimeData:
    """Runtime objects used by websocket commands."""

    def __init__(
        self,
        config_entry: ConfigEntry,
        snapshot_storage: EncryptedSnapshotStorage,
        preferences: UserPreferenceStorage,
        poi_lookup: PoiLookupService,
    ) -> None:
        """Initialize runtime data."""
        self.config_entry = config_entry
        self.snapshot_storage = snapshot_storage
        self.preferences = preferences
        self.poi_lookup = poi_lookup

    @property
    def tracked_persons(self) -> list[str]:
        """Return tracked persons from options or entry data."""
        return self.config_entry.options.get(
            CONF_TRACKED_PERSONS,
            self.config_entry.data.get(CONF_TRACKED_PERSONS, []),
        )


def _clamp(value: int, min_val: int, max_val: int) -> int:
    """Clamp integer value between bounds."""
    return max(min_val, min(value, max_val))


def _coerce_stay_settings(raw: dict[str, Any] | None) -> dict[str, int]:
    """Normalize stay detection settings."""
    if not isinstance(raw, dict):
        return {
            "min_snapshots": DEFAULT_STAY_MIN_SNAPSHOTS,
            "distance_meters": DEFAULT_STAY_DISTANCE_METERS,
        }
    min_snapshots = raw.get("min_snapshots")
    distance_meters = raw.get("distance_meters")
    if not isinstance(min_snapshots, int):
        min_snapshots = DEFAULT_STAY_MIN_SNAPSHOTS
    if not isinstance(distance_meters, int):
        distance_meters = DEFAULT_STAY_DISTANCE_METERS
    return {
        "min_snapshots": _clamp(
            min_snapshots, MIN_STAY_MIN_SNAPSHOTS, MAX_STAY_MIN_SNAPSHOTS
        ),
        "distance_meters": _clamp(
            distance_meters, MIN_STAY_DISTANCE_METERS, MAX_STAY_DISTANCE_METERS
        ),
    }


def _infer_self_person(
    hass: HomeAssistant, user_id: str, person_ids: list[str]
) -> str | None:
    """Resolve the matching person entity for a user id."""
    for entity_id in person_ids:
        state = hass.states.get(entity_id)
        if state and state.attributes.get("user_id") == user_id:
            return entity_id
    return None


@websocket_api.websocket_command({vol.Required("type"): WS_LIST_PEOPLE})
@websocket_api.async_response
async def ws_list_people(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """List tracked people and user preferences."""
    runtime: ZeitachseRuntimeData = hass.data[RUNTIME_DATA_KEY]
    entry = runtime.config_entry
    configured_people = entry.options.get(
        CONF_TRACKED_PERSONS,
        entry.data.get(CONF_TRACKED_PERSONS, []),
    )
    prefs = await _maybe_await(runtime.preferences.async_load())
    if not isinstance(prefs, dict):
        prefs = {}
    active_people = prefs.get("active_people")
    if active_people is None:
        active_people = configured_people
    active_set = set(active_people)

    color_mapping = dict(
        entry.options.get(
            CONF_PERSON_COLORS,
            entry.data.get(CONF_PERSON_COLORS, {}),
        )
    )
    custom_colors = prefs.get("person_colors", {})
    color_mapping.update(custom_colors)

    stay_settings = prefs.get("stay_settings", {})

    people = []
    for idx, entity_id in enumerate(configured_people):
        state = hass.states.get(entity_id)
        name = entity_id
        if state is not None:
            name = (
                state.attributes.get("friendly_name")
                or state.name
                or entity_id
            )
        color = color_mapping.get(entity_id) or COLOR_PALETTE[idx % len(COLOR_PALETTE)]
        people.append(
            {
                "entity_id": entity_id,
                "name": name,
                "color": color,
                "active": entity_id in active_set,
            }
        )

    connection.send_result(
        msg["id"],
        {
            "people": people,
            "stay_settings": {
                "min_snapshots": stay_settings.get(
                    CONF_STAY_MIN_SNAPSHOTS,
                    entry.options.get(
                        CONF_STAY_MIN_SNAPSHOTS,
                        entry.data.get(
                            CONF_STAY_MIN_SNAPSHOTS, DEFAULT_STAY_MIN_SNAPSHOTS
                        ),
                    ),
                ),
                "distance_meters": stay_settings.get(
                    CONF_STAY_DISTANCE_METERS,
                    entry.options.get(
                        CONF_STAY_DISTANCE_METERS,
                        entry.data.get(
                            CONF_STAY_DISTANCE_METERS, DEFAULT_STAY_DISTANCE_METERS
                        ),
                    ),
                ),
            },
        },
    )


@websocket_api.websocket_command(
    {
        vol.Required("type"): WS_SET_ACTIVE_PEOPLE,
        vol.Required("active_people"): [cv.string],
    }
)
@websocket_api.async_response
async def ws_set_active_people(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Set active person filters for UI."""
    runtime: ZeitachseRuntimeData = hass.data[RUNTIME_DATA_KEY]
    active_people = msg["active_people"]
    await _maybe_await(runtime.preferences.async_set_active_people(active_people))
    connection.send_result(msg["id"], {"status": "ok"})


@websocket_api.websocket_command(
    {
        vol.Required("type"): WS_SET_PERSON_COLORS,
        vol.Required("person_colors"): {cv.string: cv.string},
    }
)
@websocket_api.async_response
async def ws_set_person_colors(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Set custom color palette for persons."""
    runtime: ZeitachseRuntimeData = hass.data[RUNTIME_DATA_KEY]
    person_colors = msg["person_colors"]
    await _maybe_await(runtime.preferences.async_set_person_colors(person_colors))
    connection.send_result(msg["id"], {"status": "ok"})


@websocket_api.websocket_command(
    {
        vol.Required("type"): WS_SET_STAY_SETTINGS,
        vol.Required("min_snapshots"): vol.All(
            vol.Coerce(int), vol.Range(min=MIN_STAY_MIN_SNAPSHOTS, max=MAX_STAY_MIN_SNAPSHOTS)
        ),
        vol.Required("distance_meters"): vol.All(
            vol.Coerce(int), vol.Range(min=MIN_STAY_DISTANCE_METERS, max=MAX_STAY_DISTANCE_METERS)
        ),
    }
)
@websocket_api.async_response
async def ws_set_stay_settings(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Set custom stay detection thresholds for UI."""
    runtime: ZeitachseRuntimeData = hass.data[RUNTIME_DATA_KEY]
    min_snapshots = msg["min_snapshots"]
    distance_meters = msg["distance_meters"]
    await _maybe_await(
        runtime.preferences.async_set_stay_settings(min_snapshots, distance_meters)
    )
    connection.send_result(msg["id"], {"status": "ok"})


@websocket_api.websocket_command(
    {
        vol.Required("type"): WS_GET_TIMELINE,
        vol.Required("entity_id"): cv.string,
        vol.Optional("start"): vol.Any(cv.string, cv.datetime),
        vol.Optional("end"): vol.Any(cv.string, cv.datetime),
    }
)
@websocket_api.async_response
async def ws_get_timeline(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Get location history timeline for a tracked person."""
    runtime: ZeitachseRuntimeData = hass.data[RUNTIME_DATA_KEY]
    entity_id = msg["entity_id"]
    if entity_id not in runtime.tracked_persons:
        connection.send_error(
            msg["id"], "not_tracked", "Person is not configured for tracking"
        )
        return

    start_dt = _to_utc_datetime(msg.get("start"))
    end_dt = _to_utc_datetime(msg.get("end"))

    raw_timeline = await _maybe_await(
        runtime.snapshot_storage.async_get_person_timeline(entity_id)
    )
    timeline = raw_timeline if isinstance(raw_timeline, list) else []

    if start_dt or end_dt:
        filtered = []
        for item in timeline:
            ts_str = item.get("timestamp")
            if not isinstance(ts_str, str):
                continue
            ts = _to_utc_datetime(ts_str)
            if ts is None:
                continue
            if start_dt and ts < start_dt:
                continue
            if end_dt and ts > end_dt:
                continue
            filtered.append(item)
        timeline = filtered

    connection.send_result(msg["id"], {"timeline": timeline})


@websocket_api.websocket_command(
    {
        vol.Required("type"): WS_GET_POI,
        vol.Required("latitude"): vol.Coerce(float),
        vol.Required("longitude"): vol.Coerce(float),
    }
)
@websocket_api.async_response
async def ws_get_poi(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Get POI information for one coordinate."""
    runtime: ZeitachseRuntimeData = hass.data[RUNTIME_DATA_KEY]
    poi = await _maybe_await(
        runtime.poi_lookup.async_lookup(msg["latitude"], msg["longitude"])
    )
    connection.send_result(msg["id"], {"poi": poi})


@websocket_api.websocket_command({vol.Required("type"): WS_PRELOAD_POIS})
@websocket_api.async_response
async def ws_preload_pois(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Preload and persist POIs for all stay locations."""
    runtime: ZeitachseRuntimeData = hass.data[RUNTIME_DATA_KEY]
    prefs = await _maybe_await(runtime.preferences.async_load())
    if not isinstance(prefs, dict):
        prefs = {}
    stay_settings = prefs.get("stay_settings", {})
    entry = runtime.config_entry
    min_snapshots = stay_settings.get(
        CONF_STAY_MIN_SNAPSHOTS,
        entry.options.get(
            CONF_STAY_MIN_SNAPSHOTS,
            entry.data.get(CONF_STAY_MIN_SNAPSHOTS, DEFAULT_STAY_MIN_SNAPSHOTS),
        ),
    )
    distance_meters = stay_settings.get(
        CONF_STAY_DISTANCE_METERS,
        entry.options.get(
            CONF_STAY_DISTANCE_METERS,
            entry.data.get(CONF_STAY_DISTANCE_METERS, DEFAULT_STAY_DISTANCE_METERS),
        ),
    )
    result = await _maybe_await(
        runtime.poi_lookup.async_preload_all_pois(
            runtime.snapshot_storage, min_snapshots, distance_meters
        )
    )
    connection.send_result(msg["id"], result)


async def async_register_websocket_api(
    hass: HomeAssistant,
    runtime: ZeitachseRuntimeData,
) -> None:
    """Register websocket commands for Zeitachse."""
    hass.data[RUNTIME_DATA_KEY] = runtime
    websocket_api.async_register_command(hass, ws_list_people)
    websocket_api.async_register_command(hass, ws_set_active_people)
    websocket_api.async_register_command(hass, ws_set_person_colors)
    websocket_api.async_register_command(hass, ws_set_stay_settings)
    websocket_api.async_register_command(hass, ws_get_timeline)
    websocket_api.async_register_command(hass, ws_get_poi)
    websocket_api.async_register_command(hass, ws_preload_pois)
