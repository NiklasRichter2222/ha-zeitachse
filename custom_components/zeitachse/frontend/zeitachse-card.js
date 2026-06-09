import { LEAFLET_SHADOW_CSS } from "./leaflet-shadow-css.js";
import { haversineMeters, toPoint, toTimestamp } from "./map-utils.js";

const DEFAULT_MAP_CENTER = [51.1657, 10.4515];
const DEFAULT_MAP_ZOOM = 6;
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

class ZeitachseCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.people = [];
    this.timelineByPerson = new Map();
    this.map = null;
    this.layers = [];
    this.stays = [];
    this.poiByPoint = new Map();
    this._loaded = false;
    this._mapInitFailed = false;
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

  setConfig(config) {
    this.config = config || {};
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

  getCardSize() {
    return 8;
  }

  _renderShell() {
    this.shadowRoot.innerHTML = `
      <style>
        ha-card { padding: 12px; }
        .layout { display: flex; min-height: 560px; gap: 12px; }
        .controls { width: 280px; overflow: auto; border: 1px solid var(--divider-color); border-radius: 8px; padding: 8px; }
        .range-row { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
        .range-btn { border: 1px solid var(--divider-color); background: transparent; border-radius: 14px; padding: 4px 10px; cursor: pointer; }
        .range-btn.active { border-color: var(--primary-color); color: var(--primary-color); font-weight: 600; }
        .person { display: flex; align-items: center; gap: 8px; margin: 6px 0; }
        .dot { width: 12px; height: 12px; border-radius: 50%; }
        .color-picker { width: 32px; height: 22px; border: none; padding: 0; background: transparent; cursor: pointer; }
        .summary { color: var(--secondary-text-color); font-size: 0.9rem; margin-top: 8px; }
        .stay-settings { margin-top: 12px; border-top: 1px solid var(--divider-color); padding-top: 10px; }
        .stay-settings-title { font-weight: 600; margin-bottom: 8px; }
        .stay-setting { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin: 6px 0; }
        .stay-setting input { width: 90px; }
        .status { margin-bottom: 12px; color: var(--secondary-text-color); }
        .map-and-list { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 12px; }
        #map { flex: 1; min-height: 320px; border-radius: 8px; }
        .stay-list { flex: 1; border: 1px solid var(--divider-color); border-radius: 8px; padding: 10px; overflow: auto; min-height: 220px; }
        .stay-title { font-weight: 600; margin-bottom: 8px; }
        .stay-item { border-top: 1px solid var(--divider-color); padding: 8px 0; }
        .stay-item:first-of-type { border-top: none; padding-top: 0; }
        .stay-empty { color: var(--secondary-text-color); }
        .stay-meta { color: var(--secondary-text-color); font-size: 0.9rem; }
        ${LEAFLET_SHADOW_CSS}
      </style>
      <ha-card>
        <div class="status" id="status">Zeitachse lädt…</div>
        <div class="layout">
          <div class="controls" id="controls"></div>
          <div class="map-and-list">
            <div id="map"></div>
            <div class="stay-list" id="stay-list"></div>
          </div>
        </div>
      </ha-card>
    `;
  }

  _showStatus(message) {
    const status = this.shadowRoot.getElementById("status");
    if (status) {
      status.textContent = message;
    }
  }

  async _waitForLeaflet() {
    for (let attempt = 1; attempt <= LEAFLET_WAIT_MAX_ATTEMPTS; attempt += 1) {
      if (window.L) {
        if (attempt > 1) {
          console.debug(`[zeitachse-card] Leaflet became available after ${attempt} attempts`);
        }
        return true;
      }
      console.debug(`[zeitachse-card] Waiting for Leaflet (${attempt}/${LEAFLET_WAIT_MAX_ATTEMPTS})`);
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
      this.map = window.L.map(mapElement).setView(DEFAULT_MAP_CENTER, DEFAULT_MAP_ZOOM);
      window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "&copy; OpenStreetMap contributors",
      }).addTo(this.map);
      requestAnimationFrame(() => this.map?.invalidateSize(true));
      this._resizeObserver = new ResizeObserver(() => this.map?.invalidateSize(true));
      this._resizeObserver.observe(mapElement);
      console.debug("[zeitachse-card] Map initialized");
      this._mapInitFailed = false;
      return true;
    } catch (error) {
      console.error("[zeitachse-card] Failed to initialize map", error);
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
      console.error("[zeitachse-card] Leaflet unavailable; map rendering disabled");
      return;
    }

    try {
      const result = await this._hass.callWS({ type: "zeitachse/list_people" });
      this.people = result.people || [];
      this.staySettings = this._normalizeStaySettings(result.stay_settings);
      console.debug(`[zeitachse-card] Loaded ${this.people.length} people`);
      await this._loadTimelines();
      this._renderControls();
      await this._refreshStaysAndPoi();
      this._showStatus(this.people.length ? "Aktive Zeitachse" : "Keine Personen gefunden");
    } catch (error) {
      console.error("[zeitachse-card] Failed to load people/timeline data", error);
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
          `[zeitachse-card] Loaded ${this.timelineByPerson.get(person.entity_id).length} snapshots for ${person.entity_id}`
        );
      })
    );
  }

  async _setRange(range) {
    this.selectedRange = range;
    await this._loadTimelines();
    this._renderControls();
    await this._refreshStaysAndPoi();
  }

  async _setPersonColor(person, color) {
    person.color = color;
    const personColors = Object.fromEntries(this.people.map((entry) => [entry.entity_id, entry.color]));
    await this._hass.callWS({
      type: "zeitachse/set_person_colors",
      person_colors: personColors,
    });
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

  async _setStaySettings(settings) {
    const normalized = this._normalizeStaySettings(settings);
    const result = await this._hass.callWS({
      type: "zeitachse/set_stay_settings",
      min_snapshots: normalized.min_snapshots,
      distance_meters: normalized.distance_meters,
    });
    this.staySettings = this._normalizeStaySettings(result?.stay_settings);
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
          console.error("[zeitachse-card] Failed to update range", error);
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

    const settingsSection = document.createElement("div");
    settingsSection.className = "stay-settings";
    settingsSection.innerHTML = `
      <div class="stay-settings-title">Aufenthalts-Erkennung</div>
      <label class="stay-setting">
        <span>Min. Snapshots</span>
        <input class="stay-min-snapshots" type="number" min="${MIN_STAY_MIN_SNAPSHOTS}" max="${MAX_STAY_MIN_SNAPSHOTS}" step="1" value="${this.staySettings.min_snapshots}">
      </label>
      <label class="stay-setting">
        <span>Abweichung (m)</span>
        <input class="stay-distance-meters" type="number" min="${MIN_STAY_DISTANCE_METERS}" max="${MAX_STAY_DISTANCE_METERS}" step="1" value="${this.staySettings.distance_meters}">
      </label>
    `;
    const minSnapshotsInput = settingsSection.querySelector(".stay-min-snapshots");
    const distanceInput = settingsSection.querySelector(".stay-distance-meters");
    if (!minSnapshotsInput || !distanceInput) {
      controls.appendChild(settingsSection);
      return;
    }
    const applyStaySettings = async () => {
      const previous = { ...this.staySettings };
      const next = this._normalizeStaySettings({
        min_snapshots: Number(minSnapshotsInput.value),
        distance_meters: Number(distanceInput.value),
      });
      if (
        next.min_snapshots === previous.min_snapshots &&
        next.distance_meters === previous.distance_meters
      ) {
        minSnapshotsInput.value = String(previous.min_snapshots);
        distanceInput.value = String(previous.distance_meters);
        return;
      }
      this.staySettings = next;
      try {
        await this._setStaySettings(next);
        await this._refreshStaysAndPoi();
        this._renderControls();
      } catch (error) {
        this.staySettings = previous;
        minSnapshotsInput.value = String(previous.min_snapshots);
        distanceInput.value = String(previous.distance_meters);
        console.error("[zeitachse-card] Failed to update stay settings", error);
        this._showStatus(`Network error while updating stay settings: ${error?.message || error}`);
      }
    };
    minSnapshotsInput.addEventListener("change", applyStaySettings);
    distanceInput.addEventListener("change", applyStaySettings);
    controls.appendChild(settingsSection);

    for (const person of this.people) {
      const row = document.createElement("label");
      row.className = "person";
      row.innerHTML = `
        <input type="checkbox" ${person.active ? "checked" : ""}>
        <span class="dot" style="background:${person.color}"></span>
        <span>${person.name}</span>
        <input class="color-picker" type="color" value="${person.color}" aria-label="Farbe für ${person.name}">
      `;
      row.querySelector("input[type='checkbox']").addEventListener("change", async (event) => {
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
            console.debug(
              `[zeitachse-card] Loaded ${this.timelineByPerson.get(person.entity_id).length} snapshots for ${person.entity_id}`
            );
          }
        } catch (error) {
          person.active = !isActive;
          event.target.checked = person.active;
          console.error("[zeitachse-card] Failed to update active people", error);
          this._showStatus(`Network error while updating active people: ${error?.message || error}`);
        }
        this._renderControls();
        await this._refreshStaysAndPoi();
      });
      row.querySelector("input[type='color']").addEventListener("change", async (event) => {
        const previousColor = person.color;
        const newColor = event.target.value;
        try {
          await this._setPersonColor(person, newColor);
          this._renderControls();
          this._renderMap();
          this._renderStayList();
        } catch (error) {
          person.color = previousColor;
          event.target.value = previousColor;
          console.error("[zeitachse-card] Failed to update person color", error);
          this._showStatus(`Network error while updating color: ${error?.message || error}`);
        }
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
      console.debug("[zeitachse-card] Skipping map render because map is not ready");
      return;
    }

    for (const layer of this.layers) {
      this.map.removeLayer(layer);
    }
    this.layers = [];

    let latest = null;
    for (const person of this.people.filter((it) => it.active)) {
      const timeline = this.timelineByPerson.get(person.entity_id) || [];
      const points = timeline.map((entry) => toPoint(entry)).filter((entry) => entry !== null);

      if (points.length === 0) continue;

      const polyline = window.L.polyline(points, { color: person.color, weight: 4 }).addTo(this.map);
      this.layers.push(polyline);

      const lastPoint = points[points.length - 1];
      latest = latest || lastPoint;
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
      const detailsLink = poi?.url
        ? `<br><a href="${escapeHtml(poi.url)}" target="_blank" rel="noopener noreferrer">Mehr Infos</a>`
        : "";
      stayMarker.bindPopup(
        `<strong>${escapeHtml(stay.person.name)}</strong><br>${poiLabel}<br>${this._formatDuration(stay.durationMs)}${detailsLink}`
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

    if (latest) {
      this.map.setView(latest, 12);
    } else {
      this.map.setView(DEFAULT_MAP_CENTER, DEFAULT_MAP_ZOOM);
    }
    this.map.invalidateSize(true);
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

  async _refreshStaysAndPoi() {
    const stays = this._collectStays();
    this.stays = stays;
    await this._loadPoiForStays(stays);
    this._renderMap();
    this._renderStayList();
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
        } catch (error) {
          if (version !== this._poiLookupVersion) return;
          this.poiByPoint.set(key, null);
          console.debug("[zeitachse-card] POI lookup failed", error);
        }
      })
    );
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
        const poi = this.poiByPoint.get(pointKey(stay.point)) || null;
        const poiName = poi?.name ? escapeHtml(poi.name) : "Namenloser Pin";
        const poiLink = poi?.url
          ? ` · <a href="${escapeHtml(poi.url)}" target="_blank" rel="noopener noreferrer">Mehr Infos</a>`
          : "";
        return `
          <div class="stay-item">
            <div><span class="dot" style="background:${stay.person.color}; display:inline-block; margin-right:8px;"></span><strong>${escapeHtml(stay.person.name)}</strong></div>
            <div class="stay-meta">${formatter.format(stay.start)} → ${formatter.format(stay.end)} · ${this._formatDuration(stay.durationMs)}</div>
            <div class="stay-meta">POI: ${poiName}${poiLink} · ${stay.samples} Snapshots</div>
          </div>
        `;
      })
      .join("");
    container.innerHTML = `<div class="stay-title">Aufenthalte (${RANGE_LABELS[this.selectedRange]})</div>${content}`;
  }
}

customElements.define("zeitachse-card", ZeitachseCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "zeitachse-card",
  name: "Zeitachse",
  description: "Zeigt die Zeitachse auf einer Karte an",
  preview: true,
});
