import { LEAFLET_SHADOW_CSS } from "./leaflet-shadow-css.js";
import {
  BASEMAP_PROVIDERS,
  clusterStays,
  ensureLeafletLoaded,
  getInitials,
  getSharedCanvasRenderer,
  haversineMeters,
  pointKey,
  renderTimelineTrack,
  sanitizeColor,
  setupTileLayer,
  simplifyPoints,
  toPoint,
  toTimestamp,
  toTimestampMs,
  updateOverlapCulledTooltips,
} from "./map-utils.js";

const DEFAULT_MAP_CENTER = [51.1657, 10.4515];
const DEFAULT_MAP_ZOOM = 6;
const RANGE_OPTIONS = ["1h", "1d", "1w", "1m", "1y"];
const RANGE_LABELS = {
  "1h": "1h",
  "1d": "1d",
  "1w": "1w",
  "1m": "1m",
  "1y": "1j",
};
const RANGE_TOLERANCE_METERS = {
  "1h": 2,
  "1d": 4,
  "1w": 10,
  "1m": 25,
  "1y": 60,
};
const RANGE_MAX_TRACK_POINTS = {
  "1h": 1500,
  "1d": 2000,
  "1w": 2200,
  "1m": 2500,
  "1y": 2800,
};
const DEFAULT_STAY_DISTANCE_METERS = 75;
const DEFAULT_STAY_MIN_SNAPSHOTS = 6;
const MIN_STAY_DISTANCE_METERS = 5;
const MAX_STAY_DISTANCE_METERS = 2000;
const MIN_STAY_MIN_SNAPSHOTS = 2;
const MAX_STAY_MIN_SNAPSHOTS = 500;
const INITIAL_STAY_RENDER_LIMIT = 150;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatPersonState(stateStr) {
  if (!stateStr) return "Unbekannt";
  const lower = String(stateStr).toLowerCase();
  if (lower === "home") return "Zuhause";
  if (lower === "not_home" || lower === "away") return "Abwesend";
  if (lower === "unknown" || lower === "unavailable") return "Unbekannt";
  return String(stateStr);
}

function formatRelativeTime(timestampInput) {
  if (!timestampInput) return "";
  const ms = typeof timestampInput === "number" ? timestampInput : Date.parse(timestampInput);
  if (Number.isNaN(ms)) return "";
  const diffMinutes = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (diffMinutes < 1) return "gerade eben";
  if (diffMinutes < 60) return `vor ${diffMinutes} Min.`;
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `vor ${diffHours} Std.`;
  const diffDays = Math.round(diffHours / 24);
  return `vor ${diffDays} ${diffDays === 1 ? "Tag" : "Tagen"}`;
}

