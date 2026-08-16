import { LEAFLET_SHADOW_CSS } from "./leaflet-shadow-css.js";
import { clusterStays, ensureLeafletLoaded, haversineMeters, pointKey, simplifyPoints, toPoint, toTimestamp } from "./map-utils.js";

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
  "1d": 3,
  "1w": 6,
  "1m": 12,
  "1y": 25,
};
const DEFAULT_STAY_DISTANCE_METERS = 75;
const DEFAULT_STAY_MIN_SNAPSHOTS = 6;
const MIN_STAY_DISTANCE_METERS = 5;
const MAX_STAY_DISTANCE_METERS = 2000;
const MIN_STAY_MIN_SNAPSHOTS = 2;
const MAX_STAY_MIN_SNAPSHOTS = 500;

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
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
    if (!this._loaded && this._hass) {
      this._loaded = true;
      this._load().catch((error) => {
        console.error("[zeitachse-panel] Loading failed", error);
        this._showStatus(`Loading failed: ${error?.message || error}`);
      });
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
        }
        .panel-root {
          display: flex;
          flex-direction: column;
          height: 100%;
          width: 100%;
          overflow: hidden;
          box-sizing: border-box;
          padding: 8px;
          gap: 8px;
          background: var(--primary-background-color, #111111);
        }
        .status {
          color: var(--secondary-text-color, #999999);
          font-size: 0.85rem;
          padding: 2px 6px;
          flex-shrink: 0;
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
          flex: 6 1 0%;
          min-height: 0;
          border-radius: 12px;
          overflow: hidden;
          border: 1px solid var(--divider-color, rgba(255,255,255,0.1));
          box-shadow: 0 4px 12px rgba(0,0,0,0.25);
          transition: flex 0.25s cubic-bezier(0.4, 0, 0.2, 1);
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
        .controls {
          position: absolute;
          top: 10px;
          left: 10px;
          z-index: 1000;
          width: min(300px, calc(100% - 20px));
          max-height: calc(100% - 20px);
          overflow-y: auto;
          border: 1px solid var(--divider-color, rgba(255,255,255,0.2));
          border-radius: 12px;
          padding: 10px;
          box-sizing: border-box;
          backdrop-filter: blur(12px);
          -webkit-backdrop-filter: blur(12px);
          background: color-mix(in srgb, var(--card-background-color, #1f1f1f) 82%, transparent);
          box-shadow: 0 4px 20px rgba(0, 0, 0, 0.35);
        }
        .fullscreen-fab {
          position: absolute;
          bottom: 20px;
          right: 20px;
          z-index: 1000;
          width: 42px;
          height: 42px;
          border-radius: 8px;
          background: var(--card-background-color, #1e1e1e);
          color: var(--primary-text-color, #ffffff);
          border: 1px solid var(--divider-color, rgba(255,255,255,0.25));
          box-shadow: 0 4px 16px rgba(0,0,0,0.5);
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          backdrop-filter: blur(10px);
          -webkit-backdrop-filter: blur(10px);
          transition: transform 0.15s ease, background-color 0.2s ease, border-color 0.2s ease;
        }
        .fullscreen-fab:hover {
          background: color-mix(in srgb, var(--primary-color, #03a9f4) 25%, var(--card-background-color, #1e1e1e));
          border-color: var(--primary-color, #03a9f4);
          transform: scale(1.05);
        }
        .fullscreen-fab:active {
          transform: scale(0.95);
        }
        .range-row { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
        .range-btn { border: 1px solid var(--divider-color); background: transparent; color: inherit; border-radius: 14px; padding: 4px 10px; cursor: pointer; }
        .range-btn.active { border-color: var(--primary-color); color: var(--primary-color); font-weight: 600; }
        .person { display: flex; align-items: center; gap: 8px; margin: 6px 0; }
        .person-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
        .color-picker { width: 32px; height: 22px; border: none; padding: 0; background: transparent; cursor: pointer; }
        .summary { color: var(--secondary-text-color); font-size: 0.85rem; margin-top: 6px; }
        .stay-settings { margin-top: 10px; border-top: 1px solid var(--divider-color); padding-top: 8px; }
        .stay-settings-title { font-weight: 600; margin-bottom: 6px; font-size: 0.9rem; }
        .stay-setting { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin: 4px 0; font-size: 0.85rem; }
        .stay-setting input { width: 80px; }
        
        .stay-list-panel {
          flex: 4 1 0%;
          min-height: 0;
          border: 1px solid var(--divider-color, rgba(255,255,255,0.1));
          border-radius: 12px;
          padding: 12px;
          overflow-y: auto;
          box-sizing: border-box;
          background: var(--card-background-color, #1e1e1e);
          transition: flex 0.25s cubic-bezier(0.4, 0, 0.2, 1);
        }
        .stay-list-panel.hidden {
          display: none;
        }
        .stay-title { font-weight: 600; font-size: 1rem; margin-bottom: 10px; color: var(--primary-text-color, #ffffff); }
        .stay-item {
          border-top: 1px solid var(--divider-color, rgba(255,255,255,0.08));
          padding: 8px 0;
        }
        .stay-item:first-of-type {
          border-top: none;
          padding-top: 0;
        }
        .stay-item-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 8px;
        }
        .stay-item-title {
          font-weight: 600;
          font-size: 0.95rem;
          display: flex;
          align-items: center;
          gap: 6px;
          color: var(--primary-text-color, #ffffff);
        }
        .stay-person-tag {
          font-weight: normal;
          font-size: 0.85rem;
          color: var(--secondary-text-color, #aaaaaa);
        }
        .stay-duration-tag {
          background: var(--primary-color, #03a9f4);
          color: #ffffff;
          border-radius: 10px;
          padding: 2px 8px;
          font-size: 0.75rem;
          font-weight: 600;
          flex-shrink: 0;
        }
        .stay-meta {
          color: var(--secondary-text-color, #aaaaaa);
          font-size: 0.85rem;
          margin-top: 3px;
        }
        .stay-empty { color: var(--secondary-text-color); font-size: 0.9rem; }
        
        /* Tooltip styling within Shadow DOM */
        .leaflet-tooltip.zeitachse-poi-label {
          position: absolute !important;
          background: rgba(24, 24, 27, 0.88) !important;
          color: #ffffff !important;
          border: 1px solid rgba(255, 255, 255, 0.25) !important;
          border-radius: 6px !important;
          padding: 3px 8px !important;
          font-size: 11px !important;
          font-weight: 500 !important;
          white-space: nowrap !important;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.45) !important;
          pointer-events: none !important;
          backdrop-filter: blur(6px) !important;
          -webkit-backdrop-filter: blur(6px) !important;
        }
        .leaflet-tooltip-top:before {
          border-top-color: rgba(24, 24, 27, 0.88) !important;
        }
        ${LEAFLET_SHADOW_CSS}
      </style>
      <div class="panel-root">
        <div class="status" id="status">Zeitachse lädt…</div>
        <div class="main-split">
          <div class="map-wrapper" id="map-wrapper">
            <div id="map"></div>
            <div class="controls" id="controls"></div>
            <button class="fullscreen-fab" id="fullscreen-fab" type="button" title="Vollbild Karte umschalten" aria-label="Vollbild Karte umschalten">
              <svg id="icon-expand" viewBox="0 0 24 24" width="22" height="22">
                <path fill="currentColor" d="M5,5H10V7H7V10H5V5M14,5H19V10H17V7H14V5M17,14H19V19H14V17H17V14M10,17V19H5V14H7V17H10Z"/>
              </svg>
              <svg id="icon-shrink" viewBox="0 0 24 24" width="22" height="22" style="display:none;">
                <path fill="currentColor" d="M14,14H19V16H16V19H14V14M5,14H10V19H8V16H5V14M8,5H10V10H5V8H8V5M19,8V10H14V5H16V8H19Z"/>
              </svg>
            </button>
          </div>
          <div class="stay-list-panel" id="stay-list"></div>
        </div>
      </div>
    `;

    const fab = this.shadowRoot.getElementById("fullscreen-fab");
    const iconExpand = this.shadowRoot.getElementById("icon-expand");
    const iconShrink = this.shadowRoot.getElementById("icon-shrink");
    const mapWrapper = this.shadowRoot.getElementById("map-wrapper");
    const stayList = this.shadowRoot.getElementById("stay-list");

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
      setTimeout(() => this.map?.invalidateSize(true), 260);
    });
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
      }).setView(DEFAULT_MAP_CENTER, DEFAULT_MAP_ZOOM);
      window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "&copy; OpenStreetMap contributors",
      }).addTo(this.map);

      this.map.on("zoomend", () => {
        this._updateTooltipsVisibility();
      });

      requestAnimationFrame(() => this.map?.invalidateSize(true));
      this._resizeObserver = new ResizeObserver(() => this.map?.invalidateSize(true));
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
      this.people = result.people || [];
      this.staySettings = this._normalizeStaySettings(result.stay_settings);
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
        console.debug(
          `[zeitachse-panel] Loaded ${this.timelineByPerson.get(person.entity_id).length} snapshots for ${person.entity_id}`
        );
      })
    );
  }

  async _setRange(range) {
    this.selectedRange = range;
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

  _renderControls() {
    const controls = this.shadowRoot.getElementById("controls");
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
    const summary = document.createElement("div");
    summary.className = "summary";
    summary.textContent = `${this.people.filter((it) => it.active).length} aktiv · ${pointCount} Punkte`;
    controls.appendChild(summary);

    for (const person of this.people) {
      const row = document.createElement("div");
      row.className = "person";
      row.innerHTML = `
        <input class="person-active" type="checkbox" ${person.active ? "checked" : ""}>
        <span class="dot" style="background:${person.color}; margin-right:4px;"></span>
        <span class="person-name">${escapeHtml(person.name)}</span>
        <input class="color-picker" type="color" value="${person.color}" aria-label="Farbe für ${escapeHtml(person.name)}">
      `;
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
        const nextColor = event.target.value;
        const dot = row.querySelector(".dot");
        person.color = nextColor;
        try {
          await this._hass.callWS({
            type: "zeitachse/set_person_colors",
            person_colors: Object.fromEntries(this.people.map((entry) => [entry.entity_id, entry.color])),
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

    const tolerance = RANGE_TOLERANCE_METERS[this.selectedRange] || 3;
    let hasData = false;
    for (const person of this.people.filter((it) => it.active)) {
      const timeline = this.timelineByPerson.get(person.entity_id) || [];
      const points = timeline.map((entry) => toPoint(entry)).filter((entry) => entry !== null);

      if (points.length === 0) continue;
      hasData = true;

      const simplified = simplifyPoints(points, tolerance);
      const polyline = window.L.polyline(simplified, {
        color: person.color,
        weight: 4,
        renderer: window.L.canvas({ padding: 0.5 }),
      }).addTo(this.map);
      this.layers.push(polyline);

      const lastPoint = points[points.length - 1];
      const marker = window.L.circleMarker(lastPoint, {
        color: person.color,
        radius: 7,
        renderer: window.L.canvas({ padding: 0.5 }),
      }).addTo(this.map);
      marker.bindPopup(`<strong>${escapeHtml(person.name)}</strong><br>${points.length} Snapshots`);
      this.layers.push(marker);
    }

    for (const cluster of this.stayClusters) {
      hasData = true;
      const key = pointKey(cluster.point);
      const poi = this.poiByPoint.get(key) || null;
      const radius = Math.min(13, 6 + Math.log2(cluster.stays.length + 1) * 2);
      const stayMarker = window.L.circleMarker(cluster.point, {
        radius,
        color: "#f57c00",
        fillColor: "#ff9800",
        fillOpacity: 0.9,
        weight: 2,
        renderer: window.L.canvas({ padding: 0.5 }),
      }).addTo(this.map);
      stayMarker._pointKey = key;
      stayMarker._clusterId = cluster.id;
      
      const poiLabel = poi?.name ? escapeHtml(poi.name) : "Aufenthalt";
      const detailsLink = poi?.url
        ? `<br><a href="${escapeHtml(poi.url)}" target="_blank" rel="noopener noreferrer">Mehr Infos auf OSM</a>`
        : "";
      const visitCountText = cluster.stays.length > 1
        ? `${cluster.stays.length} Aufenthalte · Gesamtdauer ${this._formatDuration(cluster.totalDurationMs)}`
        : `1 Aufenthalt · Dauer ${this._formatDuration(cluster.totalDurationMs)}`;

      stayMarker.bindPopup(
        `<strong>${poiLabel}</strong><br>${visitCountText}<br>Person: ${escapeHtml(cluster.person.name)}${detailsLink}`
      );
      
      this.layers.push(stayMarker);
      this.stayMarkers.push(stayMarker);
    }

    if (hasData && this.layers.length > 0) {
      const group = window.L.featureGroup(this.layers);
      const bounds = group.getBounds();
      if (bounds.isValid()) {
        this.map.fitBounds(bounds, { padding: [30, 30], maxZoom: 16 });
      }
    } else {
      this.map.setView(DEFAULT_MAP_CENTER, DEFAULT_MAP_ZOOM);
    }

    this._updateTooltipsVisibility();
    this.map.invalidateSize(true);
  }

  _updateTooltipsVisibility() {
    if (!this.map) return;
    const currentZoom = this.map.getZoom();
    
    // Sort clusters by importance: totalDurationMs
    const sortedClusters = [...this.stayClusters].sort((a, b) => b.totalDurationMs - a.totalDurationMs);
    
    // Generous decluttering thresholds so labels appear early:
    // zoom < 7: top 15 places
    // zoom 7-10: top 30 places
    // zoom 11-12: top 60 places
    // zoom >= 13: all places
    let maxVisibleTooltips = sortedClusters.length;
    if (currentZoom < 7) {
      maxVisibleTooltips = 15;
    } else if (currentZoom < 11) {
      maxVisibleTooltips = 30;
    } else if (currentZoom < 13) {
      maxVisibleTooltips = 60;
    }

    const visibleClusterIds = new Set(
      sortedClusters.slice(0, maxVisibleTooltips).map((c) => c.id)
    );

    for (const marker of this.stayMarkers) {
      const poi = this.poiByPoint.get(marker._pointKey);
      const isVisible = visibleClusterIds.has(marker._clusterId);
      
      marker.unbindTooltip();
      if (poi?.name && isVisible) {
        marker.bindTooltip(escapeHtml(poi.name), {
          permanent: true,
          direction: "top",
          offset: [0, -8],
          className: "zeitachse-poi-label",
        });
      }
    }
  }

  _collectStays() {
    const stays = [];
    const minSnapshots = this.staySettings?.min_snapshots ?? DEFAULT_STAY_MIN_SNAPSHOTS;
    const distanceMeters = this.staySettings?.distance_meters ?? DEFAULT_STAY_DISTANCE_METERS;
    for (const person of this.people.filter((it) => it.active)) {
      const timeline = [...(this.timelineByPerson.get(person.entity_id) || [])].sort((first, second) => {
        const firstTs = toTimestamp(first);
        const secondTs = toTimestamp(second);
        return (firstTs?.getTime() || 0) - (secondTs?.getTime() || 0);
      });
      if (timeline.length < 2) continue;

      let current = null;
      for (const entry of timeline) {
        const point = toPoint(entry);
        const timestamp = toTimestamp(entry);
        if (!point || !timestamp) continue;

        if (!current) {
          current = { person, point, start: timestamp, end: timestamp, samples: 1 };
          continue;
        }

        if (haversineMeters(current.point, point) <= distanceMeters) {
          current.end = timestamp;
          current.samples += 1;
          continue;
        }

        const durationMs = current.end.getTime() - current.start.getTime();
        if (current.samples >= minSnapshots) {
          stays.push({ ...current, durationMs });
        }
        current = { person, point, start: timestamp, end: timestamp, samples: 1 };
      }

      if (current) {
        const durationMs = current.end.getTime() - current.start.getTime();
        if (current.samples >= minSnapshots) {
          stays.push({ ...current, durationMs });
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
    const missing = new Map();
    for (const cluster of clusters) {
      const key = pointKey(cluster.point);
      if (!key || this.poiByPoint.has(key) || missing.has(key)) continue;
      missing.set(key, cluster.point);
    }
    if (missing.size === 0) return;

    for (const [key, point] of missing.entries()) {
      if (version !== this._poiLookupVersion) return;
      try {
        const [latitude, longitude] = point;
        const result = await this._hass.callWS({
          type: "zeitachse/get_poi",
          latitude,
          longitude,
        });
        if (version !== this._poiLookupVersion) return;
        this.poiByPoint.set(key, result?.poi || null);
        this._renderStayList();
        this._updateStayMarker(key, result?.poi);
      } catch (error) {
        if (version !== this._poiLookupVersion) return;
        this.poiByPoint.set(key, null);
        console.debug("[zeitachse-panel] POI lookup failed", error);
      }
    }
  }

  _updateStayMarker(key, _poi) {
    this._updateTooltipsVisibility();
  }

  _renderStayList() {
    const container = this.shadowRoot.getElementById("stay-list");
    if (!container) return;

    const stays = this.stays;
    if (!stays.length) {
      container.innerHTML = `<div class="stay-title">Aufenthalte (${RANGE_LABELS[this.selectedRange]})</div><div class="stay-empty">Keine längeren Aufenthalte im ausgewählten Zeitraum gefunden.</div>`;
      return;
    }

    const formatter = new Intl.DateTimeFormat("de-DE", {
      dateStyle: "short",
      timeStyle: "short",
    });

    const content = stays
      .map((stay) => {
        const key = pointKey(stay.canonicalPoint || stay.point);
        const poi = this.poiByPoint.get(key) || null;
        const poiName = poi?.name ? escapeHtml(poi.name) : "Aufenthaltsort";
        const poiLink = poi?.url
          ? ` · <a href="${escapeHtml(poi.url)}" target="_blank" rel="noopener noreferrer" style="color:var(--primary-color);">OSM</a>`
          : "";

        return `
          <div class="stay-item">
            <div class="stay-item-header">
              <div class="stay-item-title">
                <span class="dot" style="background:${stay.person.color};"></span>
                <strong>${poiName}</strong>
                <span class="stay-person-tag">(${escapeHtml(stay.person.name)})${poiLink}</span>
              </div>
              <span class="stay-duration-tag">${this._formatDuration(stay.durationMs)}</span>
            </div>
            <div class="stay-meta">
              ${formatter.format(stay.start)} → ${formatter.format(stay.end)} · ${stay.samples} Snapshots
            </div>
          </div>
        `;
      })
      .join("");

    container.innerHTML = `<div class="stay-title">Aufenthalte (${RANGE_LABELS[this.selectedRange]} · ${stays.length} Besuche)</div>${content}`;
  }

  static get properties() {
    return { hass: {} };
  }
}

customElements.define("zeitachse-panel", ZeitachsePanel);
