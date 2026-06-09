"""Encrypted storage and user preferences for Zeitachse."""

from __future__ import annotations

from collections.abc import Mapping
import json
from pathlib import Path
from typing import Any

from cryptography.fernet import Fernet, InvalidToken

from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store

from .const import (
    MAX_SNAPSHOTS_PER_PERSON,
    PREFERENCES_STORAGE_KEY,
    PREFERENCES_STORAGE_VERSION,
)


class EncryptedSnapshotStorage:
    """Store snapshots encrypted on disk."""

    def __init__(self, hass: HomeAssistant, file_path: str, encryption_key: str) -> None:
        """Initialize encrypted storage."""
        self._hass = hass
        self._file_path = hass.config.path(file_path)
        self._fernet = Fernet(encryption_key.encode())
        self._cache: dict[str, list[dict[str, Any]]] | None = None

    async def async_load(self) -> dict[str, list[dict[str, Any]]]:
        """Load encrypted snapshots."""
        if self._cache is not None:
            return self._cache

        path = Path(self._file_path)
        if not path.exists():
            self._cache = {}
            return self._cache

        raw_bytes = await self._hass.async_add_executor_job(path.read_bytes)
        try:
            decrypted = self._fernet.decrypt(raw_bytes)
            decoded = json.loads(decrypted.decode())
        except (InvalidToken, json.JSONDecodeError, UnicodeDecodeError):
            decoded = {}

        self._cache = {
            key: value if isinstance(value, list) else []
            for key, value in decoded.items()
            if isinstance(key, str)
        }
        return self._cache

    async def async_append(self, person_entity_id: str, snapshot: dict[str, Any]) -> None:
        """Append a snapshot and persist encrypted payload."""
        data = await self.async_load()
        snapshots = data.setdefault(person_entity_id, [])
        snapshots.append(snapshot)
        if len(snapshots) > MAX_SNAPSHOTS_PER_PERSON:
            del snapshots[:-MAX_SNAPSHOTS_PER_PERSON]
        await self.async_replace(data)

    async def async_get_person_timeline(self, person_entity_id: str) -> list[dict[str, Any]]:
        """Return snapshots for one person."""
        data = await self.async_load()
        return list(data.get(person_entity_id, []))

    async def async_replace(self, data: dict[str, list[dict[str, Any]]]) -> None:
        """Replace complete snapshot payload and persist it."""
        normalized = {
            key: value if isinstance(value, list) else []
            for key, value in data.items()
            if isinstance(key, str)
        }
        self._cache = normalized
        payload = json.dumps(normalized, separators=(",", ":")).encode()
        encrypted = self._fernet.encrypt(payload)

        path = Path(self._file_path)
        await self._hass.async_add_executor_job(lambda: path.parent.mkdir(parents=True, exist_ok=True))
        await self._hass.async_add_executor_job(path.write_bytes, encrypted)


class UserPreferenceStorage:
    """Store UI preferences by user id."""

    def __init__(self, hass: HomeAssistant) -> None:
        """Initialize preference storage."""
        self._store = Store[dict[str, dict[str, Any]]](
            hass, PREFERENCES_STORAGE_VERSION, PREFERENCES_STORAGE_KEY
        )
        self._cache: dict[str, dict[str, Any]] | None = None

    async def async_load(self) -> dict[str, dict[str, Any]]:
        """Load preferences."""
        if self._cache is None:
            self._cache = await self._store.async_load() or {}
        return self._cache

    async def async_get(self, user_id: str) -> dict[str, Any]:
        """Get one user's preferences."""
        prefs = await self.async_load()
        return dict(prefs.get(user_id, {}))

    async def async_set(self, user_id: str, values: Mapping[str, Any]) -> None:
        """Persist one user's preferences."""
        prefs = await self.async_load()
        current = dict(prefs.get(user_id, {}))
        current.update(dict(values))
        prefs[user_id] = current
        await self._store.async_save(prefs)