function groupStaysByPeriod(stays, selectedRange) {
  const groups = new Map();
  const dayFormatter = new Intl.DateTimeFormat("de-DE", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  const monthFormatter = new Intl.DateTimeFormat("de-DE", {
    month: "long",
    year: "numeric",
  });
  const shortDayFormatter = new Intl.DateTimeFormat("de-DE", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });

  for (const stay of stays) {
    const start = stay.start;
    if (!start) continue;

    let key = "";
    let title = "";

    if (selectedRange === "1y") {
      key = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}`;
      title = monthFormatter.format(start);
    } else if (selectedRange === "1m") {
      key = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}-${String(start.getDate()).padStart(2, "0")}`;
      title = shortDayFormatter.format(start);
    } else {
      key = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}-${String(start.getDate()).padStart(2, "0")}`;
      title = dayFormatter.format(start);
    }

    if (!groups.has(key)) {
      groups.set(key, { title, stays: [], totalDurationMs: 0 });
    }
    const group = groups.get(key);
    group.stays.push(stay);
    group.totalDurationMs += stay.durationMs || 0;
  }

  return Array.from(groups.values());
}

class ZeitachsePanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.people = [];
    this.timelineByPerson = new Map();
    this.map = null;
    this.layers = [];
    this.stays = [];
    this.stayClusters = [];
    this.stayMarkers = [];
    this.poiByPoint = new Map();
    this._loaded = false;
    this._mapInitFailed = false;
    this._isFullMap = false;
    this._poiLookupVersion = 0;
    this._lastZoom = null;
    this._isPreloading = false;
    this._themeOverride = null; // null = follow HA, "dark" or "light"
    this._activeTheme = "dark";
    this._showAllStays = false;
    this._selectedStayIndex = null;
    this.selectedRange = "1d";
    this.staySettings = {
      min_snapshots: DEFAULT_STAY_MIN_SNAPSHOTS,
      distance_meters: DEFAULT_STAY_DISTANCE_METERS,
    };
  }

  disconnectedCallback() {
    this._resizeObserver?.disconnect();
    this._resizeObserver = null;
  }

  set hass(hass) {
    this._hass = hass;
    if (!this.shadowRoot.innerHTML) {
      this._renderShell();
    }
    this._syncTheme();
    if (!this._loaded && this._hass) {
      this._loaded = true;
      this._load().catch((error) => {
        console.error("[zeitachse-panel] Loading failed", error);
        this._showStatus(`Loading failed: ${error?.message || error}`);
      });
    }
  }

  _resolveIsDark() {
    if (this._themeOverride === "dark") return true;
    if (this._themeOverride === "light") return false;
    if (typeof this._hass?.themes?.darkMode === "boolean") {
      return this._hass.themes.darkMode;
    }
    if (typeof window !== "undefined" && window.matchMedia) {
      return window.matchMedia("(prefers-color-scheme: dark)").matches;
    }
    return true;
  }

  _syncTheme() {
    const root = this.shadowRoot?.getElementById("panel-root");
    if (!root) return;
    const isDark = this._resolveIsDark();
    this._activeTheme = isDark ? "dark" : "light";
    root.classList.toggle("theme-dark", isDark);
    root.classList.toggle("theme-light", !isDark);
    root.setAttribute("data-theme", this._activeTheme);

    const iconMoon = this.shadowRoot.getElementById("icon-theme-dark");
    const iconSun = this.shadowRoot.getElementById("icon-theme-light");
    if (iconMoon && iconSun) {
      iconMoon.style.display = isDark ? "block" : "none";
      iconSun.style.display = isDark ? "none" : "block";
    }
  }

  _renderShell() {
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          height: 100vh;
          width: 100%;
          overflow: hidden;
          box-sizing: border-box;
          font-family: var(--paper-font-body1_-_font-family, Roboto, system-ui, -apple-system, sans-serif);
        }
        .panel-root {
          --zeitachse-bg: #111111;
          --zeitachse-map-bg: #141414;
          --zeitachse-surface: rgba(28, 28, 28, 0.92);
          --zeitachse-surface-solid: #1c1c1c;
          --zeitachse-surface-elevated: #242424;
          --zeitachse-surface-hover: rgba(255, 255, 255, 0.06);
          --zeitachse-pill-bg: rgba(255, 255, 255, 0.06);
          --zeitachse-pill-active: rgba(255, 255, 255, 0.14);
          --zeitachse-badge-bg: #2b2b2b;
          --zeitachse-text: #e1e1e1;
          --zeitachse-text-secondary: #9b9b9b;
          --zeitachse-text-muted: #6e6e6e;
          --zeitachse-border: rgba(255, 255, 255, 0.08);
          --zeitachse-accent: var(--primary-color, #03a9f4);
          --zeitachse-shadow: 0 6px 24px rgba(0, 0, 0, 0.45);
          --zeitachse-tooltip-bg: rgba(28, 28, 28, 0.94);
          --zeitachse-tooltip-text: #f1f1f1;

          display: flex;
          flex-direction: column;
          height: 100%;
          width: 100%;
          overflow: hidden;
          box-sizing: border-box;
          padding: 8px;
          gap: 8px;
          background: var(--zeitachse-bg);
          color: var(--zeitachse-text);
          transition: background-color 0.2s ease, color 0.2s ease;
        }
        .panel-root.theme-light {
          --zeitachse-bg: #f5f5f7;
          --zeitachse-map-bg: #e5e3df;
          --zeitachse-surface: rgba(255, 255, 255, 0.93);
          --zeitachse-surface-solid: #ffffff;
          --zeitachse-surface-elevated: #ffffff;
          --zeitachse-surface-hover: rgba(0, 0, 0, 0.045);
          --zeitachse-pill-bg: rgba(0, 0, 0, 0.06);
          --zeitachse-pill-active: #ffffff;
          --zeitachse-badge-bg: #eef0f3;
          --zeitachse-text: #1c1c1e;
          --zeitachse-text-secondary: #636366;
          --zeitachse-text-muted: #8e8e93;
          --zeitachse-border: rgba(0, 0, 0, 0.09);
          --zeitachse-accent: var(--primary-color, #0088cc);
          --zeitachse-shadow: 0 6px 24px rgba(0, 0, 0, 0.12);
          --zeitachse-tooltip-bg: rgba(255, 255, 255, 0.95);
          --zeitachse-tooltip-text: #1c1c1e;
        }
        .status {
          display: none;
        }
        .main-split {
          flex: 1;
          min-height: 0;
          display: flex;
          flex-direction: column;
          gap: 8px;
          overflow: hidden;
        }
        .map-wrapper {
          position: relative;
          flex: 62 1 0%;
          min-height: 0;
          border-radius: 16px;
          overflow: hidden;
          border: 1px solid var(--zeitachse-border);
          box-shadow: var(--zeitachse-shadow);
          background: var(--zeitachse-map-bg);
        }
        .map-wrapper.full-map {
          flex: 1 1 100%;
        }
        #map {
          width: 100%;
          height: 100%;
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
        }
        /* Floating HA Map Left Card */
        .controls {
          position: absolute;
          top: 14px;
          left: 14px;
          z-index: 1000;
          width: min(310px, calc(100% - 70px));
          max-height: calc(100% - 28px);
          overflow-y: auto;
          border: 1px solid var(--zeitachse-border);
          border-radius: 16px;
          padding: 12px;
          box-sizing: border-box;
          backdrop-filter: blur(16px);
          -webkit-backdrop-filter: blur(16px);
          background: var(--zeitachse-surface);
          box-shadow: var(--zeitachse-shadow);
          scrollbar-width: thin;
        }
        /* Segmented Pill Bar like HA Map */
        .range-row {
          display: flex;
          align-items: center;
          background: var(--zeitachse-pill-bg);
          border-radius: 999px;
          padding: 3px;
          gap: 2px;
          margin-bottom: 10px;
        }
        .range-btn {
          flex: 1;
          border: none;
          background: transparent;
          color: var(--zeitachse-text-secondary);
          border-radius: 999px;
          padding: 6px 8px;
          font-size: 0.8rem;
          font-weight: 500;
          cursor: pointer;
          transition: background-color 0.15s ease, color 0.15s ease, box-shadow 0.15s ease;
        }
        .range-btn:hover {
          color: var(--zeitachse-text);
        }
        .range-btn.active {
          background: var(--zeitachse-pill-active);
          color: var(--zeitachse-text);
          font-weight: 600;
          box-shadow: 0 1px 4px rgba(0, 0, 0, 0.18);
        }
        .controls-header-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0 4px 6px 4px;
          border-bottom: 1px solid var(--zeitachse-border);
          margin-bottom: 6px;
        }
        .controls-section-label {
          font-size: 0.76rem;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.04em;
          color: var(--zeitachse-text-secondary);
        }
        .summary {
          color: var(--zeitachse-text-secondary);
          font-size: 0.76rem;
        }
        /* HA Map Style Person List Rows */
        .person {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 6px 6px;
          margin: 2px 0;
          border-radius: 12px;
          transition: background-color 0.15s ease;
        }
        .person:hover {
          background: var(--zeitachse-surface-hover);
        }
        .person-avatar {
          position: relative;
          width: 36px;
          height: 36px;
          border-radius: 10px;
          background: var(--zeitachse-badge-bg);
          color: var(--zeitachse-text);
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 0.78rem;
          font-weight: 700;
          flex-shrink: 0;
          cursor: pointer;
          user-select: none;
          border: 1.5px solid transparent;
          transition: transform 0.15s ease, border-color 0.15s ease;
        }
        .person-avatar:hover {
          transform: scale(1.04);
        }
        .dot {
          width: 9px;
          height: 9px;
          border-radius: 50%;
          position: absolute;
          bottom: -2px;
          right: -2px;
          border: 2px solid var(--zeitachse-surface-solid);
          display: inline-block;
        }
        .person-info {
          flex: 1;
          min-width: 0;
          display: flex;
          flex-direction: column;
          cursor: pointer;
        }
        .person-name {
          font-size: 0.88rem;
          font-weight: 600;
          color: var(--zeitachse-text);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          line-height: 1.25;
        }
        .person-subtitle {
          font-size: 0.74rem;
          color: var(--zeitachse-text-secondary);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          line-height: 1.25;
          margin-top: 1px;
        }
        .person-actions {
          display: flex;
          align-items: center;
          gap: 6px;
          flex-shrink: 0;
        }
        .color-picker {
          width: 22px;
          height: 22px;
          border: none;
          padding: 0;
          background: transparent;
          cursor: pointer;
          border-radius: 50%;
        }
        .person-active {
          width: 16px;
          height: 16px;
          accent-color: var(--zeitachse-accent);
          cursor: pointer;
          margin: 0;
        }

        /* Top-Right Map Action Controls (below Leaflet zoom buttons) */
        .map-action-stack {
          position: absolute;
          top: 92px;
          right: 14px;
          z-index: 1000;
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .map-icon-btn {
          width: 34px;
          height: 34px;
          border-radius: 10px;
          background: var(--zeitachse-surface);
          color: var(--zeitachse-text);
          border: 1px solid var(--zeitachse-border);
          box-shadow: var(--zeitachse-shadow);
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          backdrop-filter: blur(14px);
          -webkit-backdrop-filter: blur(14px);
          transition: background-color 0.15s ease, color 0.15s ease, transform 0.15s ease;
          padding: 0;
        }
        .map-icon-btn:hover {
          background: var(--zeitachse-surface-hover);
          color: var(--zeitachse-accent);
          transform: translateY(-1px);
        }
        .map-icon-btn:active {
          transform: scale(0.95);
        }

        /* Stay List Panel */
        .stay-list-panel {
          flex: 38 1 0%;
          min-height: 0;
          border: 1px solid var(--zeitachse-border);
          border-radius: 16px;
          padding: 14px 16px;
          overflow-y: auto;
          box-sizing: border-box;
          background: var(--zeitachse-surface-solid);
          box-shadow: var(--zeitachse-shadow);
          scrollbar-width: thin;
        }
        .stay-list-panel.hidden {
          display: none;
        }
        .stay-header-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          margin-bottom: 12px;
        }
        .stay-header-title {
          font-weight: 600;
          font-size: 0.98rem;
          color: var(--zeitachse-text);
        }
        .stay-header-hint {
          font-size: 0.78rem;
          color: var(--zeitachse-text-secondary);
        }
        .stay-section {
          margin-bottom: 14px;
          content-visibility: auto;
          contain-intrinsic-size: 120px;
        }
        .stay-section-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 7px 12px;
          background: var(--zeitachse-pill-bg);
          border-left: 3px solid var(--zeitachse-accent);
          border-radius: 6px 10px 10px 6px;
          font-weight: 600;
          font-size: 0.86rem;
          color: var(--zeitachse-text);
          margin-bottom: 6px;
        }
        .stay-section-badge {
          font-size: 0.75rem;
          font-weight: 500;
          color: var(--zeitachse-text-secondary);
        }
        .stay-item {
          border-top: 1px solid var(--zeitachse-border);
          padding: 8px 10px;
          cursor: pointer;
          border-radius: 10px;
          transition: background-color 0.15s ease, transform 0.1s ease;
          outline: none;
        }
        .stay-item:first-of-type {
          border-top: none;
        }
        .stay-item:hover,
        .stay-item:focus-visible {
          background-color: var(--zeitachse-surface-hover);
        }
        .stay-item.selected {
          background-color: color-mix(in srgb, var(--zeitachse-accent) 14%, transparent);
          border-left: 3px solid var(--zeitachse-accent);
        }
        .stay-item-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 8px;
        }
        .stay-item-title {
          font-weight: 600;
          font-size: 0.9rem;
          display: flex;
          align-items: center;
          gap: 8px;
          color: var(--zeitachse-text);
          min-width: 0;
        }
        .stay-person-dot {
          width: 10px;
          height: 10px;
          border-radius: 50%;
          flex-shrink: 0;
          display: inline-block;
        }
        .stay-person-tag {
          font-weight: 400;
          font-size: 0.8rem;
          color: var(--zeitachse-text-secondary);
        }
        .stay-item-right {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-shrink: 0;
        }
        .stay-locate-badge {
          font-size: 0.74rem;
          color: var(--zeitachse-accent);
          opacity: 0;
          transition: opacity 0.15s ease;
          font-weight: 500;
        }
        .stay-item:hover .stay-locate-badge,
        .stay-item:focus-visible .stay-locate-badge,
        .stay-item.selected .stay-locate-badge {
          opacity: 1;
        }
        .stay-duration-tag {
          background: var(--zeitachse-pill-bg);
          color: var(--zeitachse-text);
          border: 1px solid var(--zeitachse-border);
          border-radius: 999px;
          padding: 2px 8px;
          font-size: 0.74rem;
          font-weight: 600;
          flex-shrink: 0;
        }
        .stay-meta {
          color: var(--zeitachse-text-secondary);
          font-size: 0.79rem;
          margin-top: 3px;
          padding-left: 18px;
        }
        .stay-empty {
          color: var(--zeitachse-text-secondary);
          font-size: 0.88rem;
          padding: 8px 2px;
        }
        .stay-load-more {
          display: block;
          width: 100%;
          padding: 8px 12px;
          margin-top: 8px;
          border-radius: 10px;
          border: 1px solid var(--zeitachse-border);
          background: var(--zeitachse-pill-bg);
          color: var(--zeitachse-text);
          font-weight: 600;
          font-size: 0.84rem;
          cursor: pointer;
          text-align: center;
        }
        .stay-load-more:hover {
          background: var(--zeitachse-surface-hover);
        }

        /* Tooltip styling within Shadow DOM */
        .leaflet-tooltip.zeitachse-poi-label {
          position: absolute !important;
          background: var(--zeitachse-tooltip-bg) !important;
          color: var(--zeitachse-tooltip-text) !important;
          border: 1px solid var(--zeitachse-border) !important;
          border-radius: 8px !important;
          padding: 3px 9px !important;
          font-size: 11px !important;
          font-weight: 600 !important;
          white-space: nowrap !important;
          box-shadow: var(--zeitachse-shadow) !important;
          pointer-events: none !important;
          backdrop-filter: blur(8px) !important;
          -webkit-backdrop-filter: blur(8px) !important;
        }
        .leaflet-tooltip-top:before {
          border-top-color: var(--zeitachse-tooltip-bg) !important;
        }
        ${LEAFLET_SHADOW_CSS}
      </style>
      <div class="panel-root theme-dark" id="panel-root" data-theme="dark">
        <div class="status" id="status">Zeitachse lädt…</div>
        <div class="main-split">
          <div class="map-wrapper" id="map-wrapper">
            <div id="map"></div>
            <div class="controls" id="controls"></div>
            <div class="map-action-stack">
              <button class="map-icon-btn" id="fit-bounds-btn" type="button" title="Ansicht zentrieren" aria-label="Ansicht zentrieren">
                <svg viewBox="0 0 24 24" width="18" height="18">
                  <path fill="currentColor" d="M12,8A4,4 0 0,1 16,12A4,4 0 0,1 12,16A4,4 0 0,1 8,12A4,4 0 0,1 12,8M3.05,13H1V11H3.05C3.5,6.83 6.83,3.5 11,3.05V1H13V3.05C17.17,3.5 20.5,6.83 20.95,11H23V13H20.95C20.5,17.17 17.17,20.5 13,20.95V23H11V20.95C6.83,20.5 3.5,17.17 3.05,13M12,5A7,7 0 0,0 5,12A7,7 0 0,0 12,19A7,7 0 0,0 19,12A7,7 0 0,0 12,5Z"/>
                </svg>
              </button>
              <button class="map-icon-btn" id="theme-toggle-btn" type="button" title="Hell-/Dunkelmodus umschalten" aria-label="Hell-/Dunkelmodus umschalten">
                <svg id="icon-theme-dark" viewBox="0 0 24 24" width="18" height="18">
                  <path fill="currentColor" d="M17.75,4.09L15.22,6.03L16.13,9.09L13.5,7.28L10.87,9.09L11.78,6.03L9.25,4.09L12.44,4L13.5,1L14.56,4L17.75,4.09M21.25,11L19.61,12.25L20.2,14.23L18.5,13.06L16.8,14.23L17.39,12.25L15.75,11L17.81,10.95L18.5,9L19.19,10.95L21.25,11M18.97,15.95C19.8,15.87 20.69,17.05 20.16,17.8C19.84,18.25 19.5,18.67 19.08,19.07C15.17,23 8.84,23 4.94,19.07C1.03,15.17 1.03,8.83 4.94,4.93C5.34,4.53 5.76,4.17 6.21,3.85C6.96,3.32 8.14,4.21 8.06,5.04C7.79,7.9 8.75,10.87 10.95,13.06C13.14,15.26 16.1,16.22 18.97,15.95M17.33,17.97C14.5,17.81 11.7,16.64 9.53,14.5C7.36,12.31 6.2,9.5 6.04,6.68C3.23,9.82 3.34,14.64 6.35,17.66C9.37,20.67 14.19,20.78 17.33,17.97Z"/>
                </svg>
                <svg id="icon-theme-light" viewBox="0 0 24 24" width="18" height="18" style="display:none;">
                  <path fill="currentColor" d="M12,7A5,5 0 0,1 17,12A5,5 0 0,1 12,17A5,5 0 0,1 7,12A5,5 0 0,1 12,7M12,9A3,3 0 0,0 9,12A3,3 0 0,0 12,15A3,3 0 0,0 15,12A3,3 0 0,0 12,9M12,2L14.39,5.42C13.65,5.15 12.84,5 12,5C11.16,5 10.35,5.15 9.61,5.42L12,2M3.34,7L7.5,6.65C6.9,7.16 6.36,7.78 5.94,8.5C5.5,9.24 5.25,10 5.11,10.79L3.34,7M3.36,17L5.12,13.23C5.26,14 5.53,14.78 5.95,15.5C6.37,16.24 6.91,16.86 7.5,17.37L3.36,17M20.65,7L18.88,10.79C18.74,10 18.47,9.23 18.05,8.5C17.63,7.78 17.1,7.15 16.5,6.64L20.65,7M20.64,17L16.5,17.36C17.09,16.85 17.62,16.22 18.04,15.5C18.46,14.77 18.73,14 18.87,13.21L20.64,17M12,22L9.59,18.56C10.33,18.83 11.14,19 12,19C12.82,19 13.63,18.83 14.37,18.56L12,22Z"/>
                </svg>
              </button>
              <button class="map-icon-btn fullscreen-fab" id="fullscreen-fab" type="button" title="Vollbild Karte umschalten" aria-label="Vollbild Karte umschalten">
                <svg id="icon-expand" viewBox="0 0 24 24" width="18" height="18">
                  <path fill="currentColor" d="M5,5H10V7H7V10H5V5M14,5H19V10H17V7H14V5M17,14H19V19H14V17H17V14M10,17V19H5V14H7V17H10Z"/>
                </svg>
                <svg id="icon-shrink" viewBox="0 0 24 24" width="18" height="18" style="display:none;">
                  <path fill="currentColor" d="M14,14H19V16H16V19H14V14M5,14H10V19H8V16H5V14M8,5H10V10H5V8H8V5M19,8V10H14V5H16V8H19Z"/>
                </svg>
              </button>
            </div>
          </div>
          <div class="stay-list-panel" id="stay-list"></div>
        </div>
      </div>
    `;

    this._syncTheme();

    const fab = this.shadowRoot.getElementById("fullscreen-fab");
    const iconExpand = this.shadowRoot.getElementById("icon-expand");
    const iconShrink = this.shadowRoot.getElementById("icon-shrink");
    const mapWrapper = this.shadowRoot.getElementById("map-wrapper");
    const stayList = this.shadowRoot.getElementById("stay-list");
    const fitBoundsBtn = this.shadowRoot.getElementById("fit-bounds-btn");
    const themeToggleBtn = this.shadowRoot.getElementById("theme-toggle-btn");

    fab.addEventListener("click", () => {
      this._isFullMap = !this._isFullMap;
      if (this._isFullMap) {
        mapWrapper.classList.add("full-map");
        stayList.classList.add("hidden");
        iconExpand.style.display = "none";
        iconShrink.style.display = "block";
      } else {
        mapWrapper.classList.remove("full-map");
        stayList.classList.remove("hidden");
        iconExpand.style.display = "block";
        iconShrink.style.display = "none";
      }
      requestAnimationFrame(() => {
        if (this.map) {
          this.map.invalidateSize(false);
        }
      });
    });

    fitBoundsBtn?.addEventListener("click", () => {
      this._fitMapToAllLayers();
    });

    themeToggleBtn?.addEventListener("click", () => {
      const currentlyDark = this._resolveIsDark();
      this._themeOverride = currentlyDark ? "light" : "dark";
      this._syncTheme();
    });
  }

  _fitMapToAllLayers() {
    if (!this.map || !window.L) return;
    if (this.layers.length > 0) {
      const group = window.L.featureGroup(this.layers);
      const bounds = group.getBounds();
      if (bounds.isValid()) {
        this.map.fitBounds(bounds, { padding: [40, 40], maxZoom: 16 });
        return;
      }
    }
    this.map.setView(DEFAULT_MAP_CENTER, DEFAULT_MAP_ZOOM);
  }

  _showStatus(message) {
    const status = this.shadowRoot.getElementById("status");
    if (status) {
      status.textContent = message;
    }
  }

  async _waitForLeaflet() {
    try {
      const L = await ensureLeafletLoaded();
      return !!L;
    } catch (error) {
      console.error("[zeitachse-panel] Failed to load Leaflet:", error);
      return false;
    }
  }

  _initMap() {
    if (!window.L || this.map) return false;
    const mapElement = this.shadowRoot.getElementById("map");
    if (!mapElement) return false;
    try {
      this.map = window.L.map(mapElement, {
        preferCanvas: true,
        zoomControl: false,
      }).setView(DEFAULT_MAP_CENTER, DEFAULT_MAP_ZOOM);

      if (window.L.control?.zoom) {
        window.L.control.zoom({ position: "topright" }).addTo(this.map);
      }

      this._tileController = setupTileLayer(this.map, {
        provider: this._selectedBasemap || "local_osm",
      });

      let cullScheduled = false;
      const scheduleTooltipCull = () => {
        if (cullScheduled) return;
        cullScheduled = true;
        requestAnimationFrame(() => {
          cullScheduled = false;
          this._updateTooltipsVisibility();
        });
      };

      this.map.on("zoomend", scheduleTooltipCull);
      this.map.on("moveend", scheduleTooltipCull);

      requestAnimationFrame(() => this.map?.invalidateSize(false));

      let resizeScheduled = false;
      this._resizeObserver = new ResizeObserver(() => {
        if (!resizeScheduled) {
          resizeScheduled = true;
          requestAnimationFrame(() => {
            resizeScheduled = false;
            if (this.map) {
              this.map.invalidateSize(false);
              this._updateTooltipsVisibility();
            }
          });
        }
      });
      this._resizeObserver.observe(mapElement);
      console.debug("[zeitachse-panel] Map initialized");
      this._mapInitFailed = false;
      return true;
    } catch (error) {
      console.error("[zeitachse-panel] Failed to initialize map", error);
      this._mapInitFailed = true;
      return false;
    }
  }

  _rangeStart() {
    const rangeStartDate = new Date();
    switch (this.selectedRange) {
      case "1h":
        rangeStartDate.setHours(rangeStartDate.getHours() - 1);
        break;
      case "1d":
        rangeStartDate.setDate(rangeStartDate.getDate() - 1);
        break;
      case "1w":
        rangeStartDate.setDate(rangeStartDate.getDate() - 7);
        break;
      case "1m":
        rangeStartDate.setMonth(rangeStartDate.getMonth() - 1);
        break;
      case "1y":
        rangeStartDate.setFullYear(rangeStartDate.getFullYear() - 1);
        break;
      default:
        break;
    }
    return rangeStartDate.toISOString();
  }

  async _load() {
    if (!this._hass) return;
    const leafletReady = await this._waitForLeaflet();
    if (!leafletReady || !this._initMap()) {
      this._showStatus("Map unavailable: Leaflet failed to load.");
      this._mapInitFailed = true;
      console.error("[zeitachse-panel] Leaflet unavailable; map rendering disabled");
      return;
    }
    try {
      const result = await this._hass.callWS({ type: "zeitachse/list_people" });
      this.people = (result.people || []).map((p) => ({
        ...p,
        color: sanitizeColor(p.color),
      }));
      this.staySettings = this._normalizeStaySettings(result.stay_settings);
      this.mapSettings = result.map_settings || {};
      if (this._tileController) {
        this._tileController.setProvider(
          this.mapSettings.tile_provider || "local_osm",
          this.mapSettings.tile_url || null,
          this.mapSettings.tile_token || null
        );
      }
      console.debug(`[zeitachse-panel] Loaded ${this.people.length} people`);
      await this._loadTimelines();
      this._renderControls();
      this._refreshStaysAndPoi();
      this._showStatus(this.people.length ? "Aktive Zeitachse" : "Keine Personen gefunden");
    } catch (error) {
      console.error("[zeitachse-panel] Failed to load people/timeline data", error);
      this._showStatus(`Network error while loading timeline: ${error?.message || error}`);
    }
  }

  async _loadTimelines() {
    const active = this.people.filter((person) => person.active);
    const start = this._rangeStart();
    await Promise.all(
      active.map(async (person) => {
        const timeline = await this._hass.callWS({
          type: "zeitachse/get_timeline",
          entity_id: person.entity_id,
          start,
        });
        this.timelineByPerson.set(person.entity_id, timeline.timeline || []);
      })
    );
  }

  async _setRange(range) {
    this.selectedRange = range;
    this._showAllStays = false;
    this._selectedStayIndex = null;
    await this._loadTimelines();
    this._renderControls();
    this._refreshStaysAndPoi();
  }

  _normalizeStaySettings(settings) {
    const minSnapshots = Number(settings?.min_snapshots);
    const distanceMeters = Number(settings?.distance_meters);
    const normalizedMinSnapshots = Number.isFinite(minSnapshots)
      ? Math.round(Math.max(MIN_STAY_MIN_SNAPSHOTS, Math.min(MAX_STAY_MIN_SNAPSHOTS, minSnapshots)))
      : DEFAULT_STAY_MIN_SNAPSHOTS;
    const normalizedDistanceMeters = Number.isFinite(distanceMeters)
      ? Math.round(Math.max(MIN_STAY_DISTANCE_METERS, Math.min(MAX_STAY_DISTANCE_METERS, distanceMeters)))
      : DEFAULT_STAY_DISTANCE_METERS;
    return {
      min_snapshots: normalizedMinSnapshots,
      distance_meters: normalizedDistanceMeters,
    };
  }

  _getPersonSubtitle(person) {
    const timeline = this.timelineByPerson.get(person.entity_id) || [];
    const latestEntry = timeline.length > 0 ? timeline[timeline.length - 1] : null;
    const stateEntity = this._hass?.states?.[person.entity_id];
    const stateLabel = formatPersonState(
      person.state || stateEntity?.state || latestEntry?.state || "unknown"
    );
    const relTime = formatRelativeTime(
      latestEntry?.timestamp || person.last_changed || stateEntity?.last_changed
    );
    const parts = [stateLabel];
    if (relTime) parts.push(relTime);
    if (person.active && timeline.length > 0) {
      parts.push(`${timeline.length} Pkt.`);
    }
    return parts.join(" · ");
  }

  _renderControls() {
    const controls = this.shadowRoot.getElementById("controls");
    if (!controls) return;
    controls.innerHTML = "";

    const rangeRow = document.createElement("div");
    rangeRow.className = "range-row";
    for (const range of RANGE_OPTIONS) {
      const button = document.createElement("button");
      button.className = `range-btn ${this.selectedRange === range ? "active" : ""}`;
      button.type = "button";
      button.textContent = RANGE_LABELS[range] || range;
      button.addEventListener("click", async () => {
        if (this.selectedRange === range) return;
        try {
          await this._setRange(range);
        } catch (error) {
          console.error("[zeitachse-panel] Failed to update range", error);
          this._showStatus(`Network error while updating range: ${error?.message || error}`);
        }
      });
      rangeRow.appendChild(button);
    }
    controls.appendChild(rangeRow);

    const pointCount = this.people
      .filter((it) => it.active)
      .reduce((sum, person) => sum + (this.timelineByPerson.get(person.entity_id)?.length || 0), 0);

    const headerRow = document.createElement("div");
    headerRow.className = "controls-header-row";
    const sectionLabel = document.createElement("span");
    sectionLabel.className = "controls-section-label";
    sectionLabel.textContent = "Personen";
    const summary = document.createElement("div");
    summary.className = "summary";
    summary.textContent = `${this.people.filter((it) => it.active).length} aktiv · ${pointCount} Punkte`;
    headerRow.appendChild(sectionLabel);
    headerRow.appendChild(summary);
    controls.appendChild(headerRow);

    for (const person of this.people) {
      const safeColor = sanitizeColor(person.color);
      person.color = safeColor;
      const initials = escapeHtml(getInitials(person.name));
      const subtitle = escapeHtml(this._getPersonSubtitle(person));

      const row = document.createElement("div");
      row.className = "person";
      row.innerHTML = `
        <div class="person-avatar" title="Auf ${escapeHtml(person.name)} zentrieren">
          <span>${initials}</span>
          <span class="dot" style="background:${safeColor};"></span>
        </div>
        <div class="person-info" title="Auf ${escapeHtml(person.name)} zentrieren">
          <span class="person-name">${escapeHtml(person.name)}</span>
          <span class="person-subtitle">${subtitle}</span>
        </div>
        <div class="person-actions">
          <input class="color-picker" type="color" value="${safeColor}" aria-label="Farbe für ${escapeHtml(person.name)}">
          <input class="person-active" type="checkbox" ${person.active ? "checked" : ""} aria-label="${escapeHtml(person.name)} aktivieren">
        </div>
      `;

      const focusPersonOnMap = () => {
        const timeline = this.timelineByPerson.get(person.entity_id) || [];
        if (timeline.length > 0 && this.map) {
          const lastPt = toPoint(timeline[timeline.length - 1]);
          if (lastPt) {
            const targetZoom = Math.max(this.map.getZoom ? this.map.getZoom() : 15, 15);
            if (typeof this.map.flyTo === "function") {
              this.map.flyTo(lastPt, targetZoom, { duration: 0.5 });
            } else if (typeof this.map.setView === "function") {
              this.map.setView(lastPt, targetZoom);
            }
          }
        }
      };

      row.querySelector(".person-avatar")?.addEventListener("click", focusPersonOnMap);
      row.querySelector(".person-info")?.addEventListener("click", focusPersonOnMap);

      row.querySelector(".person-active").addEventListener("change", async (event) => {
        const isActive = event.target.checked;
        person.active = isActive;
        try {
          await this._hass.callWS({
            type: "zeitachse/set_active_people",
            active_people: this.people.filter((it) => it.active).map((it) => it.entity_id),
          });
          if (person.active) {
            const timeline = await this._hass.callWS({
              type: "zeitachse/get_timeline",
              entity_id: person.entity_id,
              start: this._rangeStart(),
            });
            this.timelineByPerson.set(person.entity_id, timeline.timeline || []);
          }
        } catch (error) {
          person.active = !isActive;
          event.target.checked = person.active;
          console.error("[zeitachse-panel] Failed to update active people", error);
          this._showStatus(`Network error while updating active people: ${error?.message || error}`);
        }
        this._renderControls();
        this._refreshStaysAndPoi();
      });

      row.querySelector(".color-picker").addEventListener("change", async (event) => {
        const previousColor = person.color;
        const nextColor = sanitizeColor(event.target.value, previousColor);
        const dot = row.querySelector(".dot");
        person.color = nextColor;
        try {
          await this._hass.callWS({
            type: "zeitachse/set_person_colors",
            person_colors: Object.fromEntries(
              this.people.map((entry) => [entry.entity_id, sanitizeColor(entry.color)])
            ),
          });
          if (dot) {
            dot.style.background = person.color;
          }
        } catch (error) {
          person.color = previousColor;
          event.target.value = previousColor;
          if (dot) {
            dot.style.background = previousColor;
          }
          console.error("[zeitachse-panel] Failed to update person colors", error);
          this._showStatus(`Network error while updating person colors: ${error?.message || error}`);
        }
        this._renderMap();
        this._renderStayList();
      });
      controls.appendChild(row);
    }
  }

  _buildStayPopupHtml(cluster, poi) {
    const poiLabel = poi?.name ? escapeHtml(poi.name) : "Aufenthalt";
    const detailsLink = poi?.url
      ? `<br><a href="${escapeHtml(poi.url)}" target="_blank" rel="noopener noreferrer">Auf OpenStreetMap öffnen ↗</a>`
      : "";
    const visitCountText =
      cluster.stays.length > 1
        ? `${cluster.stays.length} Aufenthalte · Gesamtdauer ${this._formatDuration(cluster.totalDurationMs)}`
        : `1 Aufenthalt · Dauer ${this._formatDuration(cluster.totalDurationMs)}`;
    const peopleList =
      Array.isArray(cluster.people) && cluster.people.length > 0
        ? cluster.people.map((p) => escapeHtml(p.name)).join(", ")
        : escapeHtml(cluster.person?.name || "");
    return `<strong>${poiLabel}</strong><br>${visitCountText}<br>Person: ${peopleList}${detailsLink}`;
  }

  _renderMap() {
    if (this._mapInitFailed) {
      this._showStatus("Map unavailable: Leaflet failed to load.");
      return;
    }
    if (!this.map || !window.L) {
      console.debug("[zeitachse-panel] Skipping map render because map is not ready");
      return;
    }

    for (const layer of this.layers) {
      this.map.removeLayer(layer);
    }
    this.layers = [];
    this.stayMarkers = [];
    this._lastZoom = null;

    const tolerance = RANGE_TOLERANCE_METERS[this.selectedRange] || 4;
    const maxPoints = RANGE_MAX_TRACK_POINTS[this.selectedRange] || 2200;
    const sharedRenderer = getSharedCanvasRenderer(this.map);
    let hasData = false;

    for (const person of this.people.filter((it) => it.active)) {
      const timeline = this.timelineByPerson.get(person.entity_id) || [];
      const points = [];
      for (let i = 0; i < timeline.length; i += 1) {
        const pt = toPoint(timeline[i]);
        if (pt !== null) points.push(pt);
      }

      if (points.length === 0) continue;
      hasData = true;

      const trackLayers = renderTimelineTrack(this.map, points, person, {
        tolerance,
        maxPoints,
      });
      this.layers.push(...trackLayers);
    }

    // Render stay clusters ordered from shortest to longest so longest stays draw on top
    const orderedClusters = [...this.stayClusters].sort(
      (a, b) => (a.totalDurationMs || 0) - (b.totalDurationMs || 0)
    );

    for (const cluster of orderedClusters) {
      hasData = true;
      const key = pointKey(cluster.point);
      const poi = this.poiByPoint.get(key) || null;
      const radius = Math.min(13, 6 + Math.log2(cluster.stays.length + 1) * 2);
      const strokeColor =
        Array.isArray(cluster.people) && cluster.people.length === 1
          ? sanitizeColor(cluster.people[0].color, "#f57c00")
          : "#f57c00";

      const stayMarker = window.L.circleMarker(cluster.point, {
        radius,
        color: "#ffffff",
        fillColor: strokeColor,
        fillOpacity: 0.92,
        weight: 2,
        renderer: sharedRenderer,
      }).addTo(this.map);
      stayMarker._pointKey = key;
      stayMarker._clusterId = cluster.id;
      stayMarker._cluster = cluster;

      stayMarker.bindPopup(this._buildStayPopupHtml(cluster, poi));

      if (poi?.name) {
        stayMarker._labelText = poi.name;
        stayMarker.bindTooltip(escapeHtml(poi.name), {
          permanent: true,
          direction: "top",
          offset: [0, -8],
          className: "zeitachse-poi-label",
        });
      }

      this.layers.push(stayMarker);
      this.stayMarkers.push(stayMarker);
    }

    if (hasData && this.layers.length > 0) {
      const group = window.L.featureGroup(this.layers);
      const bounds = group.getBounds();
      if (bounds.isValid()) {
        this.map.fitBounds(bounds, { padding: [36, 36], maxZoom: 16 });
      }
    } else {
      this.map.setView(DEFAULT_MAP_CENTER, DEFAULT_MAP_ZOOM);
    }

    this._updateTooltipsVisibility();
    requestAnimationFrame(() => this.map?.invalidateSize(false));
  }

  _updateTooltipsVisibility() {
    if (!this.map) return;
    updateOverlapCulledTooltips(this.map, this.stayClusters, this.stayMarkers);
  }

  _collectStays() {
    const stays = [];
    const minSnapshots = this.staySettings?.min_snapshots ?? DEFAULT_STAY_MIN_SNAPSHOTS;
    const distanceMeters = this.staySettings?.distance_meters ?? DEFAULT_STAY_DISTANCE_METERS;

    for (const person of this.people.filter((it) => it.active)) {
      const rawTimeline = this.timelineByPerson.get(person.entity_id) || [];
      if (rawTimeline.length < 2) continue;

      // Single-pass timestamp parsing and out-of-order check to avoid millions of Date allocations
      const parsed = [];
      let isSorted = true;
      let prevMs = -Infinity;
      for (let i = 0; i < rawTimeline.length; i += 1) {
        const entry = rawTimeline[i];
        const point = toPoint(entry);
        if (!point) continue;
        const tsMs = toTimestampMs(entry);
        if (Number.isNaN(tsMs)) continue;
        if (tsMs < prevMs) {
          isSorted = false;
        }
        prevMs = tsMs;
        parsed.push({ point, tsMs });
      }

      if (parsed.length < 2) continue;
      if (!isSorted) {
        parsed.sort((a, b) => a.tsMs - b.tsMs);
      }

      let current = null;
      for (let i = 0; i < parsed.length; i += 1) {
        const { point, tsMs } = parsed[i];
        if (!current) {
          current = { person, point, startMs: tsMs, endMs: tsMs, samples: 1 };
          continue;
        }

        if (haversineMeters(current.point, point) <= distanceMeters) {
          current.endMs = tsMs;
          current.samples += 1;
          continue;
        }

        const durationMs = current.endMs - current.startMs;
        if (current.samples >= minSnapshots) {
          stays.push({
            person: current.person,
            point: current.point,
            start: new Date(current.startMs),
            end: new Date(current.endMs),
            samples: current.samples,
            durationMs,
          });
        }
        current = { person, point, startMs: tsMs, endMs: tsMs, samples: 1 };
      }

      if (current) {
        const durationMs = current.endMs - current.startMs;
        if (current.samples >= minSnapshots) {
          stays.push({
            person: current.person,
            point: current.point,
            start: new Date(current.startMs),
            end: new Date(current.endMs),
            samples: current.samples,
            durationMs,
          });
        }
      }
    }

    return stays.sort((a, b) => b.start.getTime() - a.start.getTime());
  }

  _formatDuration(durationMs) {
    const totalMinutes = Math.round(durationMs / 60000);
    if (totalMinutes < 60) return `${totalMinutes} min`;
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return minutes ? `${hours}h ${minutes}min` : `${hours}h`;
  }

  _refreshStaysAndPoi() {
    const rawStays = this._collectStays();
    this.stays = rawStays;
    const distanceMeters = this.staySettings?.distance_meters ?? DEFAULT_STAY_DISTANCE_METERS;
    this.stayClusters = clusterStays(rawStays, distanceMeters);
    this._renderMap();
    this._renderStayList();
    this._loadPoiForClusters(this.stayClusters);
  }

  async _loadPoiForClusters(clusters) {
    const version = ++this._poiLookupVersion;
    const missing = [];
    const seenKeys = new Set();
    // Prioritize longest stay clusters first so the most important POI names load first
    const prioritized = [...clusters].sort(
      (a, b) => (b.totalDurationMs || 0) - (a.totalDurationMs || 0)
    );
    for (const cluster of prioritized) {
      const key = pointKey(cluster.point);
      if (!key || this.poiByPoint.has(key) || seenKeys.has(key)) continue;
      seenKeys.add(key);
      missing.push([key, cluster.point]);
    }
    if (missing.length === 0) return;

    for (let i = 0; i < missing.length; i += 1) {
      if (version !== this._poiLookupVersion) return;
      const [key, point] = missing[i];
      try {
        const [latitude, longitude] = point;
        const result = await this._hass.callWS({
          type: "zeitachse/get_poi",
          latitude,
          longitude,
        });
        if (version !== this._poiLookupVersion) return;
        const poi = result?.poi || null;
        this.poiByPoint.set(key, poi);
        this._updateStayMarker(key, poi);
        this._updateStayListDomForKey(key, poi);
      } catch (error) {
        if (version !== this._poiLookupVersion) return;
        this.poiByPoint.set(key, null);
        console.debug("[zeitachse-panel] POI lookup failed", error);
      }
    }
  }

  _updateStayMarker(key, poi) {
    if (!poi?.name) return;
    for (const marker of this.stayMarkers) {
      if (marker._pointKey === key) {
        marker._labelText = poi.name;
        marker._labelWidth = null;
        marker._labelHeight = null;
        if (marker._cluster) {
          marker.setPopupContent(this._buildStayPopupHtml(marker._cluster, poi));
        }
        if (!marker.getTooltip()) {
          marker.bindTooltip(escapeHtml(poi.name), {
            permanent: true,
            direction: "top",
            offset: [0, -8],
            className: "zeitachse-poi-label",
          });
        } else {
          marker.setTooltipContent(escapeHtml(poi.name));
        }
      }
    }
    this._updateTooltipsVisibility();
  }

  _updateStayListDomForKey(key, poi) {
    if (!poi?.name) return;
    const container = this.shadowRoot.getElementById("stay-list");
    if (!container) return;
    const matchingItems = container.querySelectorAll(`.stay-item[data-point-key="${key}"]`);
    if (matchingItems.length === 0) {
      this._renderStayList();
      return;
    }
    for (const item of matchingItems) {
      const nameSpan = item.querySelector(".stay-poi-name");
      if (nameSpan) {
        nameSpan.textContent = poi.name;
      }
      const osmSlot = item.querySelector(".stay-osm-slot");
      if (osmSlot && poi.url) {
        osmSlot.innerHTML = ` · <a class="stay-osm-link" href="${escapeHtml(poi.url)}" target="_blank" rel="noopener noreferrer" style="color:var(--zeitachse-accent);">OSM</a>`;
        osmSlot.querySelector(".stay-osm-link")?.addEventListener("click", (e) => {
          e.stopPropagation();
        });
      }
    }
  }

  _focusStayOnMap(stay, itemElement) {
    if (!stay || !this.map) return;
    const targetPoint = stay.canonicalPoint || stay.point;
    if (!targetPoint) return;

    const container = this.shadowRoot.getElementById("stay-list");
    if (container) {
      for (const el of container.querySelectorAll(".stay-item.selected")) {
        el.classList.remove("selected");
      }
    }
    if (itemElement) {
      itemElement.classList.add("selected");
    }

    const currentZoom = typeof this.map.getZoom === "function" ? this.map.getZoom() : 14;
    const targetZoom = Math.max(currentZoom, 16);

    const openTargetMarkerPopup = () => {
      const key = pointKey(targetPoint);
      for (const marker of this.stayMarkers) {
        if (marker._clusterId === stay.clusterId || marker._pointKey === key) {
          const tooltipEl = marker.getTooltip?.()?.getElement?.();
          if (tooltipEl) {
            tooltipEl.style.display = "block";
          }
          marker.openPopup?.();
          break;
        }
      }
    };

    if (typeof this.map.flyTo === "function") {
      this.map.once?.("moveend", openTargetMarkerPopup);
      this.map.flyTo(targetPoint, targetZoom, { duration: 0.6 });
    } else if (typeof this.map.setView === "function") {
      this.map.setView(targetPoint, targetZoom);
      openTargetMarkerPopup();
    }
  }

  _renderStayList() {
    const container = this.shadowRoot.getElementById("stay-list");
    if (!container) return;

    const stays = this.stays;
    if (!stays.length) {
      container.innerHTML = `
        <div class="stay-header-row">
          <div class="stay-header-title">Aufenthalte · ${RANGE_LABELS[this.selectedRange]}</div>
        </div>
        <div class="stay-empty">Keine längeren Aufenthalte im ausgewählten Zeitraum gefunden.</div>
      `;
      return;
    }

    const timeFormatter = new Intl.DateTimeFormat("de-DE", {
      hour: "2-digit",
      minute: "2-digit",
    });

    const visibleStays =
      this._showAllStays || stays.length <= INITIAL_STAY_RENDER_LIMIT
        ? stays
        : stays.slice(0, INITIAL_STAY_RENDER_LIMIT);

    const groups = groupStaysByPeriod(visibleStays, this.selectedRange);
    let globalStayIdx = 0;

    const sectionsHtml = groups
      .map((group) => {
        const itemsHtml = group.stays
          .map((stay) => {
            const stayIndex = globalStayIdx++;
            const key = pointKey(stay.canonicalPoint || stay.point);
            const poi = this.poiByPoint.get(key) || null;
            const poiName = poi?.name ? escapeHtml(poi.name) : "Aufenthaltsort";
            const safeColor = sanitizeColor(stay.person?.color);
            const poiLink = poi?.url
              ? ` · <a class="stay-osm-link" href="${escapeHtml(poi.url)}" target="_blank" rel="noopener noreferrer" style="color:var(--zeitachse-accent);">OSM</a>`
              : "";

            return `
              <div class="stay-item" role="button" tabindex="0" data-stay-index="${stayIndex}" data-point-key="${escapeHtml(key)}">
                <div class="stay-item-header">
                  <div class="stay-item-title">
                    <span class="dot stay-person-dot" style="background:${safeColor}; position:static; border:none;"></span>
                    <span class="stay-poi-name">${poiName}</span>
                    <span class="stay-person-tag">· ${escapeHtml(stay.person.name)}<span class="stay-osm-slot">${poiLink}</span></span>
                  </div>
                  <div class="stay-item-right">
                    <span class="stay-locate-badge">📍 Karte</span>
                    <span class="stay-duration-tag">${this._formatDuration(stay.durationMs)}</span>
                  </div>
                </div>
                <div class="stay-meta">
                  ${timeFormatter.format(stay.start)} → ${timeFormatter.format(stay.end)} · ${stay.samples} Snapshots
                </div>
              </div>
            `;
          })
          .join("");

        return `
          <div class="stay-section">
            <div class="stay-section-header">
              <span>📅 ${escapeHtml(group.title)}</span>
              <span class="stay-section-badge">${group.stays.length} Aufenthalte · ${this._formatDuration(group.totalDurationMs)}</span>
            </div>
            ${itemsHtml}
          </div>
        `;
      })
      .join("");

    const loadMoreHtml =
      !this._showAllStays && stays.length > INITIAL_STAY_RENDER_LIMIT
        ? `<button type="button" class="stay-load-more" id="stay-load-more">Alle ${stays.length} Aufenthalte anzeigen</button>`
        : "";

    container.innerHTML = `
      <div class="stay-header-row">
        <div class="stay-header-title">Aufenthalte · ${RANGE_LABELS[this.selectedRange]} · ${stays.length} Besuche gesamt</div>
        <div class="stay-header-hint">Klicke auf einen Eintrag, um zur Position zu springen</div>
      </div>
      ${sectionsHtml}
      ${loadMoreHtml}
    `;

    for (const osmLink of container.querySelectorAll(".stay-osm-link")) {
      osmLink.addEventListener("click", (event) => {
        event.stopPropagation();
      });
    }

    for (const itemEl of container.querySelectorAll(".stay-item")) {
      const idx = Number(itemEl.getAttribute("data-stay-index"));
      const stay = visibleStays[idx];
      if (!stay) continue;
      itemEl.addEventListener("click", () => {
        this._focusStayOnMap(stay, itemEl);
      });
      itemEl.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          this._focusStayOnMap(stay, itemEl);
        }
      });
    }

    container.querySelector("#stay-load-more")?.addEventListener("click", () => {
      this._showAllStays = true;
      this._renderStayList();
    });
  }

  static get properties() {
    return { hass: {} };
  }
}

customElements.define("zeitachse-panel", ZeitachsePanel);
