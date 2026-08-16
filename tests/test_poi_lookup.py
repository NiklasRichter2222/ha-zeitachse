"""Tests for poi_lookup module."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from custom_components.zeitachse.poi_lookup import PoiLookupService


@pytest.fixture
def mock_hass():
    """Mock HomeAssistant instance."""
    hass = MagicMock()
    hass.states.async_all.return_value = []
    hass.async_create_task = lambda coro, *args, **kwargs: asyncio.create_task(coro)
    return hass


def test_haversine_distance():
    """Test haversine calculation."""
    # Distance between Berlin Brandenburg Gate and Alexanderplatz is approx 2.4 km (2400m)
    dist = PoiLookupService._haversine_meters(
        52.516275, 13.377704, 52.521918, 13.413215
    )
    assert 2300 < dist < 2600


def test_poi_name_extraction():
    """Test extracting clean POI names from Nominatim response."""
    # Priority 2: Business/institution over street name
    assert (
        PoiLookupService._extract_poi_name(
            {
                "name": "Supermarkt Edeka",
                "address": {"road": "Hauptstraße", "house_number": "10", "shop": "supermarket"},
            }
        )
        == "Supermarkt Edeka"
    )

    # Priority 2: Amenity/shop when name is empty
    assert (
        PoiLookupService._extract_poi_name(
            {
                "name": "",
                "address": {"amenity": "Cafe Einstein", "road": "Kurfürstenstraße", "house_number": "58"},
            }
        )
        == "Cafe Einstein"
    )

    # Priority 3: Street + house number when no business/institution
    assert (
        PoiLookupService._extract_poi_name(
            {
                "name": None,
                "address": {"road": "Musterweg", "house_number": "42"},
            }
        )
        == "Musterweg 42"
    )

    # Priority 3: Street only when no house number
    assert (
        PoiLookupService._extract_poi_name(
            {
                "name": "",
                "address": {"road": "Waldstraße"},
            }
        )
        == "Waldstraße"
    )

    # Priority 3: Neighborhood / city fallback
    assert (
        PoiLookupService._extract_poi_name(
            {
                "name": None,
                "address": {"suburb": "Prenzlauer Berg"},
            }
        )
        == "Prenzlauer Berg"
    )

    # Filter out snapshot garbage
    assert PoiLookupService._is_useful_name("snapshot_location") is False
    assert PoiLookupService._is_useful_name("scapshot_123") is False
    assert PoiLookupService._is_useful_name("Museum Island") is True


def test_build_osm_url():
    """Test building OpenStreetMap links."""
    assert (
        PoiLookupService._build_osm_url({"osm_id": 12345, "osm_type": "N"})
        == "https://www.openstreetmap.org/node/12345"
    )
    assert (
        PoiLookupService._build_osm_url({"osm_id": 67890, "osm_type": "way"})
        == "https://www.openstreetmap.org/way/67890"
    )
    assert (
        PoiLookupService._build_osm_url({"osm_id": 99999, "osm_type": "R"})
        == "https://www.openstreetmap.org/relation/99999"
    )
    assert (
        PoiLookupService._build_osm_url({"osm_id": 11111, "osm_type": "relation"})
        == "https://www.openstreetmap.org/relation/11111"
    )
    assert PoiLookupService._build_osm_url({}) is None


@pytest.mark.asyncio
async def test_ha_zone_lookup(mock_hass):
    """Test resolving matching Home Assistant zones."""
    zone_state = MagicMock()
    zone_state.entity_id = "zone.home"
    zone_state.attributes = {
        "latitude": 52.5200,
        "longitude": 13.4050,
        "radius": 100,
        "friendly_name": "Zuhause",
    }
    mock_hass.states.async_all.return_value = [zone_state]

    with patch(
        "custom_components.zeitachse.poi_lookup.async_get_clientsession"
    ) as mock_get_session:
        mock_session = MagicMock()
        mock_get_session.return_value = mock_session

        service = PoiLookupService(mock_hass)

        # Inside zone (distance ~ 0m)
        poi = await service.async_lookup(52.5200, 13.4050)
        assert poi is not None
        assert poi["name"] == "Zuhause"
        assert poi["category"] == "zone"

        # Outside zone (> 1000m away) - fallback to session mock
        mock_response = MagicMock()
        mock_response.status = 200
        mock_response.json = AsyncMock(
            return_value={
                "name": "Alexanderplatz",
                "display_name": "Alexanderplatz, Mitte, Berlin",
                "category": "place",
                "type": "square",
                "osm_id": 123,
                "osm_type": "node",
            }
        )
        mock_session.get = AsyncMock(return_value=mock_response)

        outside_poi = await service.async_lookup(52.5300, 13.4200)
        assert outside_poi is not None
        assert outside_poi["name"] == "Alexanderplatz"
        assert outside_poi["url"] == "https://www.openstreetmap.org/node/123"


@pytest.mark.asyncio
async def test_poi_caching(mock_hass):
    """Test LRU caching avoids duplicate remote lookups."""
    with patch(
        "custom_components.zeitachse.poi_lookup.async_get_clientsession"
    ) as mock_get_session:
        mock_session = MagicMock()
        mock_get_session.return_value = mock_session
        service = PoiLookupService(mock_hass)

        mock_response = MagicMock()
        mock_response.status = 200
        mock_response.json = AsyncMock(return_value={"name": "Cafe Berlin"})
        mock_session.get = AsyncMock(return_value=mock_response)

        poi1 = await service.async_lookup(52.500001, 13.300001)
        poi2 = await service.async_lookup(
            52.500004, 13.300004
        )  # rounds to same 5-decimal key

        assert poi1 == poi2
        assert mock_session.get.call_count == 1


@pytest.mark.asyncio
async def test_preload_all_pois(mock_hass):
    """Test preloading POIs from snapshot storage."""
    with patch(
        "custom_components.zeitachse.poi_lookup.async_get_clientsession"
    ) as mock_get_session:
        mock_session = MagicMock()
        mock_get_session.return_value = mock_session
        service = PoiLookupService(mock_hass)

        mock_storage = MagicMock()
        # 6 consecutive snapshots at same location -> 1 stay
        mock_storage.async_load = AsyncMock(
            return_value={
                "person.alice": [
                    {"latitude": 52.5200, "longitude": 13.4050}
                    for _ in range(6)
                ]
            }
        )

        mock_response = MagicMock()
        mock_response.status = 200
        mock_response.json = AsyncMock(return_value={"name": "Berlin Central"})
        mock_session.get = AsyncMock(return_value=mock_response)

        res = await service.async_preload_all_pois(mock_storage, 6, 75)
        assert res["total_locations"] == 1
        assert res["newly_fetched"] == 1
        assert res["already_cached"] == 0

        # Second run: should be already cached
        res2 = await service.async_preload_all_pois(mock_storage, 6, 75)
        assert res2["total_locations"] == 1
        assert res2["newly_fetched"] == 0
        assert res2["already_cached"] == 1
