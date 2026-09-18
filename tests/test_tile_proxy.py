"""Tests for tile_proxy module."""

from __future__ import annotations

from collections.abc import AsyncGenerator
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from aiohttp import web

from custom_components.zeitachse.tile_proxy import (
    TRANSPARENT_1X1_PNG,
    ZeitachseTileProxyView,
)


@pytest.fixture
def mock_hass(tmp_path):
    hass = MagicMock()
    hass.config.path = lambda *args: str(tmp_path.joinpath(*args))

    async def _async_add_executor_job(func, *args):
        return func(*args)

    hass.async_add_executor_job = _async_add_executor_job
    return hass


@pytest.mark.asyncio
async def test_tile_proxy_invalid_coordinates(mock_hass):
    """Test rejection of invalid tile coordinates."""
    view = ZeitachseTileProxyView(mock_hass)
    request = MagicMock()

    # Non-integer coordinates
    res = await view.get(request, z="abc", x="1", y="2")
    assert res.status == 400

    # Negative zoom
    res = await view.get(request, z="-1", x="0", y="0")
    assert res.status == 400

    # Coordinate out of bounds (zoom 1 only allows 0..1)
    res = await view.get(request, z="1", x="5", y="0")
    assert res.status == 400


@pytest.mark.asyncio
async def test_tile_proxy_memory_cache(mock_hass):
    """Test serving tile directly from memory cache."""
    view = ZeitachseTileProxyView(mock_hass)
    request = MagicMock()

    dummy_png = b"\x89PNG\r\n\x1a\n\x00test"
    view._memory_cache["10_500_500"] = dummy_png

    res = await view.get(request, z="10", x="500", y="500.png")
    assert res.status == 200
    assert res.body == dummy_png
    assert res.headers.get("X-Zeitachse-Cache") == "MEMORY"


@pytest.mark.asyncio
async def test_tile_proxy_disk_cache(mock_hass, tmp_path):
    """Test serving tile from disk cache when not in memory."""
    view = ZeitachseTileProxyView(mock_hass)
    request = MagicMock()

    dummy_png = b"\x89PNG\r\n\x1a\n\x00from_disk"
    tile_file = tmp_path / ".storage" / "zeitachse_tiles" / "10_500_500.png"
    tile_file.parent.mkdir(parents=True, exist_ok=True)
    tile_file.write_bytes(dummy_png)

    res = await view.get(request, z="10", x="500", y="500")
    assert res.status == 200
    assert res.body == dummy_png
    assert res.headers.get("X-Zeitachse-Cache") == "DISK"
    # Now it should also be in memory cache
    assert "10_500_500" in view._memory_cache


@pytest.mark.asyncio
async def test_tile_proxy_fetch_upstream(mock_hass):
    """Test fetching tile from upstream server and caching it."""
    view = ZeitachseTileProxyView(mock_hass)
    request = MagicMock()

    dummy_png = b"\x89PNG\r\n\x1a\n\x00fetched"

    mock_resp = AsyncMock()
    mock_resp.status = 200
    mock_resp.read.return_value = dummy_png

    class MockContextManager:
        async def __aenter__(self):
            return mock_resp

        async def __aexit__(self, exc_type, exc, tb):
            pass

    mock_session = MagicMock()
    mock_session.get.return_value = MockContextManager()

    with patch(
        "custom_components.zeitachse.tile_proxy.async_get_clientsession",
        return_value=mock_session,
    ):
        res = await view.get(request, z="5", x="10", y="10.png")
        assert res.status == 200
        assert res.body == dummy_png
        assert res.headers.get("X-Zeitachse-Cache") == "FETCH"
        assert "5_10_10" in view._memory_cache


@pytest.mark.asyncio
async def test_tile_proxy_fallback_on_failure(mock_hass):
    """Test returning transparent 1x1 fallback PNG when upstream fails."""
    view = ZeitachseTileProxyView(mock_hass)
    request = MagicMock()

    mock_resp = AsyncMock()
    mock_resp.status = 404
    mock_resp.read.return_value = b""

    class MockContextManager:
        async def __aenter__(self):
            return mock_resp

        async def __aexit__(self, exc_type, exc, tb):
            pass

    mock_session = MagicMock()
    mock_session.get.return_value = MockContextManager()

    with patch(
        "custom_components.zeitachse.tile_proxy.async_get_clientsession",
        return_value=mock_session,
    ):
        res = await view.get(request, z="5", x="11", y="11.png")
        assert res.status == 200
        assert res.body == TRANSPARENT_1X1_PNG
        assert res.headers.get("X-Zeitachse-Cache") == "FALLBACK"


def test_frontend_assets_integrity():
    """Verify frontend JS files exist, are well-formed, and contain new map features."""
    import pathlib

    frontend_dir = (
        pathlib.Path(__file__).parent.parent
        / "custom_components"
        / "zeitachse"
        / "frontend"
    )

    for filename in ["map-utils.js", "zeitachse-panel.js", "zeitachse-card.js"]:
        path = frontend_dir / filename
        assert path.exists(), f"Missing frontend asset: {filename}"
        text = path.read_text(encoding="utf-8")
        assert len(text) > 1000
        assert text.count("{") == text.count("}"), f"Mismatched braces in {filename}"
        assert text.count("(") == text.count(")"), f"Mismatched parentheses in {filename}"

    map_utils = (frontend_dir / "map-utils.js").read_text(encoding="utf-8")
    assert "BASEMAP_PROVIDERS" in map_utils
    assert "renderTimelineTrack" in map_utils
    assert "setupTileLayer" in map_utils
    assert "calculateBearing" in map_utils
    assert "compassHeading" in map_utils
    assert "createDirectionArrowIcon" in map_utils
    assert "/api/zeitachse/tiles/" in map_utils

