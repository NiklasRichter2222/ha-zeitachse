const DEFAULT_MAP_CENTER = [51.1657, 10.4515];
const DEFAULT_MAP_ZOOM = 6;
const LEAFLET_SHADOW_CSS = `
  .leaflet-container { position: relative; overflow: hidden; background: #ddd; }
  .leaflet-pane, .leaflet-tile, .leaflet-marker-icon, .leaflet-marker-shadow,
  .leaflet-tile-container, .leaflet-pane > svg, .leaflet-pane > canvas,
  .leaflet-zoom-box, .leaflet-image-layer, .leaflet-layer {
    position: absolute;
    left: 0;
    top: 0;
  }
  .leaflet-pane { z-index: 400; }
  .leaflet-tile-pane { z-index: 200; }
  .leaflet-overlay-pane { z-index: 400; }
  .leaflet-shadow-pane { z-index: 500; }
  .leaflet-marker-pane { z-index: 600; }
  .leaflet-tooltip-pane { z-index: 650; }
  .leaflet-popup-pane { z-index: 700; }
  .leaflet-map-pane canvas { z-index: 100; }
  .leaflet-map-pane svg { z-index: 200; }
  .leaflet-tile { visibility: hidden; }
  .leaflet-tile-loaded { visibility: inherit; }
  .leaflet-container .leaflet-overlay-pane svg { max-width: none !important; max-height: none !important; }
`;

class ZeitachsePanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.people = [];
    this.timelineByPerson = new Map();
    this.map = null;
    this.layers = [];
  }

  disconnectedCallback() {
    this._resizeObserver?.disconnect();
    this._resizeObserver = null;
  }

  set hass(hass) {
    this._hass = hass;
    if (!this.shadowRoot.innerHTML) {
      this._renderShell();
      this._initMap();
      this._load();
    }
  }

  _renderShell() {
    this.shadowRoot.innerHTML = `
      <style>
        .layout { display: flex; height: 100%; gap: 12px; padding: 12px; box-sizing: border-box; }
        .controls { width: 280px; overflow: auto; border: 1px solid var(--divider-color); border-radius: 8px; padding: 8px; }
        #map { flex: 1; min-height: 500px; border-radius: 8px; }
        .person { display: flex; align-items: center; gap: 8px; margin: 6px 0; }
        .dot { width: 12px; height: 12px; border-radius: 50%; }
        ${LEAFLET_SHADOW_CSS}
      </style>
      <div class="layout">
        <div class="controls" id="controls"></div>
        <div id="map"></div>
      </div>
    `;
  }

  _initMap() {
    if (!window.L || this.map) return;
    this.map = window.L.map(this.shadowRoot.getElementById("map")).setView(DEFAULT_MAP_CENTER, DEFAULT_MAP_ZOOM);
    window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(this.map);
    requestAnimationFrame(() => this.map?.invalidateSize(true));
    this._resizeObserver = new ResizeObserver(() => this.map?.invalidateSize(true));
    this._resizeObserver.observe(this.shadowRoot.getElementById("map"));
  }

  async _load() {
    if (!this._hass) return;
    const result = await this._hass.callWS({ type: "zeitachse/list_people" });
    this.people = result.people || [];
    await this._loadTimelines();
    this._renderControls();
    this._renderMap();
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
        person.active = event.target.checked;
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
        }
        this._renderMap();
      });
      controls.appendChild(row);
    }
  }

  _renderMap() {
    if (!this.map || !window.L) return;

    for (const layer of this.layers) {
      this.map.removeLayer(layer);
    }
    this.layers = [];

    let latest = null;
    for (const person of this.people.filter((it) => it.active)) {
      const timeline = this.timelineByPerson.get(person.entity_id) || [];
      const points = timeline
        .map((entry) => this._toPoint(entry))
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

  _toPoint(entry) {
    const latitude = Number(entry?.latitude);
    const longitude = Number(entry?.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return null;
    }
    return [latitude, longitude];
  }

  static get properties() {
    return { hass: {} };
  }
}

customElements.define("zeitachse-panel", ZeitachsePanel);
