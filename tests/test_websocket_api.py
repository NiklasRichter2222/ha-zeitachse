"""Tests for websocket_api module."""

from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest

from custom_components.zeitachse.const import (
    CONF_PERSON_COLORS,
    CONF_TRACKED_PERSONS,
    RUNTIME_DATA_KEY,
)
from custom_components.zeitachse.websocket_api import (
    ZeitachseRuntimeData,
    _coerce_stay_settings,
    _infer_self_person,
    ws_get_poi,
    ws_get_timeline,
    ws_list_people,
    ws_set_active_people,
    ws_set_person_colors,
    ws_set_stay_settings,
)


async def call_ws(handler, hass, connection, msg):
    """Helper to unwrap async_response and await handler."""
    fn = handler
    while hasattr(fn, "__wrapped__"):
        fn = fn.__wrapped__
    return await fn(hass, connection, msg)


@pytest.fixture
def mock_runtime():
    """Mock Zeitachse runtime data."""
    config_entry = MagicMock()
    config_entry.data = {
        CONF_TRACKED_PERSONS: ["person.alice", "person.bob"],
        CONF_PERSON_COLORS: {"person.alice": "#1f77b4"},
    }
    config_entry.options = {}

    storage = MagicMock()
    preferences = MagicMock()
    poi_lookup = MagicMock()

    return ZeitachseRuntimeData(config_entry, storage, preferences, poi_lookup)


def test_coerce_stay_settings():
    """Test clamping and default fallbacks for stay settings."""
    assert _coerce_stay_settings(None) == {"min_snapshots": 6, "distance_meters": 75}
    assert _coerce_stay_settings({"min_snapshots": 1, "distance_meters": 1}) == {
        "min_snapshots": 2,  # Clamped to MIN_STAY_MIN_SNAPSHOTS
        "distance_meters": 5,  # Clamped to MIN_STAY_DISTANCE_METERS
    }
    assert _coerce_stay_settings({"min_snapshots": 9999, "distance_meters": 9999}) == {
        "min_snapshots": 500,  # Clamped to MAX_STAY_MIN_SNAPSHOTS
        "distance_meters": 2000,  # Clamped to MAX_STAY_DISTANCE_METERS
    }
    assert _coerce_stay_settings({"min_snapshots": 10, "distance_meters": 100}) == {
        "min_snapshots": 10,
        "distance_meters": 100,
    }


def test_infer_self_person():
    """Test matching user id to person entity."""
    hass = MagicMock()
    state_alice = MagicMock()
    state_alice.attributes = {"user_id": "user_123"}
    state_bob = MagicMock()
    state_bob.attributes = {"user_id": "user_456"}

    hass.states.get.side_effect = lambda eid: (
        state_alice if eid == "person.alice" else state_bob
    )

    assert (
        _infer_self_person(hass, "user_123", ["person.alice", "person.bob"])
        == "person.alice"
    )
    assert _infer_self_person(hass, "user_999", ["person.alice", "person.bob"]) is None


@pytest.mark.asyncio
async def test_ws_list_people(mock_runtime):
    """Test listing people with active states and colors."""
    hass = MagicMock()
    hass.data = {RUNTIME_DATA_KEY: mock_runtime}

    mock_runtime.preferences.async_get = AsyncMock(
        return_value={"active_people": ["person.alice"]}
    )

    person_state = MagicMock()
    person_state.attributes = {"friendly_name": "Alice"}
    hass.states.get.return_value = person_state

    connection = MagicMock()
    connection.user.id = "user_123"

    msg = {"id": 1, "type": "zeitachse/list_people"}
    await call_ws(ws_list_people, hass, connection, msg)

    connection.send_result.assert_called_once()
    args = connection.send_result.call_args[0]
    assert args[0] == 1
    people = args[1]["people"]
    assert len(people) == 2
    assert people[0]["entity_id"] == "person.alice"
    assert people[0]["active"] is True
    assert people[1]["entity_id"] == "person.bob"
    assert people[1]["active"] is False


@pytest.mark.asyncio
async def test_ws_set_active_people(mock_runtime):
    """Test setting active people preference."""
    hass = MagicMock()
    hass.data = {RUNTIME_DATA_KEY: mock_runtime}

    mock_runtime.preferences.async_set = AsyncMock()

    connection = MagicMock()
    connection.user.id = "user_123"

    msg = {
        "id": 2,
        "type": "zeitachse/set_active_people",
        "active_people": ["person.bob", "person.unknown"],
    }
    await call_ws(ws_set_active_people, hass, connection, msg)

    # Unknown person should be filtered out because they are not tracked
    mock_runtime.preferences.async_set.assert_awaited_once_with(
        "user_123", {"active_people": ["person.bob"]}
    )
    connection.send_result.assert_called_once_with(2, {"active_people": ["person.bob"]})


