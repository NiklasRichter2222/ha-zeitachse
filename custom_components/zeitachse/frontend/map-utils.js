export const toPoint = (entry) => {
  const latitude = Number(entry?.latitude);
  const longitude = Number(entry?.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }
  return [latitude, longitude];
};

export const toTimestamp = (entry) => {
  const raw = entry?.timestamp;
  if (!raw) return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
};

export const pointKey = (point) => {
  if (!Array.isArray(point) || point.length !== 2) return "";
  const [lat, lon] = point;
  return `${Number(lat).toFixed(5)},${Number(lon).toFixed(5)}`;
};

// Returns Infinity for invalid input so callers can treat invalid points as "not near".
export const haversineMeters = (firstPoint, secondPoint) => {
  if (!firstPoint || !secondPoint) {
    return Number.POSITIVE_INFINITY;
  }
  const [lat1, lon1] = firstPoint;
  const [lat2, lon2] = secondPoint;
  const toRadians = (degrees) => (degrees * Math.PI) / 180;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return 6371000 * c;
};

// Filter out redundant consecutive points that are within minDistanceMeters to optimize map line performance
export const simplifyPoints = (points, minDistanceMeters = 3) => {
  if (!Array.isArray(points) || points.length <= 2) return points || [];
  const result = [points[0]];
  let last = points[0];
  for (let i = 1; i < points.length - 1; i += 1) {
    const current = points[i];
    if (haversineMeters(last, current) >= minDistanceMeters) {
      result.push(current);
      last = current;
    }
  }
  result.push(points[points.length - 1]);
  return result;
};

// Spatially cluster stays within clusterRadiusMeters to prevent duplicate POI queries and overlapping pins
export const clusterStays = (stays, clusterRadiusMeters = 75) => {
  if (!Array.isArray(stays) || stays.length === 0) return [];
  const clusters = [];
  for (const stay of stays) {
    if (!stay.point) continue;
    let matchedCluster = null;
    for (const cluster of clusters) {
      if (haversineMeters(cluster.point, stay.point) <= clusterRadiusMeters) {
        matchedCluster = cluster;
        break;
      }
    }
    if (matchedCluster) {
      matchedCluster.stays.push(stay);
      matchedCluster.totalDurationMs += stay.durationMs || 0;
      matchedCluster.sampleCount += stay.samples || 1;
      stay.clusterId = matchedCluster.id;
      stay.canonicalPoint = matchedCluster.point;
    } else {
      const newCluster = {
        id: `cluster_${clusters.length}_${pointKey(stay.point)}`,
        point: stay.point,
        totalDurationMs: stay.durationMs || 0,
        sampleCount: stay.samples || 1,
        stays: [stay],
        person: stay.person,
      };
      stay.clusterId = newCluster.id;
      stay.canonicalPoint = stay.point;
      clusters.push(newCluster);
    }
  }
  return clusters;
};

let leafletLoadingPromise = null;

export const ensureLeafletLoaded = () => {
  if (window.L) {
    return Promise.resolve(window.L);
  }
  if (leafletLoadingPromise) {
    return leafletLoadingPromise;
  }

  leafletLoadingPromise = new Promise((resolve, reject) => {
    if (window.L) {
      resolve(window.L);
      return;
    }

    // Ensure CSS is loaded in document head
    if (!document.getElementById("zeitachse-leaflet-css")) {
      const link = document.createElement("link");
      link.id = "zeitachse-leaflet-css";
      link.rel = "stylesheet";
      link.href = "/zeitachse_static/leaflet.css";
      document.head.appendChild(link);
    }

    const loadCdnFallback = () => {
      console.warn("[zeitachse] Falling back to Leaflet CDN...");
      const cdnScript = document.createElement("script");
      cdnScript.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
      cdnScript.async = true;
      cdnScript.onload = () => {
        if (window.L) {
          resolve(window.L);
        } else {
          reject(new Error("Leaflet loaded from CDN but window.L is missing"));
        }
      };
      cdnScript.onerror = (err) => reject(err);
      document.head.appendChild(cdnScript);
    };

    let script = document.getElementById("zeitachse-leaflet-js");
    if (!script) {
      script = document.createElement("script");
      script.id = "zeitachse-leaflet-js";
      script.src = "/zeitachse_static/leaflet.js";
      script.async = true;
      script.onload = () => {
        if (window.L) {
          console.debug("[zeitachse] Leaflet loaded from /zeitachse_static/leaflet.js");
          resolve(window.L);
        } else {
          loadCdnFallback();
        }
      };
      script.onerror = () => {
        loadCdnFallback();
      };
      document.head.appendChild(script);
    } else {
      script.addEventListener("load", () => {
        if (window.L) resolve(window.L);
        else loadCdnFallback();
      });
      script.addEventListener("error", () => loadCdnFallback());
    }

    // Polling fallback in case another script loaded Leaflet concurrently
    let attempts = 0;
    const interval = setInterval(() => {
      attempts += 1;
      if (window.L) {
        clearInterval(interval);
        resolve(window.L);
      } else if (attempts > 50) {
        clearInterval(interval);
      }
    }, 100);
  });

  return leafletLoadingPromise;
};

