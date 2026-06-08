import { LEAFLET_SHADOW_CSS } from "./leaflet-shadow-css.js";
import { toPoint } from "./map-utils.js";

const DEFAULT_MAP_CENTER = [51.1657, 10.4515];
const DEFAULT_MAP_ZOOM = 6;
const LEAFLET_WAIT_MAX_ATTEMPTS = 10;
const LEAFLET_WAIT_DELAY_MS = 500;

class ZeitachsePanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.people = [];
    this.timelineByPerson = new Map();
    this.map = null;
    this.layers = [];
    this._loaded = false;
    this._mapInitFailed = false;
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
        .layout { display: flex; height: 100%; gap: 12px; padding: 12px; box-sizing: border-box; }
        .status { margin: 12px; color: var(--secondary-text-color); }
        .controls { width: 280px; overflow: auto; border: 1px solid var(--divider-color); border-radius: 8px; padding: 8px; }
        #map { flex: 1; min-height: 500px; border-radius: 8px; }
        .person { display: flex; align-items: center; gap: 8px; margin: 6px 0; }
        .dot { width: 12px; height: 12px; border-radius: 50%; }
        ${LEAFLET_SHADOW_CSS}
      </style>
      <div class="status" id="status">Zeitachse lädt…</div>
      <div class="layout">
        <div class="controls" id="controls"></div>
        <div id="map"></div>
      </div>
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
          console.debug(`[zeitachse-panel] Leaflet became available after ${attempt} attempts`);
        }
        return true;
      }
      console.debug(`[zeitachse-panel] Waiting for Leaflet (${attempt}/${LEAFLET_WAIT_MAX_ATTEMPTS})`);
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
      console.debug("[zeitachse-panel] Map initialized");
      this._mapInitFailed = false;
      return true;
    } catch (error) {
      console.error("[zeitachse-panel] Failed to initialize map", error);
      this._mapInitFailed = true;
      return false;
    }
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
      console.debug(`[zeitachse-panel] Loaded ${this.people.length} people`);
      await this._loadTimelines();
      this._renderControls();
      this._renderMap();
      this._showStatus(this.people.length ? "Aktive Zeitachse" : "Keine Personen gefunden");
    } catch (error) {
      console.error("[zeitachse-panel] Failed to load people/timeline data", error);
      this._showStatus(`Network error while loading timeline: ${error?.message || error}`);
    }
  }

  async _loadTimelines() {
    const active = this.people.filter((person) => person.active);
    await Promise.all(
      active.map(async (person) => {
        const timeline = await this._hass.callWS({
          type: "zeitachse/get_timeline",
          entity_id: person.entity_id,
        });
        this.timelineByPerson.set(person.entity_id, timeline.timeline || []);
        console.debug(
          `[zeitachse-panel] Loaded ${this.timelineByPerson.get(person.entity_id).length} snapshots for ${person.entity_id}`
        );
      })
    );
  }

  _renderControls() {
    const controls = this.shadowRoot.getElementById("controls");
    controls.innerHTML = "";

    for (const person of this.people) {
      const row = document.createElement("label");
      row.className = "person";
      row.innerHTML = `
        <input type="checkbox" ${person.active ? "checked" : ""}>
        <span class="dot" style="background:${person.color}"></span>
        <span>${person.name}</span>
      `;
      row.querySelector("input").addEventListener("change", async (event) => {
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
            });
            this.timelineByPerson.set(person.entity_id, timeline.timeline || []);
            console.debug(
              `[zeitachse-panel] Loaded ${this.timelineByPerson.get(person.entity_id).length} snapshots for ${person.entity_id}`
            );
          }
        } catch (error) {
          person.active = !isActive;
          event.target.checked = person.active;
          console.error("[zeitachse-panel] Failed to update active people", error);
          this._showStatus(`Network error while updating active people: ${error?.message || error}`);
        }
        this._renderMap();
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

    let latest = null;
    for (const person of this.people.filter((it) => it.active)) {
      const timeline = this.timelineByPerson.get(person.entity_id) || [];
      const points = timeline
        .map((entry) => toPoint(entry))
        .filter((entry) => entry !== null);

      if (points.length === 0) continue;

      const polyline = window.L.polyline(points, { color: person.color, weight: 4 }).addTo(this.map);
      this.layers.push(polyline);

      const lastPoint = points[points.length - 1];
      latest = latest || lastPoint;
      const marker = window.L.circleMarker(lastPoint, { color: person.color, radius: 7 }).addTo(this.map);
      marker.bindPopup(`${person.name} (${points.length} points)`);
      this.layers.push(marker);
    }

    if (latest) {
      this.map.setView(latest, 12);
    } else {
      this.map.setView(DEFAULT_MAP_CENTER, DEFAULT_MAP_ZOOM);
    }
    this.map.invalidateSize(true);
  }

  static get properties() {
    return { hass: {} };
  }
}

customElements.define("zeitachse-panel", ZeitachsePanel);
