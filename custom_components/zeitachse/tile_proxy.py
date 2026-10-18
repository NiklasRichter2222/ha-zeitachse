"""Tile proxy view and caching for Zeitachse."""

from __future__ import annotations

import asyncio
import hmac
import logging
import os
import time
from collections import OrderedDict
from typing import ClassVar

from aiohttp import ClientError, ClientTimeout, web
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.http import HomeAssistantView

from .const import RUNTIME_DATA_KEY

_LOGGER = logging.getLogger(__name__)

USER_AGENT = "HomeAssistant-Zeitachse/1.0 (+https://github.com/NiklasRichter2222/ha-zeitachse)"
UPSTREAM_TIMEOUT_SECONDS = 10
MAX_MEMORY_CACHE_ITEMS = 500
DISK_CACHE_TTL_SECONDS = 14 * 86400  # 14 days

# 1x1 transparent PNG fallback in case of upstream network failure
TRANSPARENT_1X1_PNG = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
    b"\x08\x06\x00\x00\x00\x1f\x15c4\x00\x00\x00\rIDATx\x9cc`\x00\x00\x00"
    b"\x02\x00\x01H\xaf\xa4q\x00\x00\x00\x00IEND\xaeB`\x82"
)


class ZeitachseTileProxyView(HomeAssistantView):
    """Serve cached OpenStreetMap tiles to compliant frontend clients."""

    url = "/api/zeitachse/tiles/{z}/{x}/{y}.png"
    extra_urls: ClassVar[list[str]] = ["/api/zeitachse/tiles/{z}/{x}/{y}"]
    name = "api:zeitachse:tiles"
    requires_auth = False
    cors_allowed = False

    def __init__(self, hass: HomeAssistant) -> None:
        """Initialize tile proxy."""
        self._hass = hass
        try:
            self._cache_dir = hass.config.path(".storage", "zeitachse_tiles")
        except TypeError:
            self._cache_dir = os.path.join(
                hass.config.path(".storage"), "zeitachse_tiles"
            )
        self._memory_cache: OrderedDict[str, bytes] = OrderedDict()
        self._cache_lock = asyncio.Lock()
        self._inflight: dict[str, asyncio.Task[bytes | None]] = {}
        self._semaphore = asyncio.Semaphore(6)

    def _is_authorized(self, request: web.Request) -> bool:
        """Verify request is from an authenticated HA user or has valid tile token."""
        hass_data = getattr(self._hass, "data", None)
        if not isinstance(hass_data, dict) or RUNTIME_DATA_KEY not in hass_data:
            return True

        runtime = hass_data.get(RUNTIME_DATA_KEY)
        expected_token = getattr(runtime, "tile_token", None)
        if not expected_token:
            return True

        get_item = getattr(request, "get", None)
        if callable(get_item) and get_item("hass_user") is not None:
            return True

        query = getattr(request, "query", None)
        if (
            query
            and isinstance(query.get("token"), str)
            and hmac.compare_digest(query["token"], expected_token)
        ):
            return True

        headers = getattr(request, "headers", None)
        if headers:
            auth_header = headers.get("Authorization", "")
            if isinstance(auth_header, str) and auth_header.startswith("Bearer "):
                bearer = auth_header.removeprefix("Bearer ").strip()
                if bearer and hmac.compare_digest(bearer, expected_token):
                    return True

        return False

    def _get_tile_path(self, z: int, x: int, y: int) -> str:
        return os.path.join(self._cache_dir, f"{z}_{x}_{y}.png")

    def _read_tile_from_disk(self, file_path: str) -> tuple[bytes | None, bool]:
        """Read tile bytes from disk and return (data, is_fresh)."""
        try:
            if os.path.exists(file_path):
                stat = os.stat(file_path)
                is_fresh = (time.time() - stat.st_mtime) < DISK_CACHE_TTL_SECONDS
                with open(file_path, "rb") as file_handle:
                    data = file_handle.read()
                if data.startswith(b"\x89PNG"):
                    return data, is_fresh
        except OSError as err:
            _LOGGER.debug("Failed to read tile from disk %s: %s", file_path, err)
        return None, False

    def _write_tile_to_disk(self, file_path: str, data: bytes) -> None:
        try:
            os.makedirs(os.path.dirname(file_path), exist_ok=True)
            temp_path = f"{file_path}.{os.getpid()}.{id(data)}.tmp"
            with open(temp_path, "wb") as file_handle:
                file_handle.write(data)
            try:
                os.chmod(temp_path, 0o600)
            except OSError:
                pass
            os.replace(temp_path, file_path)
        except OSError as err:
            _LOGGER.debug("Failed to write tile to disk %s: %s", file_path, err)

    async def _fetch_upstream_tile(
        self, cache_key: str, zoom: int, x_coord: int, y_coord: int
    ) -> bytes | None:
        """Fetch a single tile from upstream OSM servers with concurrency control."""
        session = async_get_clientsession(self._hass)
        headers = {
            "User-Agent": USER_AGENT,
            "Referer": "https://www.openstreetmap.org/",
            "Accept": "image/png,image/apng,image/*,*/*;q=0.8",
        }
        urls = [
            f"https://tile.openstreetmap.org/{zoom}/{x_coord}/{y_coord}.png",
            f"https://tile.openstreetmap.de/{zoom}/{x_coord}/{y_coord}.png",
        ]

        async with self._semaphore:
            for url in urls:
                try:
                    async with session.get(
                        url,
                        headers=headers,
                        timeout=ClientTimeout(total=UPSTREAM_TIMEOUT_SECONDS),
                    ) as response:
                        if response.status == 200:
                            content = await response.read()
                            if content.startswith(b"\x89PNG"):
                                return content
                            _LOGGER.debug(
                                "Upstream %s returned non-PNG content for tile %s",
                                url,
                                cache_key,
                            )
                        else:
                            _LOGGER.debug(
                                "Upstream %s returned status %d for tile %s",
                                url,
                                response.status,
                                cache_key,
                            )
                except (TimeoutError, ClientError) as err:
                    _LOGGER.debug(
                        "Network error fetching tile %s from %s: %s",
                        cache_key,
                        url,
                        err,
                    )
        return None

    @staticmethod
    def _build_tile_response(
        request: web.Request,
        cache_key: str,
        body: bytes,
        cache_source: str,
        max_age: int = 604800,
        immutable: bool = True,
    ) -> web.Response:
        """Build HTTP response with ETag and private Cache-Control headers."""
        etag = f'W/"{cache_key}-{len(body)}"'
        cache_control = f"private, max-age={max_age}" + (
            ", immutable" if immutable else ""
        )
        headers = {
            "Cache-Control": cache_control,
            "ETag": etag,
            "X-Zeitachse-Cache": cache_source,
        }
        req_headers = getattr(request, "headers", None)
        if req_headers and req_headers.get("If-None-Match") == etag:
            return web.Response(status=304, headers=headers)
        return web.Response(
            body=body,
            content_type="image/png",
            headers=headers,
        )

    async def get(
        self, request: web.Request, z: str, x: str, y: str
    ) -> web.Response:
        """Handle tile request."""
        if not self._is_authorized(request):
            return web.Response(status=401, text="Unauthorized")

        # Sanitize y if it ends with .png
        y = y.removesuffix(".png")

        try:
            zoom = int(z)
            x_coord = int(x)
            y_coord = int(y)
        except (ValueError, TypeError):
            return web.Response(status=400, text="Invalid tile coordinates")

        if not (
            0 <= zoom <= 19
            and 0 <= x_coord < (1 << zoom)
            and 0 <= y_coord < (1 << zoom)
        ):
            return web.Response(status=400, text="Tile coordinate out of bounds")

        cache_key = f"{zoom}_{x_coord}_{y_coord}"

        # 1. Check in-memory cache
        async with self._cache_lock:
            if cache_key in self._memory_cache:
                self._memory_cache.move_to_end(cache_key)
                return self._build_tile_response(
                    request,
                    cache_key,
                    self._memory_cache[cache_key],
                    "MEMORY",
                )

        # 2. Check disk cache
        tile_path = self._get_tile_path(zoom, x_coord, y_coord)
        disk_result = await self._hass.async_add_executor_job(
            self._read_tile_from_disk, tile_path
        )
        disk_data, is_fresh = (
            disk_result
            if isinstance(disk_result, tuple)
            else (disk_result, bool(disk_result))
        )
        if disk_data and is_fresh:
            async with self._cache_lock:
                self._memory_cache[cache_key] = disk_data
                self._memory_cache.move_to_end(cache_key)
                if len(self._memory_cache) > MAX_MEMORY_CACHE_ITEMS:
                    self._memory_cache.popitem(last=False)
            return self._build_tile_response(
                request,
                cache_key,
                disk_data,
                "DISK",
            )

        # 3. Fetch from upstream with coalescing for concurrent identical requests
        async with self._cache_lock:
            inflight_task = self._inflight.get(cache_key)
            if inflight_task is None:
                inflight_task = asyncio.create_task(
                    self._fetch_upstream_tile(cache_key, zoom, x_coord, y_coord)
                )
                self._inflight[cache_key] = inflight_task

        try:
            tile_bytes = await inflight_task
        finally:
            async with self._cache_lock:
                if self._inflight.get(cache_key) is inflight_task:
                    self._inflight.pop(cache_key, None)

        if tile_bytes:
            await self._hass.async_add_executor_job(
                self._write_tile_to_disk, tile_path, tile_bytes
            )
            async with self._cache_lock:
                self._memory_cache[cache_key] = tile_bytes
                self._memory_cache.move_to_end(cache_key)
                if len(self._memory_cache) > MAX_MEMORY_CACHE_ITEMS:
                    self._memory_cache.popitem(last=False)
            return self._build_tile_response(
                request,
                cache_key,
                tile_bytes,
                "FETCH",
            )

        # 4. Serve stale disk tile if upstream failed
        if disk_data:
            async with self._cache_lock:
                self._memory_cache[cache_key] = disk_data
                self._memory_cache.move_to_end(cache_key)
                if len(self._memory_cache) > MAX_MEMORY_CACHE_ITEMS:
                    self._memory_cache.popitem(last=False)
            return self._build_tile_response(
                request,
                cache_key,
                disk_data,
                "DISK",
            )

        # Return transparent 1x1 tile as fallback
        return self._build_tile_response(
            request,
            cache_key,
            TRANSPARENT_1X1_PNG,
            "FALLBACK",
            max_age=300,
            immutable=False,
        )