export const escapeHtml = (value) => {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
};

export const calculateBearing = (startPoint, endPoint) => {
  if (!startPoint || !endPoint) return 0;
  const [lat1, lon1] = startPoint;
  const [lat2, lon2] = endPoint;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const toDeg = (rad) => (rad * 180) / Math.PI;
  const dLon = toRad(lon2 - lon1);
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const y = Math.sin(dLon) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
  const bearing = (toDeg(Math.atan2(y, x)) + 360) % 360;
  return Math.round(bearing);
};

export const compassHeading = (bearing) => {
  const directions = ["N", "NO", "O", "SO", "S", "SW", "W", "NW"];
  const index = Math.round(bearing / 45) % 8;
  return directions[index];
};

export const createDirectionArrowIcon = (color, bearing, opacity = 0.9, size = 16) => {
  if (!window.L) return null;
  return window.L.divIcon({
    className: "zeitachse-direction-arrow",
    html: `
      <div style="
        transform: rotate(${bearing}deg);
        width: ${size}px;
        height: ${size}px;
        display: flex;
        align-items: center;
        justify-content: center;
        opacity: ${opacity};
        pointer-events: none;
      ">
        <svg viewBox="0 0 24 24" width="${size}" height="${size}" style="filter: drop-shadow(0 1px 2px rgba(0,0,0,0.6));">
          <path d="M12 2 L21 21 L12 17 L3 21 Z" fill="${color}" stroke="#ffffff" stroke-width="1.5" stroke-linejoin="round"/>
        </svg>
      </div>
    `,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
};

export const renderTimelineTrack = (map, points, person, options = {}) => {
  if (!map || !window.L || !Array.isArray(points) || points.length === 0) {
    return [];
  }

  const layers = [];
  const tolerance = options.tolerance || 3;
  const simplified = simplifyPoints(points, tolerance);

  if (simplified.length === 0) return layers;

  // Single point case
  if (simplified.length === 1) {
    const singleMarker = window.L.circleMarker(simplified[0], {
      color: person.color,
      fillColor: person.color,
      fillOpacity: 1.0,
      radius: 7,
      weight: 2,
      renderer: window.L.canvas({ padding: 0.5 }),
    }).addTo(map);
    singleMarker.bindPopup(`<strong>${escapeHtml(person.name)}</strong><br>1 Snapshot`);
    layers.push(singleMarker);
    return layers;
  }

  // 2+ points: Timeline Gradient & Direction Arrows
  const totalPoints = simplified.length;
  // Divide into progressive segments for gradient effect
  const numSegments = Math.min(16, totalPoints - 1);
  const pointsPerSegment = (totalPoints - 1) / numSegments;

  for (let s = 0; s < numSegments; s += 1) {
    const startIdx = Math.floor(s * pointsPerSegment);
    const endIdx = Math.min(totalPoints - 1, Math.floor((s + 1) * pointsPerSegment) + 1);
    const segmentSlice = simplified.slice(startIdx, endIdx);
    if (segmentSlice.length < 2) continue;

    const t = (s + 1) / numSegments; // 0 < t <= 1 (1 = newest)
    const opacity = Math.min(1.0, 0.22 + 0.78 * t);
    const weight = 3 + 2.5 * t;

    const polyline = window.L.polyline(segmentSlice, {
      color: person.color,
      opacity,
      weight,
      lineCap: "round",
      lineJoin: "round",
      renderer: window.L.canvas({ padding: 0.5 }),
    }).addTo(map);
    layers.push(polyline);
  }

  // Start Marker (Origin of selected time period)
  const startPoint = simplified[0];
  const startMarker = window.L.circleMarker(startPoint, {
    color: person.color,
    fillColor: "#ffffff",
    fillOpacity: 0.95,
    radius: 5.5,
    weight: 2.5,
    renderer: window.L.canvas({ padding: 0.5 }),
  }).addTo(map);
  startMarker.bindPopup(`<strong>${escapeHtml(person.name)}</strong> · Startpunkt<br>Ausgangspunkt im gewählten Zeitraum`);
  layers.push(startMarker);

  // End / Latest Marker (Destination / Current Location with integrated Direction Arrow)
  const lastPoint = simplified[totalPoints - 1];
  const prevPoint = simplified[totalPoints - 2];
  const finalBearing = calculateBearing(prevPoint, lastPoint);
  const headingStr = compassHeading(finalBearing);

  // Unified destination pin with directional arrow pointing in the travel heading
  const endIcon = window.L.divIcon({
    className: "zeitachse-direction-pin",
    html: `
      <div style="
        transform: rotate(${finalBearing}deg);
        width: 28px;
        height: 28px;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
      ">
        <svg viewBox="0 0 28 28" width="28" height="28" style="filter: drop-shadow(0 2px 4px rgba(0,0,0,0.5)); overflow: visible;">
          <!-- Directional navigation pointer pointing in movement direction -->
          <polygon points="14,1 21,11 14,8 7,11" fill="${person.color}" stroke="#ffffff" stroke-width="1.5" stroke-linejoin="round"/>
          <!-- Central location dot -->
          <circle cx="14" cy="14" r="7.5" fill="${person.color}" stroke="#ffffff" stroke-width="2.5"/>
        </svg>
      </div>
    `,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    popupAnchor: [0, -14],
  });

  const endMarker = window.L.marker(lastPoint, {
    icon: endIcon,
    zIndexOffset: 1000,
  }).addTo(map);

  endMarker.bindPopup(
    `<strong>${escapeHtml(person.name)}</strong> · Aktuell / Letzter Standort<br>Bewegungsrichtung: ${finalBearing}° (${headingStr})<br>${points.length} Snapshots`
  );
  layers.push(endMarker);

  return layers;
};

export const BASEMAP_PROVIDERS = {
  local_osm: {
    name: "OpenStreetMap (HA Cache)",
    url: "/api/zeitachse/tiles/{z}/{x}/{y}.png",
    options: {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
    },
  },
  osm_de: {
    name: "OpenStreetMap (DE)",
    url: "https://tile.openstreetmap.de/{z}/{x}/{y}.png",
    options: {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
    },
  },
  esri_street: {
    name: "Esri World Street",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}",
    options: {
      maxZoom: 19,
      attribution: "Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ, TomTom",
    },
  },
  esri_topo: {
    name: "Esri Topo",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}",
    options: {
      maxZoom: 19,
      attribution: "Tiles &copy; Esri",
    },
  },
  osm_standard: {
    name: "OpenStreetMap (Direkt)",
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    options: {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
    },
  },
};

