"""POI lookup helpers for Zeitachse."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from aiohttp import ClientError

from homeassistant.const import __version__ as ha_version
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

_LOGGER = logging.getLogger(__name__)
_NOMINATIM_URL = "https://nominatim.openstreetmap.org/reverse"


class PoiLookupService:
    """Resolve POIs for coordinates using free reverse geocoding."""

    def __init__(self, hass: HomeAssistant) -> None:
        """Initialize POI lookup service."""
        self._session = async_get_clientsession(hass)
        self._cache: dict[tuple[float, float], dict[str, Any] | None] = {}
        self._headers = {
            "Accept": "application/json",
            "User-Agent": f"ha-zeitachse/{ha_version}",
        }

    def _cache_key(self, latitude: float, longitude: float) -> tuple[float, float]:
        """Return rounded cache key for nearby coordinates."""
        return (round(latitude, 5), round(longitude, 5))

    @staticmethod
    def _extract_poi_name(data: dict[str, Any]) -> str | None:
        """Extract a useful POI name from Nominatim response."""
        if isinstance(data.get("name"), str) and data["name"].strip():
            return data["name"].strip()
        address = data.get("address") or {}
        for key in ("amenity", "shop", "tourism", "leisure", "railway", "building", "office"):
            value = address.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        display_name = data.get("display_name")
        if isinstance(display_name, str) and display_name.strip():
            return display_name.split(",")[0].strip()
        return None

    @staticmethod
    def _build_osm_url(data: dict[str, Any]) -> str | None:
        """Build clickable OSM URL for POI."""
        osm_id = data.get("osm_id")
        osm_type = data.get("osm_type")
        if not osm_id or not isinstance(osm_type, str):
            return None
        type_map = {"N": "node", "W": "way", "R": "relation"}
        mapped = type_map.get(osm_type.upper())
        if not mapped:
            return None
        return f"https://www.openstreetmap.org/{mapped}/{osm_id}"

    async def async_lookup(self, latitude: float, longitude: float) -> dict[str, Any] | None:
        """Look up POI metadata for a coordinate."""
        key = self._cache_key(latitude, longitude)
        if key in self._cache:
            return self._cache[key]

        try:
            async with asyncio.timeout(8):
                response = await self._session.get(
                    _NOMINATIM_URL,
                    params={
                        "format": "jsonv2",
                        "lat": latitude,
                        "lon": longitude,
                        "zoom": 18,
                        "addressdetails": 1,
                    },
                    headers=self._headers,
                )
                if response.status != 200:
                    _LOGGER.debug(
                        "POI lookup failed for (%s, %s): status=%s",
                        latitude,
                        longitude,
                        response.status,
                    )
                    self._cache[key] = None
                    return None
                data = await response.json(content_type=None)
        except (TimeoutError, ClientError, ValueError) as error:
            _LOGGER.debug("POI lookup error for (%s, %s): %s", latitude, longitude, error)
            self._cache[key] = None
            return None

        if not isinstance(data, dict):
            self._cache[key] = None
            return None

        name = self._extract_poi_name(data)
        if not name:
            self._cache[key] = None
            return None

        poi = {
            "name": name,
            "display_name": data.get("display_name"),
            "category": data.get("category"),
            "type": data.get("type"),
            "url": self._build_osm_url(data),
        }
        self._cache[key] = poi
        return poi
