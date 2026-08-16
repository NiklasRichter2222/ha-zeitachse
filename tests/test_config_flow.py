"""Tests for config_flow module."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from custom_components.zeitachse.config_flow import (
    ZeitachseConfigFlow,
    ZeitachseOptionsFlow,
    _is_valid_hex_color,
    _normalize_person_colors,
)
from custom_components.zeitachse.const import (
    CONF_ENABLE_DASHBOARD,
    CONF_ENCRYPTION_KEY,
    CONF_INTERVAL_MINUTES,
    CONF_PERSON_COLORS,
    CONF_REPLACE_TRACKING_DATA,
    CONF_STAY_DISTANCE_METERS,
    CONF_STAY_MIN_SNAPSHOTS,
    CONF_TRACKED_PERSONS,
)


def test_is_valid_hex_color():
    """Test hex color validation."""
    assert _is_valid_hex_color("#1f77b4") is True
    assert _is_valid_hex_color("#FFFFFF") is True
    assert _is_valid_hex_color("#000000") is True
    assert _is_valid_hex_color("1f77b4") is False
    assert _is_valid_hex_color("#12345") is False
    assert _is_valid_hex_color("#GGGGGG") is False
    assert _is_valid_hex_color(None) is False
    assert _is_valid_hex_color(123) is False


def test_normalize_person_colors():
    """Test normalization and palette fallback for person colors."""
    tracked = ["person.alice", "person.bob"]
    colors = _normalize_person_colors(
        tracked, {"person.alice": "#ff0000", "person.bob": "invalid"}
    )
    assert colors["person.alice"] == "#ff0000"
    # Fallback to palette color for invalid color
    assert colors["person.bob"].startswith("#")
    assert len(colors["person.bob"]) == 7


@pytest.mark.asyncio
async def test_config_flow_user_step_initial():
    """Test displaying the user configuration form."""
    flow = ZeitachseConfigFlow()
    flow.hass = MagicMock()
    flow.hass.config_entries.async_entries.return_value = []

    result = await flow.async_step_user()
    assert result["type"] == "form"
    assert result["step_id"] == "user"


@pytest.mark.asyncio
async def test_config_flow_user_step_create_entry():
    """Test creating an entry through the user flow."""
    flow = ZeitachseConfigFlow()
    flow.hass = MagicMock()
    flow.hass.config_entries.async_entries.return_value = []

    user_input = {
        "name": "Zeitachse",
        CONF_TRACKED_PERSONS: ["person.alice"],
        CONF_INTERVAL_MINUTES: 5,
        CONF_ENABLE_DASHBOARD: True,
        CONF_PERSON_COLORS: {"person.alice": "#1f77b4"},
        CONF_STAY_MIN_SNAPSHOTS: 6,
        CONF_STAY_DISTANCE_METERS: 75,
    }

    result = await flow.async_step_user(user_input)
    assert result["type"] == "create_entry"
    assert result["title"] == "Zeitachse"
    assert result["data"][CONF_TRACKED_PERSONS] == ["person.alice"]
    assert result["data"][CONF_INTERVAL_MINUTES] == 5
    assert CONF_ENCRYPTION_KEY in result["data"]


@pytest.mark.asyncio
async def test_config_flow_abort_if_already_configured():
    """Test single instance constraint."""
    flow = ZeitachseConfigFlow()
    flow.hass = MagicMock()
    existing_entry = MagicMock()
    flow.hass.config_entries.async_entries.return_value = [existing_entry]

    result = await flow.async_step_user()
    assert result["type"] == "abort"
    assert result["reason"] == "single_instance_allowed"


@pytest.mark.asyncio
async def test_options_flow_update():
    """Test updating options through options flow."""
    config_entry = MagicMock()
    config_entry.data = {
        CONF_ENCRYPTION_KEY: "dummykey",
        CONF_TRACKED_PERSONS: ["person.alice"],
        CONF_INTERVAL_MINUTES: 5,
        CONF_ENABLE_DASHBOARD: True,
        CONF_PERSON_COLORS: {"person.alice": "#1f77b4"},
        CONF_STAY_MIN_SNAPSHOTS: 6,
        CONF_STAY_DISTANCE_METERS: 75,
    }
    config_entry.options = {}

    flow = ZeitachseOptionsFlow(config_entry)
    flow.hass = MagicMock()

    user_input = {
        CONF_TRACKED_PERSONS: ["person.alice", "person.bob"],
        CONF_INTERVAL_MINUTES: 10,
        CONF_ENABLE_DASHBOARD: False,
        CONF_PERSON_COLORS: {"person.alice": "#ff0000"},
        CONF_STAY_MIN_SNAPSHOTS: 4,
        CONF_STAY_DISTANCE_METERS: 50,
        CONF_REPLACE_TRACKING_DATA: False,
    }

    result = await flow.async_step_init(user_input)
    assert result["type"] == "create_entry"
    assert result["data"][CONF_TRACKED_PERSONS] == ["person.alice", "person.bob"]
    assert result["data"][CONF_INTERVAL_MINUTES] == 10
    assert result["data"][CONF_ENABLE_DASHBOARD] is False


@pytest.mark.asyncio
async def test_options_flow_replace_data():
    """Test wiping tracking data when CONF_REPLACE_TRACKING_DATA is True."""
    config_entry = MagicMock()
    config_entry.data = {
        CONF_ENCRYPTION_KEY: "WMaIMi99JUsKmIBILtrlgH0DABh6ImWSaJ0QX2RxpRg=",
        CONF_TRACKED_PERSONS: ["person.alice"],
    }
    config_entry.options = {}

    flow = ZeitachseOptionsFlow(config_entry)
    flow.hass = MagicMock()

    user_input = {
        CONF_TRACKED_PERSONS: ["person.alice"],
        CONF_INTERVAL_MINUTES: 5,
        CONF_ENABLE_DASHBOARD: True,
        CONF_PERSON_COLORS: {},
        CONF_STAY_MIN_SNAPSHOTS: 6,
        CONF_STAY_DISTANCE_METERS: 75,
        CONF_REPLACE_TRACKING_DATA: True,
    }

    with patch(
        "custom_components.zeitachse.config_flow.EncryptedSnapshotStorage"
    ) as mock_storage_cls:
        mock_storage = MagicMock()
        mock_storage.async_replace = AsyncMock()
        mock_storage_cls.return_value = mock_storage

        result = await flow.async_step_init(user_input)
        assert result["type"] == "create_entry"
        mock_storage.async_replace.assert_awaited_once_with({})
