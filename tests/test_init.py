"""Tests for __init__ module."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from custom_components.zeitachse import (
    TrackingManager,
    _maybe_await,
    async_setup,
    async_setup_entry,
    async_unload_entry,
)
from custom_components.zeitachse.const import (
    CONF_ENABLE_DASHBOARD,
    CONF_ENCRYPTION_KEY,
    CONF_INTERVAL_MINUTES,
    CONF_TRACKED_PERSONS,
    DOMAIN,
)


@pytest.mark.asyncio
async def test_maybe_await():
    """Test _maybe_await handles both sync and async return values."""
    await _maybe_await(None)
    await _maybe_await(42)

    called = False

    async def _async_fn():
        nonlocal called
        called = True

    await _maybe_await(_async_fn())
    assert called is True


@pytest.mark.asyncio
async def test_tracking_manager_snapshot_collection():
    """Test TrackingManager collects snapshots for tracked entities with coordinates."""
    hass = MagicMock()
    entry = MagicMock()
    entry.options = {}
    entry.data = {
        CONF_TRACKED_PERSONS: ["person.alice", "person.bob", "person.no_coords"],
        CONF_INTERVAL_MINUTES: 5,
    }

    storage = MagicMock()
    storage.async_append = AsyncMock()

    # Alice has coordinates
    alice_state = MagicMock()
    alice_state.state = "home"
    alice_state.attributes = {"latitude": 52.52, "longitude": 13.40}

    # Bob does not exist in states
    # no_coords has no coordinates
    no_coords_state = MagicMock()
    no_coords_state.state = "not_home"
    no_coords_state.attributes = {}

    def _get_state(eid):
        if eid == "person.alice":
            return alice_state
        if eid == "person.no_coords":
            return no_coords_state
        return None

    hass.states.get.side_effect = _get_state

    manager = TrackingManager(hass, entry, storage)
    await manager._async_collect_snapshot()

    # Only Alice should have snapshot stored
    storage.async_append.assert_awaited_once()
    person, snapshot = storage.async_append.call_args[0]
    assert person == "person.alice"
    assert snapshot["latitude"] == 52.52
    assert snapshot["longitude"] == 13.40
    assert snapshot["state"] == "home"
    assert "timestamp" in snapshot


@pytest.mark.asyncio
async def test_tracking_manager_start_and_stop():
    """Test starting and stopping tracking timer."""
    hass = MagicMock()
    entry = MagicMock()
    entry.options = {CONF_INTERVAL_MINUTES: 10}
    storage = MagicMock()

    unsub_mock = MagicMock()
    with patch(
        "custom_components.zeitachse.async_track_time_interval", return_value=unsub_mock
    ) as mock_track:
        manager = TrackingManager(hass, entry, storage)
        await manager.async_start()
        mock_track.assert_called_once()

        await manager.async_stop()
        unsub_mock.assert_called_once()
        assert manager._unsub is None


@pytest.mark.asyncio
async def test_async_setup():
    """Test YAML setup returns True and initializes domain dict."""
    hass = MagicMock()
    hass.data = {}
    result = await async_setup(hass, {})
    assert result is True
    assert DOMAIN in hass.data


@pytest.mark.asyncio
async def test_async_setup_and_unload_entry():
    """Test setting up and unloading a config entry."""
    hass = MagicMock()
    hass.data = {DOMAIN: {}}
    hass.config.path.side_effect = lambda path: f"/ha_config/{path}"

    entry = MagicMock()
    entry.entry_id = "entry_123"
    entry.data = {
        CONF_ENCRYPTION_KEY: "WMaIMi99JUsKmIBILtrlgH0DABh6ImWSaJ0QX2RxpRg=",
        CONF_TRACKED_PERSONS: ["person.alice"],
        CONF_INTERVAL_MINUTES: 5,
        CONF_ENABLE_DASHBOARD: False,
    }
    entry.options = {}
    entry.async_on_unload = MagicMock()
    entry.add_update_listener = MagicMock()

    with (
        patch(
            "custom_components.zeitachse.TrackingManager.async_start",
            new_callable=AsyncMock,
        ) as mock_start,
        patch(
            "custom_components.zeitachse.TrackingManager.async_stop",
            new_callable=AsyncMock,
        ) as mock_stop,
        patch(
            "custom_components.zeitachse.async_register_websocket_api",
            new_callable=AsyncMock,
        ) as mock_ws,
        patch("custom_components.zeitachse.PoiLookupService"),
    ):
        setup_success = await async_setup_entry(hass, entry)
        assert setup_success is True
        mock_start.assert_awaited_once()
        mock_ws.assert_awaited_once()
        assert entry.entry_id in hass.data[DOMAIN]

        unload_success = await async_unload_entry(hass, entry)
        assert unload_success is True
        mock_stop.assert_awaited_once()
        assert entry.entry_id not in hass.data[DOMAIN]
