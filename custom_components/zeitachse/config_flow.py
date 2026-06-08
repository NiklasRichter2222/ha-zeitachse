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
    CONF_ENABLE_DASHBOARD,
    CONF_ENCRYPTION_KEY,
    CONF_INTERVAL_MINUTES,
    CONF_TRACKED_PERSONS,
    DEFAULT_ENABLE_DASHBOARD,
    DEFAULT_INTERVAL_MINUTES,
    DOMAIN,
)


def _build_schema(options: Mapping[str, Any]) -> vol.Schema:
    """Build schema for config and options flows."""
    tracked_persons = options.get(CONF_TRACKED_PERSONS, [])
    interval_minutes = options.get(CONF_INTERVAL_MINUTES, DEFAULT_INTERVAL_MINUTES)
    enable_dashboard = options.get(CONF_ENABLE_DASHBOARD, DEFAULT_ENABLE_DASHBOARD)

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
            data = {
                CONF_NAME: user_input[CONF_NAME],
                CONF_TRACKED_PERSONS: user_input.get(CONF_TRACKED_PERSONS, []),
                CONF_INTERVAL_MINUTES: int(user_input[CONF_INTERVAL_MINUTES]),
                CONF_ENABLE_DASHBOARD: bool(user_input[CONF_ENABLE_DASHBOARD]),
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
            return self.async_create_entry(
                title="",
                data={
                    CONF_TRACKED_PERSONS: user_input.get(CONF_TRACKED_PERSONS, []),
                    CONF_INTERVAL_MINUTES: int(user_input[CONF_INTERVAL_MINUTES]),
                    CONF_ENABLE_DASHBOARD: bool(user_input[CONF_ENABLE_DASHBOARD]),
                },
            )

        return self.async_show_form(step_id="init", data_schema=_build_schema(merged))
