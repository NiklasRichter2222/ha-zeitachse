"""Tests for storage module."""

from __future__ import annotations

import asyncio
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from cryptography.fernet import Fernet

from custom_components.zeitachse.storage import (
    EncryptedSnapshotStorage,
    UserPreferenceStorage,
)


@pytest.fixture
def mock_hass(tmp_path: Path):
    """Fixture providing a mock HomeAssistant instance."""
    hass = MagicMock()
    hass.config.path.side_effect = lambda rel: str(tmp_path / rel)

    async def _mock_executor(func, *args):
        if asyncio.iscoroutinefunction(func):
            return await func(*args)
        return func(*args)

    hass.async_add_executor_job.side_effect = _mock_executor
    return hass


@pytest.mark.asyncio
async def test_encrypted_storage_empty(mock_hass):
    """Test loading from nonexistent file returns empty dict."""
    key = Fernet.generate_key().decode()
    storage = EncryptedSnapshotStorage(mock_hass, "snapshots.enc", key)
    data = await storage.async_load()
    assert data == {}


@pytest.mark.asyncio
async def test_encrypted_storage_append_and_load(mock_hass):
    """Test appending snapshots and loading them encrypted."""
    key = Fernet.generate_key().decode()
    storage = EncryptedSnapshotStorage(mock_hass, "snapshots.enc", key)

    snapshot_1 = {
        "timestamp": "2026-01-01T00:00:00Z",
        "latitude": 52.52,
        "longitude": 13.405,
        "state": "home",
    }
    snapshot_2 = {
        "timestamp": "2026-01-01T00:05:00Z",
        "latitude": 52.53,
        "longitude": 13.406,
        "state": "away",
    }

    await storage.async_append("person.alice", snapshot_1)
    await storage.async_append("person.alice", snapshot_2)

    timeline = await storage.async_get_person_timeline("person.alice")
    assert len(timeline) == 2
    assert timeline[0] == snapshot_1
    assert timeline[1] == snapshot_2

    # New storage instance with same key should read back the persisted data
    storage2 = EncryptedSnapshotStorage(mock_hass, "snapshots.enc", key)
    loaded = await storage2.async_load()
    assert "person.alice" in loaded
    assert len(loaded["person.alice"]) == 2
    assert loaded["person.alice"][0]["state"] == "home"


@pytest.mark.asyncio
async def test_encrypted_storage_invalid_key_resets(mock_hass):
    """Test loading corrupted or wrong-key file gracefully returns empty dict."""
    key1 = Fernet.generate_key().decode()
    key2 = Fernet.generate_key().decode()

    storage1 = EncryptedSnapshotStorage(mock_hass, "snapshots.enc", key1)
    await storage1.async_append("person.alice", {"state": "home"})

    storage2 = EncryptedSnapshotStorage(mock_hass, "snapshots.enc", key2)
    loaded = await storage2.async_load()
    assert loaded == {}


@pytest.mark.asyncio
async def test_encrypted_storage_max_snapshots_pruning(mock_hass):
    """Test pruning old snapshots when exceeding limit."""
    key = Fernet.generate_key().decode()
    storage = EncryptedSnapshotStorage(mock_hass, "snapshots.enc", key)

    with patch("custom_components.zeitachse.storage.MAX_SNAPSHOTS_PER_PERSON", 5):
        # Pre-fill cache directly to test overflow boundary
        cached = [{"id": i} for i in range(5)]
        storage._cache = {"person.bob": cached}

        await storage.async_append("person.bob", {"id": "overflow"})
        timeline = await storage.async_get_person_timeline("person.bob")
        assert len(timeline) == 5
        assert timeline[-1]["id"] == "overflow"
        assert timeline[0]["id"] == 1


@pytest.mark.asyncio
async def test_encrypted_storage_replace(mock_hass):
    """Test replacing all data."""
    key = Fernet.generate_key().decode()
    storage = EncryptedSnapshotStorage(mock_hass, "snapshots.enc", key)

    await storage.async_append("person.alice", {"state": "home"})
    await storage.async_replace({"person.bob": [{"state": "away"}]})

    alice_timeline = await storage.async_get_person_timeline("person.alice")
    bob_timeline = await storage.async_get_person_timeline("person.bob")
    assert alice_timeline == []
    assert len(bob_timeline) == 1
    assert bob_timeline[0]["state"] == "away"


@pytest.mark.asyncio
async def test_user_preference_storage(mock_hass):
    """Test loading, getting and setting user preferences."""
    pref_storage = UserPreferenceStorage(mock_hass)
    mock_store = MagicMock()
    mock_store.async_load = AsyncMock(
        return_value={"user_1": {"active_people": ["person.alice"]}}
    )
    mock_store.async_save = AsyncMock()
    pref_storage._store = mock_store

    user_1_prefs = await pref_storage.async_get("user_1")
    assert user_1_prefs == {"active_people": ["person.alice"]}

    user_2_prefs = await pref_storage.async_get("user_2")
    assert user_2_prefs == {}

    await pref_storage.async_set("user_2", {"active_people": ["person.bob"]})
    mock_store.async_save.assert_awaited_once_with(
        {
            "user_1": {"active_people": ["person.alice"]},
            "user_2": {"active_people": ["person.bob"]},
        }
    )
