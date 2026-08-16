"""POI lookup helpers for Zeitachse."""

from __future__ import annotations

import asyncio
import logging
import math
import time
from collections import OrderedDict
from typing import Any

from aiohttp import ClientError
from homeassistant.const import ATTR_FRIENDLY_NAME
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

_LOGGER = logging.getLogger(__name__)
_NOMINATIM_URL = "https://nominatim.openstreetmap.org/reverse"
_NOMINATIM_ZOOM_LEVEL = 18
_REQUEST_TIMEOUT_SECONDS = 5
_MIN_REQUEST_SPACING_SECONDS = 1
_MAX_CACHE_SIZE = 1000
_USER_AGENT = "ha-zeitachse/0.1.0 (+https://github.com/NiklasRichter2222/ha-zeitachse)"


class PoiLookupService:
    """Resolve POIs for coordinates using free reverse geocoding."""

    def __init__(self, hass: HomeAssistant) -> None:
        """Initialize POI lookup service."""
        self._hass = hass
        self._session = async_get_clientsession(hass)
        self._cache: OrderedDict[tuple[float, float], dict[str, Any] | None] = (
            OrderedDict()
        )
        self._request_lock = asyncio.Lock()
        self._last_request_monotonic = 0.0
        self._headers = {
            "Accept": "application/json",
            "User-Agent": _USER_AGENT,
        }

    def _cache_key(self, latitude: float, longitude: float) -> tuple[float, float]:
        """Return rounded cache key for nearby coordinates."""
        return (round(latitude, 5), round(longitude, 5))

    def _cache_set(
        self, key: tuple[float, float], value: dict[str, Any] | None
    ) -> None:
        """Store value in bounded LRU cache."""
        self._cache[key] = value
        self._cache.move_to_end(key)
        if len(self._cache) > _MAX_CACHE_SIZE:
            self._cache.popitem(last=False)

    async def _async_wait_for_rate_limit(self) -> None:
        """Ensure Nominatim rate limit is respected."""
        async with self._request_lock:
            now = time.monotonic()
            wait = _MIN_REQUEST_SPACING_SECONDS - (now - self._last_request_monotonic)
            if wait > 0:
                await asyncio.sleep(wait)
            self._last_request_monotonic = time.monotonic()

    @staticmethod
    def _is_useful_name(value: str) -> bool:
        """Return True when a POI name is useful for end users."""
        lowered = value.lower()
        return "snapshot" not in lowered and "scapshot" not in lowered

    @classmethod
    def _extract_poi_name(cls, data: dict[str, Any]) -> str | None:
        """Extract a POI name with strict 3-tier priority:
        1. Configured HA Zone (handled in _lookup_homeassistant_zone)
        2. Business, shop, institution, amenity, leisure, tourism, office
        3. Street name (+ house number) or neighborhood/city
        """
        address = data.get("address") if isinstance(data.get("address"), dict) else {}

        # 2nd Priority: Specific business, institution, amenity or attraction name
        if isinstance(data.get("name"), str) and data["name"].strip():
            candidate = data["name"].strip()
            if cls._is_useful_name(candidate):
                return candidate

        poi_keys = (
            "amenity",
            "shop",
            "tourism",
            "leisure",
            "office",
            "healthcare",
            "historic",
            "craft",
            "building",
            "commercial",
            "industrial",
            "railway",
            "aeroway",
            "public_transport",
        )
        for key in poi_keys:
            value = address.get(key)
            if isinstance(value, str) and value.strip():
                candidate = value.strip()
                if cls._is_useful_name(candidate):
                    return candidate

        # 3rd Priority: Street name (+ house number if available) or area
        street_keys = (
            "road",
            "pedestrian",
            "footway",
            "cycleway",
            "path",
            "street",
            "square",
            "plaza",
            "residential",
        )
        for key in street_keys:
            street_val = address.get(key)
            if isinstance(street_val, str) and street_val.strip():
                street = street_val.strip()
                house_num = address.get("house_number")
                if isinstance(house_num, str) and house_num.strip():
                    return f"{street} {house_num.strip()}"
                return street

        area_keys = (
            "suburb",
            "neighbourhood",
            "quarter",
            "city_district",
            "hamlet",
            "village",
            "town",
            "city",
            "municipality",
        )
        for key in area_keys:
            area_val = address.get(key)
            if isinstance(area_val, str) and area_val.strip():
                candidate = area_val.strip()
                if cls._is_useful_name(candidate):
                    return candidate

        display_name = data.get("display_name")
        if isinstance(display_name, str) and display_name.strip():
            candidate = display_name.split(",")[0].strip()
            if cls._is_useful_name(candidate):
                return candidate

        return None

    @staticmethod
    def _build_osm_url(data: dict[str, Any]) -> str | None:
        """Build clickable OSM URL for POI."""
        osm_id = data.get("osm_id")
        osm_type = data.get("osm_type")
        if not osm_id or not isinstance(osm_type, str):
            return None
        type_map = {
            "N": "node",
            "W": "way",
            "R": "relation",
            "NODE": "node",
            "WAY": "way",
            "RELATION": "relation",
        }
        mapped = type_map.get(osm_type.upper())
        if not mapped:
            return None
        return f"https://www.openstreetmap.org/{mapped}/{osm_id}"

    @staticmethod
    def _haversine_meters(
        latitude: float,
        longitude: float,
        other_latitude: float,
        other_longitude: float,
    ) -> float:
        """Return distance in meters between two coordinates."""
        lat1 = math.radians(latitude)
        lon1 = math.radians(longitude)
        lat2 = math.radians(other_latitude)
        lon2 = math.radians(other_longitude)
        delta_lat = lat2 - lat1
        delta_lon = lon2 - lon1
        a = (
            math.sin(delta_lat / 2) ** 2
            + math.cos(lat1) * math.cos(lat2) * math.sin(delta_lon / 2) ** 2
        )
        c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
        return 6_371_000 * c

    def _lookup_homeassistant_zone(
        self, latitude: float, longitude: float
    ) -> dict[str, Any] | None:
        """Resolve a matching Home Assistant zone for coordinates."""
        best_match: tuple[float, dict[str, Any]] | None = None

        # 1. Iterate all zone states
        for state in self._hass.states.async_all("zone"):
            zone_lat = state.attributes.get("latitude")
            zone_lon = state.attributes.get("longitude")
            zone_radius = state.attributes.get("radius")

            if not isinstance(zone_lat, (int, float)) or not isinstance(
                zone_lon, (int, float)
            ):
                continue

            if not isinstance(zone_radius, (int, float)) or zone_radius <= 0:
                zone_radius = getattr(self._hass.config, "radius", 100) or 100

            distance = self._haversine_meters(
                latitude, longitude, float(zone_lat), float(zone_lon)
            )
            if distance > float(zone_radius):
                continue

            zone_name_raw = (
                state.attributes.get(ATTR_FRIENDLY_NAME)
                or state.name
                or (
                    "Zuhause"
                    if state.entity_id == "zone.home"
                    else state.entity_id.removeprefix("zone.")
                )
            )
            zone_name = str(zone_name_raw).strip() or "Zuhause"
            zone = {
                "name": zone_name,
                "display_name": zone_name,
                "category": "zone",
                "type": "home_assistant_zone",
                "url": None,
            }
            if best_match is None or distance < best_match[0]:
                best_match = (distance, zone)

        # 2. Check hass.config Home coordinates as direct fallback
        if best_match is None and (
            isinstance(getattr(self._hass.config, "latitude", None), (int, float))
            and isinstance(getattr(self._hass.config, "longitude", None), (int, float))
        ):
            home_lat = float(self._hass.config.latitude)
            home_lon = float(self._hass.config.longitude)
            home_radius = float(getattr(self._hass.config, "radius", 100) or 100)
            home_dist = self._haversine_meters(latitude, longitude, home_lat, home_lon)
            if home_dist <= home_radius:
                home_name = (
                    getattr(self._hass.config, "location_name", None)
                    or "Zuhause"
                )
                return {
                    "name": home_name,
                    "display_name": home_name,
                    "category": "zone",
                    "type": "home_assistant_zone",
                    "url": None,
                }

        return best_match[1] if best_match else None

    async def async_lookup(
        self, latitude: float, longitude: float
    ) -> dict[str, Any] | None:
        """Look up POI metadata for a coordinate."""
        key = self._cache_key(latitude, longitude)
        if key in self._cache:
            self._cache.move_to_end(key)
            return self._cache[key]

        zone_match = self._lookup_homeassistant_zone(latitude, longitude)
        if zone_match:
            self._cache_set(key, zone_match)
            return zone_match

        try:
            await self._async_wait_for_rate_limit()
            async with asyncio.timeout(_REQUEST_TIMEOUT_SECONDS):
                response = await self._session.get(
                    _NOMINATIM_URL,
                    params={
                        "format": "jsonv2",
                        "lat": latitude,
                        "lon": longitude,
                        "zoom": _NOMINATIM_ZOOM_LEVEL,
                        "addressdetails": 1,
                    },
                    headers=self._headers,
                )
                if response.status != 200:
                    _LOGGER.debug("POI lookup failed with status=%s", response.status)
                    self._cache_set(key, None)
                    return None
                data = await response.json(content_type=None)
        except (TimeoutError, ClientError, ValueError) as error:
            _LOGGER.debug("POI lookup error: %s", error)
            self._cache_set(key, None)
            return None

        if not isinstance(data, dict):
            self._cache_set(key, None)
            return None

        name = self._extract_poi_name(data)
        if not name:
            self._cache_set(key, None)
            return None

        poi = {
            "name": name,
            "display_name": data.get("display_name"),
            "category": data.get("category"),
            "type": data.get("type"),
            "url": self._build_osm_url(data),
        }
        self._cache_set(key, poi)
        return poi
