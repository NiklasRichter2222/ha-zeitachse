"""WebSocket API for Zeitachse panel."""

from __future__ import annotations

from datetime import UTC, datetime
import logging
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
    WS_SET_ACTIVE_PEOPLE,
    WS_SET_PERSON_COLORS,
    WS_SET_STAY_SETTINGS,
)
from .poi_lookup import PoiLookupService
from .storage import EncryptedSnapshotStorage, UserPreferenceStorage

_LOGGER = logging.getLogger(__name__)


class ZeitachseRuntimeData:
    """Runtime objects used by websocket commands."""

    def __init__(
        self,
        config_entry: ConfigEntry,
        snapshot_storage: EncryptedSnapshotStorage,
        preferences: UserPreferenceStorage,
        poi_lookup: PoiLookupService,
    ) -> None:
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


def _infer_self_person(hass: HomeAssistant, user_id: str, person_ids: list[str]) -> str | None:
    """Resolve the matching person entity for a user id."""
    for entity_id in person_ids:
        state = hass.states.get(entity_id)
        if state and state.attributes.get("user_id") == user_id:
            return entity_id
    return None


async def _get_active_persons(
    hass: HomeAssistant,
    runtime: ZeitachseRuntimeData,
    user_id: str,
) -> set[str]:
    """Return active persons for a user, defaulting to self when unset."""
    prefs = await runtime.preferences.async_get(user_id)
    active_people = set(prefs.get("active_people", []))
    tracked_people = set(runtime.tracked_persons)

    if active_people:
        return active_people & tracked_people

    self_person = _infer_self_person(hass, user_id, runtime.tracked_persons)
    return {self_person} if self_person else set()


def _person_payload(hass: HomeAssistant, person_entity_id: str, color: str, active: bool) -> dict[str, Any]:
    state = hass.states.get(person_entity_id)
    return {
        "entity_id": person_entity_id,
        "name": state.attributes.get("friendly_name", person_entity_id) if state else person_entity_id,
        "color": color,
        "active": active,
    }


def _is_valid_hex_color(value: Any) -> bool:
    """Validate #RRGGBB color format."""
    if not isinstance(value, str) or len(value) != 7 or not value.startswith("#"):
        return False
    try:
        int(value[1:], 16)
    except ValueError:
        return False
    return True


async def _get_person_colors(runtime: ZeitachseRuntimeData, user_id: str) -> dict[str, str]:
    """Return configured person colors for tracked people."""
    del user_id
    raw = runtime.config_entry.options.get(
        CONF_PERSON_COLORS,
        runtime.config_entry.data.get(CONF_PERSON_COLORS, {}),
    )
    color_map = raw if isinstance(raw, dict) else {}
    return {
        entity_id: (
            color_map.get(entity_id)
            if _is_valid_hex_color(color_map.get(entity_id))
            else COLOR_PALETTE[index % len(COLOR_PALETTE)]
        )
        for index, entity_id in enumerate(runtime.tracked_persons)
    }


def _clamp(value: int, minimum: int, maximum: int) -> int:
    """Clamp value to bounds."""
    return max(minimum, min(maximum, value))


def _coerce_stay_settings(raw: Any) -> dict[str, int]:
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
        "min_snapshots": _clamp(min_snapshots, MIN_STAY_MIN_SNAPSHOTS, MAX_STAY_MIN_SNAPSHOTS),
        "distance_meters": _clamp(distance_meters, MIN_STAY_DISTANCE_METERS, MAX_STAY_DISTANCE_METERS),
    }


async def _get_stay_settings(runtime: ZeitachseRuntimeData, user_id: str) -> dict[str, int]:
    """Return configured stay detection settings."""
    del user_id
    return _coerce_stay_settings(
        {
            "min_snapshots": runtime.config_entry.options.get(
                CONF_STAY_MIN_SNAPSHOTS,
                runtime.config_entry.data.get(CONF_STAY_MIN_SNAPSHOTS, DEFAULT_STAY_MIN_SNAPSHOTS),
            ),
            "distance_meters": runtime.config_entry.options.get(
                CONF_STAY_DISTANCE_METERS,
                runtime.config_entry.data.get(CONF_STAY_DISTANCE_METERS, DEFAULT_STAY_DISTANCE_METERS),
            ),
        }
    )


