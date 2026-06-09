import { LEAFLET_SHADOW_CSS } from "./leaflet-shadow-css.js";
import { haversineMeters, toPoint, toTimestamp } from "./map-utils.js";

const DEFAULT_MAP_CENTER = [51.1657, 10.4515];
const DEFAULT_MAP_ZOOM = 6;
const DEFAULT_TIMELINE_HEIGHT_ROWS = 2;
const LEAFLET_WAIT_MAX_ATTEMPTS = 10;
const LEAFLET_WAIT_DELAY_MS = 500;
const RANGE_OPTIONS = ["1h", "1d", "1w", "1m", "1y"];
const RANGE_LABELS = {
  "1h": "1h",
  "1d": "1d",
  "1w": "1w",
  "1m": "1m",
  "1y": "1j",
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

function pointKey(point) {
  if (!Array.isArray(point) || point.length !== 2) return "";
  const [lat, lon] = point;
  return `${Number(lat).toFixed(5)},${Number(lon).toFixed(5)}`;
}

function normalizeRange(value) {
  return RANGE_OPTIONS.includes(value) ? value : "1d";
}

function normalizeTimelineHeightRows(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_TIMELINE_HEIGHT_ROWS;
  return Math.max(1, Math.round(number));
}

function normalizeCenter(value) {
  if (Array.isArray(value) && value.length === 2) {
    const lat = Number(value[0]);
    const lon = Number(value[1]);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      return [lat, lon];
    }
  }
  return [...DEFAULT_MAP_CENTER];
}

function normalizeZoom(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_MAP_ZOOM;
  return Math.max(1, Math.min(22, Math.round(number)));
}

class ZeitachseBaseCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.people = [];
    this.timelineByPerson = new Map();
    this.stays = [];
    this.poiByPoint = new Map();
    this._poiLookupVersion = 0;
    this._loaded = false;
    this.selectedRange = "1d";
    this.staySettings = {
      min_snapshots: DEFAULT_STAY_MIN_SNAPSHOTS,
      distance_meters: DEFAULT_STAY_DISTANCE_METERS,
    };
  }

  set hass(hass) {
    this._hass = hass;
    if (!this.shadowRoot.innerHTML) {
      this._renderShell();
    }
    if (!this._loaded && this._hass) {
      this._loaded = true;
      this._load().catch((error) => {
        console.error("[zeitachse-card] Loading failed", error);
        this._showStatus(`Loading failed: ${error?.message || error}`);
      });
    }
  }

  setConfig(config) {
    this.config = config || {};
    this.selectedRange = normalizeRange(this.config.range);
  }

  _showStatus(message) {
    const status = this.shadowRoot.getElementById("status");
    if (status) {
      status.textContent = message;
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

  _resolvePeople(allPeople) {
    const selected = this.config.people;
    if (!Array.isArray(selected) || !selected.length) {
      return allPeople.filter((person) => person.active);
    }
    const selectedSet = new Set(selected);
    return allPeople.filter((person) => selectedSet.has(person.entity_id));
  }

  async _load() {
    if (!this._hass) return;
    const result = await this._hass.callWS({ type: "zeitachse/list_people" });
    this.staySettings = this._normalizeStaySettings(result.stay_settings);
    this.people = this._resolvePeople(result.people || []);
    await this._loadTimelines();
    await this._refreshStaysAndPoi();
    this._showStatus(this.people.length ? "Aktive Zeitachse" : "Keine passenden Personen gefunden");
  }

  async _loadTimelines() {
    this.timelineByPerson.clear();
    const start = this._rangeStart();
    await Promise.all(
      this.people.map(async (person) => {
        const timeline = await this._hass.callWS({
          type: "zeitachse/get_timeline",
          entity_id: person.entity_id,
          start,
        });
        this.timelineByPerson.set(person.entity_id, timeline.timeline || []);
      })
    );
  }

  _collectStays() {
    const stays = [];
    const minSnapshots = this.staySettings?.min_snapshots ?? DEFAULT_STAY_MIN_SNAPSHOTS;
    const distanceMeters = this.staySettings?.distance_meters ?? DEFAULT_STAY_DISTANCE_METERS;
    for (const person of this.people) {
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

  async _refreshStaysAndPoi() {
    const stays = this._collectStays();
    this.stays = stays;
    await this._loadPoiForStays(stays);
    this._renderData();
  }

  async _loadPoiForStays(stays) {
    const version = ++this._poiLookupVersion;
    const missing = new Map();
    for (const stay of stays) {
      const key = pointKey(stay.point);
      if (!key || this.poiByPoint.has(key) || missing.has(key)) continue;
      missing.set(key, stay.point);
    }
    await Promise.all(
      [...missing.entries()].map(async ([key, point]) => {
        try {
          const [latitude, longitude] = point;
          const result = await this._hass.callWS({
            type: "zeitachse/get_poi",
            latitude,
            longitude,
          });
          if (version !== this._poiLookupVersion) return;
          this.poiByPoint.set(key, result?.poi || null);
        } catch (_error) {
          if (version !== this._poiLookupVersion) return;
          this.poiByPoint.set(key, null);
          console.debug("[zeitachse-card] POI lookup failed", _error);
        }
      })
    );
  }

  _formatDuration(durationMs) {
    const totalMinutes = Math.round(durationMs / 60000);
    if (totalMinutes < 60) return `${totalMinutes} min`;
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return minutes ? `${hours}h ${minutes}min` : `${hours}h`;
  }
}

class ZeitachseMapCard extends ZeitachseBaseCard {
  constructor() {
    super();
    this.map = null;
    this.layers = [];
    this._mapInitFailed = false;
    this._defaultCenter = [...DEFAULT_MAP_CENTER];
    this._defaultZoom = DEFAULT_MAP_ZOOM;
    this._interactive = true;
  }

  static getConfigElement() {
    const editor = document.createElement("zeitachse-card-editor");
    editor.cardType = "map";
    return editor;
  }

  static getStubConfig() {
    return {
      type: "custom:zeitachse-map-card",
      range: "1d",
      interactive: true,
    };
  }

  disconnectedCallback() {
    this._resizeObserver?.disconnect();
    this._resizeObserver = null;
  }

  setConfig(config) {
    super.setConfig(config);
    this._defaultCenter = normalizeCenter(this.config.center);
    this._defaultZoom = normalizeZoom(this.config.zoom);
    this._interactive = this.config.interactive !== false;
  }

  getCardSize() {
    return 6;
  }

  _renderShell() {
    this.shadowRoot.innerHTML = `
      <style>
        ha-card { padding: 12px; }
        .status { margin-bottom: 10px; color: var(--secondary-text-color); }
        #map { height: 420px; border-radius: 8px; }
        .legend {
          margin-top: 10px;
          border: 1px solid var(--divider-color);
          border-radius: 8px;
          padding: 8px;
        }
        .legend-title { font-weight: 600; margin-bottom: 6px; }
        .legend-item { display: flex; align-items: center; gap: 8px; margin: 4px 0; }
        .dot { width: 12px; height: 12px; border-radius: 50%; }
        ${LEAFLET_SHADOW_CSS}
      </style>
      <ha-card>
        <div class="status" id="status">Zeitachse lädt…</div>
        <div id="map"></div>
        <div class="legend" id="legend"></div>
      </ha-card>
    `;
  }

  async _waitForLeaflet() {
    for (let attempt = 1; attempt <= LEAFLET_WAIT_MAX_ATTEMPTS; attempt += 1) {
      if (window.L) return true;
      await new Promise((resolve) => {
        window.setTimeout(resolve, LEAFLET_WAIT_DELAY_MS);
      });
    }
    return false;
  }

  _initMap() {
    if (!window.L || this.map) return false;
    const mapElement = this.shadowRoot.getElementById("map");
    if (!mapElement) return false;
    try {
      this.map = window.L.map(mapElement, {
        dragging: this._interactive,
        scrollWheelZoom: this._interactive,
        doubleClickZoom: this._interactive,
        boxZoom: this._interactive,
        keyboard: this._interactive,
        touchZoom: this._interactive,
        zoomControl: this._interactive,
      }).setView(this._defaultCenter, this._defaultZoom);
      window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "&copy; OpenStreetMap contributors",
      }).addTo(this.map);
      requestAnimationFrame(() => this.map?.invalidateSize(true));
      this._resizeObserver = new ResizeObserver(() => this.map?.invalidateSize(true));
      this._resizeObserver.observe(mapElement);
      this._mapInitFailed = false;
      return true;
    } catch (_error) {
      console.error("[zeitachse-map-card] Failed to initialize map", _error);
      this._mapInitFailed = true;
      return false;
    }
  }

  async _load() {
    const leafletReady = await this._waitForLeaflet();
    if (!leafletReady || !this._initMap()) {
      this._showStatus("Map unavailable: Leaflet failed to load.");
      this._mapInitFailed = true;
      return;
    }
    await super._load();
  }

  _renderData() {
    this._renderMap();
    this._renderLegend();
  }

  _renderLegend() {
    const legend = this.shadowRoot.getElementById("legend");
    if (!legend) return;
    if (!this.people.length) {
      legend.innerHTML = '<div class="legend-title">Legende</div><div>Keine Personen ausgewählt</div>';
      return;
    }
    legend.innerHTML = `
      <div class="legend-title">Legende</div>
      ${this.people
        .map(
          (person) =>
            `<div class="legend-item"><span class="dot" style="background:${person.color}"></span><span>${escapeHtml(person.name)}</span></div>`
        )
        .join("")}
    `;
  }

  _renderMap() {
    if (this._mapInitFailed) {
      this._showStatus("Map unavailable: Leaflet failed to load.");
      return;
    }
    if (!this.map || !window.L) return;

    for (const layer of this.layers) {
      this.map.removeLayer(layer);
    }
    this.layers = [];

    let hasData = false;
    for (const person of this.people) {
      const timeline = this.timelineByPerson.get(person.entity_id) || [];
      const points = timeline.map((entry) => toPoint(entry)).filter((entry) => entry !== null);
      if (!points.length) continue;

      hasData = true;
      const polyline = window.L.polyline(points, { color: person.color, weight: 4 }).addTo(this.map);
      this.layers.push(polyline);
      const lastPoint = points[points.length - 1];
      const marker = window.L.circleMarker(lastPoint, { color: person.color, radius: 7 }).addTo(this.map);
      marker.bindPopup(`${person.name} (${points.length} Punkte)`);
      this.layers.push(marker);
    }

    for (const stay of this.stays) {
      const poi = this.poiByPoint.get(pointKey(stay.point)) || null;
      const stayMarker = window.L.circleMarker(stay.point, {
        radius: 8,
        color: "#f57c00",
        fillColor: "#ff9800",
        fillOpacity: 0.9,
        weight: 2,
      }).addTo(this.map);
      const poiLabel = poi?.name ? escapeHtml(poi.name) : "Namenloser Pin";
      const poiLink = poi?.url
        ? `<br><a href="${escapeHtml(poi.url)}" target="_blank" rel="noopener noreferrer">Mehr Infos</a>`
        : "";
      stayMarker.bindPopup(
        `<strong>${escapeHtml(stay.person.name)}</strong><br>${poiLabel}<br>${this._formatDuration(stay.durationMs)}${poiLink}`
      );
      if (poi?.name) {
        stayMarker.bindTooltip(escapeHtml(poi.name), {
          permanent: true,
          direction: "top",
          offset: [0, -8],
          className: "zeitachse-poi-label",
        });
      }
      this.layers.push(stayMarker);
    }

    if (!hasData) {
      this.map.setView(this._defaultCenter, this._defaultZoom);
    } else if (!this._interactive) {
      this.map.setView(this._defaultCenter, this._defaultZoom);
    } else {
      const group = window.L.featureGroup(this.layers);
      const bounds = group.getBounds();
      if (bounds.isValid()) {
        this.map.fitBounds(bounds, { padding: [20, 20] });
      }
    }
    this.map.invalidateSize(true);
  }
}

class ZeitachseTimelineCard extends ZeitachseBaseCard {
  constructor() {
    super();
    this.selectedPersonEntityId = null;
    this.timelineHeightRows = DEFAULT_TIMELINE_HEIGHT_ROWS;
  }

  static getConfigElement() {
    const editor = document.createElement("zeitachse-card-editor");
    editor.cardType = "timeline";
    return editor;
  }

  static getStubConfig() {
    return {
      type: "custom:zeitachse-timeline-card",
      range: "1d",
      height_rows: DEFAULT_TIMELINE_HEIGHT_ROWS,
    };
  }

  setConfig(config) {
    super.setConfig(config);
    this.selectedPersonEntityId = this.config.person || null;
    this.timelineHeightRows = normalizeTimelineHeightRows(this.config.height_rows);
  }

  getCardSize() {
    return this.timelineHeightRows;
  }

  _resolvePeople(allPeople) {
    const selectedPerson = this.selectedPersonEntityId;
    if (!selectedPerson) {
      return [];
    }
    return allPeople.filter((person) => person.entity_id === selectedPerson);
  }

  _renderShell() {
    const heightPx = this.timelineHeightRows * 56;
    this.shadowRoot.innerHTML = `
      <style>
        ha-card { padding: 12px; }
        .status { margin-bottom: 10px; color: var(--secondary-text-color); }
        .stay-list {
          height: ${heightPx}px;
          min-height: ${heightPx}px;
          max-height: ${heightPx}px;
          border: 1px solid var(--divider-color);
          border-radius: 8px;
          padding: 10px;
          overflow: auto;
        }
        .stay-title { font-weight: 600; margin-bottom: 8px; }
        .stay-item { border-top: 1px solid var(--divider-color); padding: 8px 0; }
        .stay-item:first-of-type { border-top: none; padding-top: 0; }
        .stay-empty { color: var(--secondary-text-color); }
        .stay-meta { color: var(--secondary-text-color); font-size: 0.9rem; }
        .dot { width: 12px; height: 12px; border-radius: 50%; display:inline-block; margin-right:8px; }
      </style>
      <ha-card>
        <div class="status" id="status">Zeitachse lädt…</div>
        <div class="stay-list" id="stay-list"></div>
      </ha-card>
    `;
  }

  _renderData() {
    this._renderStayList();
  }

  _renderStayList() {
    const container = this.shadowRoot.getElementById("stay-list");
    if (!container) return;

    if (!this.selectedPersonEntityId) {
      container.innerHTML = '<div class="stay-empty">Bitte in den Karten-Einstellungen eine Person auswählen.</div>';
      return;
    }

    const person = this.people[0];
    if (!person) {
      container.innerHTML = '<div class="stay-empty">Die ausgewählte Person ist nicht verfügbar oder nicht getrackt.</div>';
      return;
    }

    const stays = this.stays;
    if (!stays.length) {
      container.innerHTML = `<div class="stay-title">${escapeHtml(person.name)} · Aufenthalte (${RANGE_LABELS[this.selectedRange]})</div><div class="stay-empty">Keine längeren Aufenthalte im ausgewählten Zeitraum gefunden.</div>`;
      return;
    }

    const formatter = new Intl.DateTimeFormat("de-DE", {
      dateStyle: "short",
      timeStyle: "short",
    });
    const content = stays
      .map((stay) => {
        const poi = this.poiByPoint.get(pointKey(stay.point)) || null;
        const poiName = poi?.name ? escapeHtml(poi.name) : "Namenloser Pin";
        const poiLink = poi?.url
          ? ` · <a href="${escapeHtml(poi.url)}" target="_blank" rel="noopener noreferrer">Mehr Infos</a>`
          : "";
        return `
          <div class="stay-item">
            <div><span class="dot" style="background:${stay.person.color}"></span><strong>${escapeHtml(stay.person.name)}</strong></div>
            <div class="stay-meta">${formatter.format(stay.start)} → ${formatter.format(stay.end)} · ${this._formatDuration(stay.durationMs)}</div>
            <div class="stay-meta">POI: ${poiName}${poiLink} · ${stay.samples} Snapshots</div>
          </div>
        `;
      })
      .join("");
    container.innerHTML = `<div class="stay-title">${escapeHtml(person.name)} · Aufenthalte (${RANGE_LABELS[this.selectedRange]})</div>${content}`;
  }
}

class ZeitachseCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = config || {};
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  _fireConfigChanged(config) {
    this.dispatchEvent(
      new CustomEvent("config-changed", {
        bubbles: true,
        composed: true,
        detail: { config },
      })
    );
  }

  _personOptions() {
    const states = this._hass?.states || {};
    const locale = this._hass?.locale?.language || navigator.language || "en-US";
    return Object.values(states)
      .filter((state) => state.entity_id?.startsWith("person."))
      .map((state) => ({ entity_id: state.entity_id, name: state.attributes?.friendly_name || state.entity_id }))
      .sort((a, b) => a.name.localeCompare(b.name, locale));
  }

  _renderTimelineEditor() {
    const personOptions = this._personOptions();
    const selectedRange = normalizeRange(this._config.range);
    const selectedRows = normalizeTimelineHeightRows(this._config.height_rows);
    this.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:8px;">
        <label>Person
          <select id="person" style="width:100%;">
            <option value="">Bitte wählen</option>
            ${personOptions
              .map(
                (person) =>
                  `<option value="${escapeHtml(person.entity_id)}" ${this._config.person === person.entity_id ? "selected" : ""}>${escapeHtml(person.name)}</option>`
              )
              .join("")}
          </select>
        </label>
        <label>Zeitraum
          <select id="range" style="width:100%;">
            ${RANGE_OPTIONS.map(
              (range) => `<option value="${range}" ${selectedRange === range ? "selected" : ""}>${RANGE_LABELS[range]}</option>`
            ).join("")}
          </select>
        </label>
        <label>Höhe (Rasterreihen)
          <input id="height_rows" type="number" min="1" step="1" value="${selectedRows}" style="width:100%;">
        </label>
      </div>
    `;

    this.querySelector("#person")?.addEventListener("change", (event) => {
      const next = { ...this._config };
      if (event.target.value) {
        next.person = event.target.value;
      } else {
        delete next.person;
      }
      this._fireConfigChanged(next);
    });
    this.querySelector("#range")?.addEventListener("change", (event) => {
      const next = { ...this._config, range: event.target.value };
      this._fireConfigChanged(next);
    });
    this.querySelector("#height_rows")?.addEventListener("change", (event) => {
      const next = { ...this._config, height_rows: normalizeTimelineHeightRows(event.target.value) };
      this._fireConfigChanged(next);
    });
  }

  _renderMapEditor() {
    const personOptions = this._personOptions();
    const selectedPeople = Array.isArray(this._config.people) ? this._config.people : [];
    const center = normalizeCenter(this._config.center);
    const zoom = normalizeZoom(this._config.zoom);
    const selectedRange = normalizeRange(this._config.range);
    const interactive = this._config.interactive !== false;

    this.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:8px;">
        <label>Personen (Strg/Cmd für Mehrfachauswahl)
          <select id="people" multiple size="6" style="width:100%;">
            ${personOptions
              .map(
                (person) =>
                  `<option value="${escapeHtml(person.entity_id)}" ${selectedPeople.includes(person.entity_id) ? "selected" : ""}>${escapeHtml(person.name)}</option>`
              )
              .join("")}
          </select>
        </label>
        <label>Zeitraum
          <select id="range" style="width:100%;">
            ${RANGE_OPTIONS.map(
              (range) => `<option value="${range}" ${selectedRange === range ? "selected" : ""}>${RANGE_LABELS[range]}</option>`
            ).join("")}
          </select>
        </label>
        <label>Zentrum Breite
          <input id="center_lat" type="number" step="0.000001" value="${center[0]}" style="width:100%;">
        </label>
        <label>Zentrum Länge
          <input id="center_lon" type="number" step="0.000001" value="${center[1]}" style="width:100%;">
        </label>
        <label>Zoom
          <input id="zoom" type="number" min="1" step="1" value="${zoom}" style="width:100%;">
        </label>
        <label>
          <input id="interactive" type="checkbox" ${interactive ? "checked" : ""}>
          Interaktive Karte
        </label>
      </div>
    `;

    this.querySelector("#people")?.addEventListener("change", (event) => {
      const selected = [...event.target.selectedOptions].map((option) => option.value);
      const next = { ...this._config, people: selected };
      this._fireConfigChanged(next);
    });
    this.querySelector("#range")?.addEventListener("change", (event) => {
      const next = { ...this._config, range: event.target.value };
      this._fireConfigChanged(next);
    });

    const updateCenter = () => {
      const lat = Number(this.querySelector("#center_lat")?.value);
      const lon = Number(this.querySelector("#center_lon")?.value);
      const next = { ...this._config, center: normalizeCenter([lat, lon]) };
      this._fireConfigChanged(next);
    };

    this.querySelector("#center_lat")?.addEventListener("change", updateCenter);
    this.querySelector("#center_lon")?.addEventListener("change", updateCenter);
    this.querySelector("#zoom")?.addEventListener("change", (event) => {
      const next = { ...this._config, zoom: normalizeZoom(event.target.value) };
      this._fireConfigChanged(next);
    });
    this.querySelector("#interactive")?.addEventListener("change", (event) => {
      const next = { ...this._config, interactive: Boolean(event.target.checked) };
      this._fireConfigChanged(next);
    });
  }

  _render() {
    if (!this._hass || !this._config) return;
    if (this.cardType === "timeline") {
      this._renderTimelineEditor();
      return;
    }
    this._renderMapEditor();
  }
}

if (!customElements.get("zeitachse-map-card")) {
  customElements.define("zeitachse-map-card", ZeitachseMapCard);
}
if (!customElements.get("zeitachse-timeline-card")) {
  customElements.define("zeitachse-timeline-card", ZeitachseTimelineCard);
}
if (!customElements.get("zeitachse-card-editor")) {
  customElements.define("zeitachse-card-editor", ZeitachseCardEditor);
}

window.customCards = window.customCards || [];
window.customCards.push(
  {
    type: "zeitachse-map-card",
    name: "Zeitachse Karte",
    description: "Zeigt die Karte mit YAML-konfigurierbaren Personen, Zeitraum und Ansicht.",
    preview: true,
  },
  {
    type: "zeitachse-timeline-card",
    name: "Zeitachse Timeline",
    description: "Zeigt die Timeline für genau eine ausgewählte Person.",
    preview: true,
  }
);
