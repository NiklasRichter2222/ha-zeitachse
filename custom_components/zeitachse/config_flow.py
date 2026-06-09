"""Config flow for Zeitachse."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from cryptography.fernet import Fernet
import voluptuous as vol

from homeassistant import config_entries
from homeassistant.const import CONF_NAME
from homeassistant.helpers import selector

from .const import (
    COLOR_PALETTE,
    CONF_ENABLE_DASHBOARD,
    CONF_ENCRYPTION_KEY,
    CONF_INTERVAL_MINUTES,
    CONF_PERSON_COLORS,
    CONF_STAY_DISTANCE_METERS,
    CONF_STAY_MIN_SNAPSHOTS,
    CONF_TRACKED_PERSONS,
    DEFAULT_ENABLE_DASHBOARD,
    DEFAULT_INTERVAL_MINUTES,
    DEFAULT_STAY_DISTANCE_METERS,
    DEFAULT_STAY_MIN_SNAPSHOTS,
    DOMAIN,
    MAX_STAY_DISTANCE_METERS,
    MAX_STAY_MIN_SNAPSHOTS,
    MIN_STAY_DISTANCE_METERS,
    MIN_STAY_MIN_SNAPSHOTS,
)


def _is_valid_hex_color(value: Any) -> bool:
    """Validate #RRGGBB color format."""
    if not isinstance(value, str) or len(value) != 7 or not value.startswith("#"):
        return False
    try:
        int(value[1:], 16)
    except ValueError:
        return False
    return True


def _normalize_person_colors(tracked_persons: list[str], raw: Any) -> dict[str, str]:
    """Normalize configured person colors for tracked people."""
    source = raw if isinstance(raw, Mapping) else {}
    return {
        entity_id: (
            source.get(entity_id)
            if _is_valid_hex_color(source.get(entity_id))
            else COLOR_PALETTE[index % len(COLOR_PALETTE)]
        )
        for index, entity_id in enumerate(tracked_persons)
    }


def _build_schema(options: Mapping[str, Any]) -> vol.Schema:
    """Build schema for config and options flows."""
    tracked_persons = options.get(CONF_TRACKED_PERSONS, [])
    interval_minutes = options.get(CONF_INTERVAL_MINUTES, DEFAULT_INTERVAL_MINUTES)
    enable_dashboard = options.get(CONF_ENABLE_DASHBOARD, DEFAULT_ENABLE_DASHBOARD)
    person_colors = _normalize_person_colors(tracked_persons, options.get(CONF_PERSON_COLORS))
    stay_min_snapshots = options.get(CONF_STAY_MIN_SNAPSHOTS, DEFAULT_STAY_MIN_SNAPSHOTS)
    stay_distance_meters = options.get(CONF_STAY_DISTANCE_METERS, DEFAULT_STAY_DISTANCE_METERS)

    return vol.Schema(
        {
            vol.Optional(CONF_NAME, default=DOMAIN): selector.TextSelector(),
            vol.Optional(
                CONF_TRACKED_PERSONS,
                default=tracked_persons,
            ): selector.EntitySelector(
                selector.EntitySelectorConfig(domain="person", multiple=True)
            ),
            vol.Optional(
                CONF_INTERVAL_MINUTES,
                default=interval_minutes,
            ): selector.NumberSelector(
                selector.NumberSelectorConfig(
                    min=1,
                    max=1440,
                    mode=selector.NumberSelectorMode.BOX,
                )
            ),
            vol.Optional(
                CONF_ENABLE_DASHBOARD,
                default=enable_dashboard,
            ): selector.BooleanSelector(),
            vol.Optional(
                CONF_PERSON_COLORS,
                default=person_colors,
            ): selector.ObjectSelector(),
            vol.Optional(
                CONF_STAY_MIN_SNAPSHOTS,
                default=stay_min_snapshots,
            ): selector.NumberSelector(
                selector.NumberSelectorConfig(
                    min=MIN_STAY_MIN_SNAPSHOTS,
                    max=MAX_STAY_MIN_SNAPSHOTS,
                    mode=selector.NumberSelectorMode.BOX,
                    step=1,
                )
            ),
            vol.Optional(
                CONF_STAY_DISTANCE_METERS,
                default=stay_distance_meters,
            ): selector.NumberSelector(
                selector.NumberSelectorConfig(
                    min=MIN_STAY_DISTANCE_METERS,
                    max=MAX_STAY_DISTANCE_METERS,
                    mode=selector.NumberSelectorMode.BOX,
                    step=1,
                )
            ),
        }
    )


class ZeitachseConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle a config flow for Zeitachse."""

    VERSION = 1

    async def async_step_user(self, user_input: dict[str, Any] | None = None):
        """Handle initial setup."""
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")

        if user_input is not None:
            tracked_persons = user_input.get(CONF_TRACKED_PERSONS, [])
            data = {
                CONF_NAME: user_input[CONF_NAME],
                CONF_TRACKED_PERSONS: tracked_persons,
                CONF_INTERVAL_MINUTES: int(user_input[CONF_INTERVAL_MINUTES]),
                CONF_ENABLE_DASHBOARD: bool(user_input[CONF_ENABLE_DASHBOARD]),
                CONF_PERSON_COLORS: _normalize_person_colors(
                    tracked_persons,
                    user_input.get(CONF_PERSON_COLORS),
                ),
                CONF_STAY_MIN_SNAPSHOTS: int(user_input[CONF_STAY_MIN_SNAPSHOTS]),
                CONF_STAY_DISTANCE_METERS: int(user_input[CONF_STAY_DISTANCE_METERS]),
                CONF_ENCRYPTION_KEY: Fernet.generate_key().decode(),
            }
            return self.async_create_entry(title=user_input[CONF_NAME], data=data)

        return self.async_show_form(step_id="user", data_schema=_build_schema({}))

    @staticmethod
    def async_get_options_flow(config_entry: config_entries.ConfigEntry):
        """Get options flow."""
        return ZeitachseOptionsFlow(config_entry)


class ZeitachseOptionsFlow(config_entries.OptionsFlow):
    """Handle options flow for Zeitachse."""

    def __init__(self, config_entry: config_entries.ConfigEntry) -> None:
        """Initialize options flow."""
        self._config_entry = config_entry

    async def async_step_init(self, user_input: dict[str, Any] | None = None):
        """Manage options."""
        merged = {**self._config_entry.data, **self._config_entry.options}

        if user_input is not None:
            tracked_persons = user_input.get(CONF_TRACKED_PERSONS, [])
            return self.async_create_entry(
                title="",
                data={
                    CONF_TRACKED_PERSONS: tracked_persons,
                    CONF_INTERVAL_MINUTES: int(user_input[CONF_INTERVAL_MINUTES]),
                    CONF_ENABLE_DASHBOARD: bool(user_input[CONF_ENABLE_DASHBOARD]),
                    CONF_PERSON_COLORS: _normalize_person_colors(
                        tracked_persons,
                        user_input.get(CONF_PERSON_COLORS),
                    ),
                    CONF_STAY_MIN_SNAPSHOTS: int(user_input[CONF_STAY_MIN_SNAPSHOTS]),
                    CONF_STAY_DISTANCE_METERS: int(user_input[CONF_STAY_DISTANCE_METERS]),
                },
            )

        return self.async_show_form(step_id="init", data_schema=_build_schema(merged))
