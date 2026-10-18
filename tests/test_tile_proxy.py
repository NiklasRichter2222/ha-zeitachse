"""Tests for tile_proxy module."""

from __future__ import annotations

import os
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from custom_components.zeitachse.const import RUNTIME_DATA_KEY
from custom_components.zeitachse.tile_proxy import (
    DISK_CACHE_TTL_SECONDS,
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
async def test_tile_proxy_memory_cache_and_etag(mock_hass):
    """Test serving tile directly from memory cache and 304 Not Modified on matching ETag."""
    view = ZeitachseTileProxyView(mock_hass)
    request = MagicMock()
    request.headers = {}

    dummy_png = b"\x89PNG\r\n\x1a\n\x00test"
    view._memory_cache["10_500_500"] = dummy_png

    res = await view.get(request, z="10", x="500", y="500.png")
    assert res.status == 200
    assert res.body == dummy_png
    assert res.headers.get("X-Zeitachse-Cache") == "MEMORY"
    etag = res.headers.get("ETag")
    assert etag is not None

    # Conditional request with matching ETag returns 304
    request.headers = {"If-None-Match": etag}
    res_304 = await view.get(request, z="10", x="500", y="500.png")
    assert res_304.status == 304


@pytest.mark.asyncio
async def test_tile_proxy_disk_cache(mock_hass, tmp_path):
    """Test serving tile from disk cache when not in memory."""
    view = ZeitachseTileProxyView(mock_hass)
    request = MagicMock()
    request.headers = {}

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
async def test_tile_proxy_stale_disk_fallback_on_upstream_error(mock_hass, tmp_path):
    """Test stale disk tile is still served when upstream refresh fails."""
    view = ZeitachseTileProxyView(mock_hass)
    request = MagicMock()
    request.headers = {}

    dummy_png = b"\x89PNG\r\n\x1a\n\x00stale_disk"
    tile_file = tmp_path / ".storage" / "zeitachse_tiles" / "8_100_100.png"
    tile_file.parent.mkdir(parents=True, exist_ok=True)
    tile_file.write_bytes(dummy_png)
    old_mtime = time.time() - (DISK_CACHE_TTL_SECONDS + 3600)
    os.utime(tile_file, (old_mtime, old_mtime))

    mock_resp = AsyncMock()
    mock_resp.status = 503
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
        res = await view.get(request, z="8", x="100", y="100.png")
        assert res.status == 200
        assert res.body == dummy_png
        assert res.headers.get("X-Zeitachse-Cache") == "DISK"


@pytest.mark.asyncio
async def test_tile_proxy_authentication(mock_hass):
    """Test tile proxy enforces authentication when runtime tile_token is present."""
    mock_hass.data = {
        RUNTIME_DATA_KEY: SimpleNamespace(tile_token="secret-tile-token-123")
    }
    view = ZeitachseTileProxyView(mock_hass)
    dummy_png = b"\x89PNG\r\n\x1a\n\x00auth_test"
    view._memory_cache["5_1_1"] = dummy_png

    # Unauthenticated request without hass_user or token -> 401
    unauth_req = SimpleNamespace(
        get=lambda _k, _d=None: None,
        query={},
        headers={},
    )
    res_unauth = await view.get(unauth_req, z="5", x="1", y="1.png")
    assert res_unauth.status == 401

    # Request with valid token query param -> 200
    token_req = SimpleNamespace(
        get=lambda _k, _d=None: None,
        query={"token": "secret-tile-token-123"},
        headers={},
    )
    res_token = await view.get(token_req, z="5", x="1", y="1.png")
    assert res_token.status == 200
    assert res_token.body == dummy_png

    # Request with authenticated hass_user -> 200
    user_req = SimpleNamespace(
        get=lambda k, _d=None: SimpleNamespace(id="u1") if k == "hass_user" else None,
        query={},
        headers={},
    )
    res_user = await view.get(user_req, z="5", x="1", y="1.png")
    assert res_user.status == 200


@pytest.mark.asyncio
async def test_tile_proxy_fetch_upstream(mock_hass):
    """Test fetching tile from upstream server and caching it."""
    view = ZeitachseTileProxyView(mock_hass)
    request = MagicMock()
    request.headers = {}

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
    request.headers = {}

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
    assert "updateOverlapCulledTooltips" in map_utils
    assert "getSharedCanvasRenderer" in map_utils
    assert "sanitizeColor" in map_utils
    assert "/api/zeitachse/tiles/" in map_utils

    panel_js = (frontend_dir / "zeitachse-panel.js").read_text(encoding="utf-8")
    assert "_focusStayOnMap" in panel_js
    assert "theme-dark" in panel_js
    assert "theme-light" in panel_js
    assert "updateOverlapCulledTooltips" in panel_js


