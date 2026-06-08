export const LEAFLET_SHADOW_CSS = `
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