export const setupTileLayer = (map, config = {}) => {
  if (!map || !window.L) return null;

  let activeProviderKey = config.provider || "local_osm";
  let activeUrl = config.url;
  let activeAttribution = config.attribution;

  const getProviderConfig = (key) => {
    return BASEMAP_PROVIDERS[key] || BASEMAP_PROVIDERS.local_osm;
  };

  const provider = getProviderConfig(activeProviderKey);
  const tileUrl = activeUrl || provider.url;
  const tileOptions = {
    attribution: activeAttribution || provider.options.attribution,
    maxZoom: provider.options.maxZoom || 19,
    subdomains: provider.options.subdomains || "abc",
    referrerPolicy: "origin",
  };

  let tileLayer = window.L.tileLayer(tileUrl, tileOptions).addTo(map);

  let errorCount = 0;
  tileLayer.on("tileerror", () => {
    errorCount += 1;
    if (errorCount === 3 && activeProviderKey !== "esri_street" && !activeUrl) {
      console.warn("[zeitachse] Primary tile layer encountered errors, falling back to Esri World Street...");
      map.removeLayer(tileLayer);
      const fallback = BASEMAP_PROVIDERS.esri_street;
      tileLayer = window.L.tileLayer(fallback.url, {
        attribution: fallback.options.attribution,
        maxZoom: fallback.options.maxZoom,
      }).addTo(map);
    }
  });

  return {
    tileLayer,
    setProvider(newKey, newUrl = null) {
      activeProviderKey = newKey || activeProviderKey;
      activeUrl = newUrl;
      const nextProvider = getProviderConfig(activeProviderKey);
      errorCount = 0;
      map.removeLayer(tileLayer);
      const urlToUse = (activeProviderKey === "custom" && activeUrl) ? activeUrl : nextProvider.url;
      tileLayer = window.L.tileLayer(urlToUse, {
        ...nextProvider.options,
        referrerPolicy: "origin",
      }).addTo(map);
      return tileLayer;
    },
  };
};
