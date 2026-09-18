"""Tile proxy view and caching for Zeitachse."""

from __future__ import annotations

import asyncio
from collections import OrderedDict
import logging
import os

from aiohttp import ClientError, ClientTimeout, web
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.http import HomeAssistantView

_LOGGER = logging.getLogger(__name__)

USER_AGENT = "HomeAssistant-Zeitachse/1.0 (+https://github.com/NiklasRichter2222/ha-zeitachse)"
UPSTREAM_TIMEOUT_SECONDS = 10
MAX_MEMORY_CACHE_ITEMS = 500

# 1x1 transparent PNG fallback in case of upstream network failure
TRANSPARENT_1X1_PNG = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
    b"\x08\x06\x00\x00\x00\x1f\x15c4\x00\x00\x00\rIDATx\x9cc`\x00\x00\x00"
    b"\x02\x00\x01H\xaf\xa4q\x00\x00\x00\x00IEND\xaeB`\x82"
)


class ZeitachseTileProxyView(HomeAssistantView):
    """Serve cached OpenStreetMap tiles to compliant frontend clients."""

    url = "/api/zeitachse/tiles/{z}/{x}/{y}.png"
    extra_urls = ["/api/zeitachse/tiles/{z}/{x}/{y}"]
    name = "api:zeitachse:tiles"
    requires_auth = False
    cors_allowed = True

    def __init__(self, hass: HomeAssistant) -> None:
        """Initialize tile proxy."""
        self._hass = hass
        try:
            self._cache_dir = hass.config.path(".storage", "zeitachse_tiles")
        except TypeError:
            self._cache_dir = os.path.join(hass.config.path(".storage"), "zeitachse_tiles")
        self._memory_cache: OrderedDict[str, bytes] = OrderedDict()
        self._cache_lock = asyncio.Lock()
        self._semaphore = asyncio.Semaphore(6)

    def _get_tile_path(self, z: int, x: int, y: int) -> str:
        return os.path.join(self._cache_dir, f"{z}_{x}_{y}.png")

    def _read_tile_from_disk(self, file_path: str) -> bytes | None:
        try:
            if os.path.exists(file_path):
                with open(file_path, "rb") as file_handle:
                    return file_handle.read()
        except OSError as err:
            _LOGGER.debug("Failed to read tile from disk %s: %s", file_path, err)
        return None

    def _write_tile_to_disk(self, file_path: str, data: bytes) -> None:
        try:
            os.makedirs(os.path.dirname(file_path), exist_ok=True)
            temp_path = f"{file_path}.tmp"
            with open(temp_path, "wb") as file_handle:
                file_handle.write(data)
            os.replace(temp_path, file_path)
        except OSError as err:
            _LOGGER.debug("Failed to write tile to disk %s: %s", file_path, err)

    async def get(
        self, request: web.Request, z: str, x: str, y: str
    ) -> web.Response:
        """Handle tile request."""
        # Sanitize y if it ends with .png
        if y.endswith(".png"):
            y = y[:-4]

        try:
            zoom = int(z)
            x_coord = int(x)
            y_coord = int(y)
        except (ValueError, TypeError):
            return web.Response(status=400, text="Invalid tile coordinates")

        if not (0 <= zoom <= 19 and 0 <= x_coord < (1 << zoom) and 0 <= y_coord < (1 << zoom)):
            return web.Response(status=400, text="Tile coordinate out of bounds")

        cache_key = f"{zoom}_{x_coord}_{y_coord}"

        # 1. Check in-memory cache
        async with self._cache_lock:
            if cache_key in self._memory_cache:
                self._memory_cache.move_to_end(cache_key)
                return web.Response(
                    body=self._memory_cache[cache_key],
                    content_type="image/png",
                    headers={
                        "Cache-Control": "public, max-age=604800, immutable",
                        "X-Zeitachse-Cache": "MEMORY",
                    },
                )

        # 2. Check disk cache
        tile_path = self._get_tile_path(zoom, x_coord, y_coord)
        disk_data = await self._hass.async_add_executor_job(
            self._read_tile_from_disk, tile_path
        )
        if disk_data:
            async with self._cache_lock:
                self._memory_cache[cache_key] = disk_data
                if len(self._memory_cache) > MAX_MEMORY_CACHE_ITEMS:
                    self._memory_cache.popitem(last=False)
            return web.Response(
                body=disk_data,
                content_type="image/png",
                headers={
                    "Cache-Control": "public, max-age=604800, immutable",
                    "X-Zeitachse-Cache": "DISK",
                },
            )

        # 3. Fetch from upstream with OSM-compliant headers
        session = async_get_clientsession(self._hass)
        headers = {
            "User-Agent": USER_AGENT,
            "Referer": "https://www.openstreetmap.org/",
            "Accept": "image/avif,image/webp,image/apng,image/png,image/*,*/*;q=0.8",
        }

        urls = [
            f"https://tile.openstreetmap.org/{zoom}/{x_coord}/{y_coord}.png",
            f"https://tile.openstreetmap.de/{zoom}/{x_coord}/{y_coord}.png",
        ]

        tile_bytes: bytes | None = None
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
                                tile_bytes = content
                                break
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
                except (ClientError, asyncio.TimeoutError) as err:
                    _LOGGER.debug("Network error fetching tile %s from %s: %s", cache_key, url, err)

        if tile_bytes:
            # Store in disk cache and memory cache
            await self._hass.async_add_executor_job(
                self._write_tile_to_disk, tile_path, tile_bytes
            )
            async with self._cache_lock:
                self._memory_cache[cache_key] = tile_bytes
                if len(self._memory_cache) > MAX_MEMORY_CACHE_ITEMS:
                    self._memory_cache.popitem(last=False)
            return web.Response(
                body=tile_bytes,
                content_type="image/png",
                headers={
                    "Cache-Control": "public, max-age=604800, immutable",
                    "X-Zeitachse-Cache": "FETCH",
                },
            )

        # Return transparent 1x1 tile as fallback
        return web.Response(
            body=TRANSPARENT_1X1_PNG,
            content_type="image/png",
            headers={
                "Cache-Control": "public, max-age=300",
                "X-Zeitachse-Cache": "FALLBACK",
            },
        )