@websocket_api.websocket_command({vol.Required("type"): WS_LIST_PEOPLE})
@websocket_api.async_response
async def ws_list_people(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """List tracked people and active state for current user."""
    runtime: ZeitachseRuntimeData = hass.data[RUNTIME_DATA_KEY]
    active = await _get_active_persons(hass, runtime, connection.user.id)
    custom_colors = await _get_person_colors(runtime, connection.user.id)
    stay_settings = await _get_stay_settings(runtime, connection.user.id)
    people = [
        _person_payload(
            hass,
            entity_id,
            custom_colors.get(entity_id, COLOR_PALETTE[index % len(COLOR_PALETTE)]),
            entity_id in active,
        )
        for index, entity_id in enumerate(runtime.tracked_persons)
    ]
    connection.send_result(msg["id"], {"people": people, "stay_settings": stay_settings})


@websocket_api.websocket_command(
    {
        vol.Required("type"): WS_SET_ACTIVE_PEOPLE,
        vol.Required("active_people"): [cv.entity_id],
    }
)
@websocket_api.async_response
async def ws_set_active_people(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Set active people for the current user."""
    runtime: ZeitachseRuntimeData = hass.data[RUNTIME_DATA_KEY]
    tracked = set(runtime.tracked_persons)
    active = [entity_id for entity_id in msg["active_people"] if entity_id in tracked]
    await runtime.preferences.async_set(connection.user.id, {"active_people": active})
    connection.send_result(msg["id"], {"active_people": active})


@websocket_api.websocket_command(
    {
        vol.Required("type"): WS_SET_PERSON_COLORS,
        vol.Required("person_colors"): dict,
    }
)
@websocket_api.async_response
async def ws_set_person_colors(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Set custom person colors for the current user."""
    runtime: ZeitachseRuntimeData = hass.data[RUNTIME_DATA_KEY]
    tracked = set(runtime.tracked_persons)
    incoming = msg["person_colors"]
    colors = {
        entity_id: color
        for entity_id, color in incoming.items()
        if entity_id in tracked and _is_valid_hex_color(color)
    }
    await runtime.preferences.async_set(connection.user.id, {"person_colors": colors})
    connection.send_result(msg["id"], {"person_colors": colors})


@websocket_api.websocket_command(
    {
        vol.Required("type"): WS_SET_STAY_SETTINGS,
        vol.Required("min_snapshots"): vol.All(
            vol.Coerce(int),
            vol.Range(min=MIN_STAY_MIN_SNAPSHOTS, max=MAX_STAY_MIN_SNAPSHOTS),
        ),
        vol.Required("distance_meters"): vol.All(
            vol.Coerce(int),
            vol.Range(min=MIN_STAY_DISTANCE_METERS, max=MAX_STAY_DISTANCE_METERS),
        ),
    }
)
@websocket_api.async_response
async def ws_set_stay_settings(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Set stay detection settings for the current user."""
    runtime: ZeitachseRuntimeData = hass.data[RUNTIME_DATA_KEY]
    settings = {
        "min_snapshots": msg["min_snapshots"],
        "distance_meters": msg["distance_meters"],
    }
    await runtime.preferences.async_set(connection.user.id, {"stay_settings": settings})
    connection.send_result(msg["id"], {"stay_settings": settings})


@websocket_api.websocket_command(
    {
        vol.Required("type"): WS_GET_TIMELINE,
        vol.Required("entity_id"): cv.entity_id,
        vol.Optional("start"): cv.datetime,
        vol.Optional("end"): cv.datetime,
    }
)
@websocket_api.async_response
async def ws_get_timeline(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Get timeline snapshots for one person."""
    runtime: ZeitachseRuntimeData = hass.data[RUNTIME_DATA_KEY]
    entity_id = msg["entity_id"]
    _LOGGER.debug(
        "Timeline request received: user_id=%s entity_id=%s start=%s end=%s",
        connection.user.id,
        entity_id,
        msg.get("start"),
        msg.get("end"),
    )
    if entity_id not in runtime.tracked_persons:
        _LOGGER.debug("Timeline request rejected: entity %s is not tracked", entity_id)
        connection.send_error(msg["id"], "not_tracked", "Person is not configured for tracking")
        return

    timeline = await runtime.snapshot_storage.async_get_person_timeline(entity_id)
    _LOGGER.debug("Loaded %d snapshots for entity %s before filtering", len(timeline), entity_id)
    start: datetime | None = msg.get("start")
    end: datetime | None = msg.get("end")
    if start and start.tzinfo is None:
        start = start.replace(tzinfo=UTC)
    if end and end.tzinfo is None:
        end = end.replace(tzinfo=UTC)

    if start or end:
        filtered: list[dict[str, Any]] = []
        dropped_invalid = 0
        for item in timeline:
            try:
                ts = datetime.fromisoformat(item["timestamp"])
                if ts.tzinfo is None:
                    ts = ts.replace(tzinfo=UTC)
            except (KeyError, ValueError, TypeError):
                dropped_invalid += 1
                continue
            if start and ts < start:
                continue
            if end and ts > end:
                continue
            filtered.append(item)
        timeline = filtered
        _LOGGER.debug(
            "Timeline filtered for %s: remaining=%d dropped_invalid=%d",
            entity_id,
            len(timeline),
            dropped_invalid,
        )

    _LOGGER.debug("Sending timeline response: entity_id=%s snapshots=%d", entity_id, len(timeline))
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
    poi = await runtime.poi_lookup.async_lookup(msg["latitude"], msg["longitude"])
    connection.send_result(msg["id"], {"poi": poi})


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