@pytest.mark.asyncio
async def test_ws_set_person_colors(mock_runtime):
    """Test updating person colors."""
    hass = MagicMock()
    hass.data = {RUNTIME_DATA_KEY: mock_runtime}
    hass.config_entries.async_update_entry = MagicMock()

    connection = MagicMock()
    msg = {
        "id": 3,
        "type": "zeitachse/set_person_colors",
        "person_colors": {"person.alice": "#00ff00", "person.bob": "invalid_color"},
    }
    await call_ws(ws_set_person_colors, hass, connection, msg)

    connection.send_result.assert_called_once_with(
        3, {"person_colors": {"person.alice": "#00ff00"}}
    )


@pytest.mark.asyncio
async def test_ws_set_stay_settings(mock_runtime):
    """Test updating stay settings for user."""
    hass = MagicMock()
    hass.data = {RUNTIME_DATA_KEY: mock_runtime}
    mock_runtime.preferences.async_set = AsyncMock()

    connection = MagicMock()
    connection.user.id = "user_123"

    msg = {
        "id": 4,
        "type": "zeitachse/set_stay_settings",
        "min_snapshots": 12,
        "distance_meters": 150,
    }
    await call_ws(ws_set_stay_settings, hass, connection, msg)

    mock_runtime.preferences.async_set.assert_awaited_once_with(
        "user_123", {"stay_settings": {"min_snapshots": 12, "distance_meters": 150}}
    )
    connection.send_result.assert_called_once_with(
        4, {"stay_settings": {"min_snapshots": 12, "distance_meters": 150}}
    )


@pytest.mark.asyncio
async def test_ws_get_timeline_filtering(mock_runtime):
    """Test getting timeline snapshots with time range filtering."""
    hass = MagicMock()
    hass.data = {RUNTIME_DATA_KEY: mock_runtime}

    mock_runtime.snapshot_storage.async_get_person_timeline = AsyncMock(
        return_value=[
            {
                "timestamp": "2026-01-01T10:00:00+00:00",
                "latitude": 52.52,
                "longitude": 13.40,
            },
            {
                "timestamp": "2026-01-01T11:00:00+00:00",
                "latitude": 52.53,
                "longitude": 13.41,
            },
            {
                "timestamp": "2026-01-01T12:00:00+00:00",
                "latitude": 52.54,
                "longitude": 13.42,
            },
        ]
    )

    connection = MagicMock()
    connection.user.id = "user_123"

    # Query range 10:30 to 11:30 (only 11:00 should match)
    msg = {
        "id": 5,
        "type": "zeitachse/get_timeline",
        "entity_id": "person.alice",
        "start": datetime(2026, 1, 1, 10, 30, tzinfo=timezone.utc),
        "end": datetime(2026, 1, 1, 11, 30, tzinfo=timezone.utc),
    }
    await call_ws(ws_get_timeline, hass, connection, msg)

    connection.send_result.assert_called_once()
    result = connection.send_result.call_args[0][1]
    assert len(result["timeline"]) == 1
    assert result["timeline"][0]["timestamp"] == "2026-01-01T11:00:00+00:00"


@pytest.mark.asyncio
async def test_ws_get_timeline_not_tracked(mock_runtime):
    """Test timeline request for an untracked person returns error."""
    hass = MagicMock()
    hass.data = {RUNTIME_DATA_KEY: mock_runtime}

    connection = MagicMock()
    connection.user.id = "user_123"

    msg = {
        "id": 6,
        "type": "zeitachse/get_timeline",
        "entity_id": "person.not_tracked",
    }
    await call_ws(ws_get_timeline, hass, connection, msg)

    connection.send_error.assert_called_once_with(
        6, "not_tracked", "Person is not configured for tracking"
    )


@pytest.mark.asyncio
async def test_ws_get_poi(mock_runtime):
    """Test websocket POI lookup."""
    hass = MagicMock()
    hass.data = {RUNTIME_DATA_KEY: mock_runtime}

    mock_runtime.poi_lookup.async_lookup = AsyncMock(
        return_value={"name": "Reichstag", "category": "tourism"}
    )

    connection = MagicMock()
    msg = {
        "id": 7,
        "type": "zeitachse/get_poi",
        "latitude": 52.5186,
        "longitude": 13.3761,
    }
    await call_ws(ws_get_poi, hass, connection, msg)

    connection.send_result.assert_called_once_with(
        7, {"poi": {"name": "Reichstag", "category": "tourism"}}
    )
