export const toPoint = (entry) => {
  const latitude = Number(entry?.latitude);
  const longitude = Number(entry?.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }
  return [latitude, longitude];
};

export const toTimestampMs = (entry) => {
  const raw = entry?.timestamp;
  if (!raw) return Number.NaN;
  if (typeof raw === "number") return raw;
  return Date.parse(raw);
};

export const toTimestamp = (entry) => {
  const ms = toTimestampMs(entry);
  if (Number.isNaN(ms)) {
    return null;
  }
  return new Date(ms);
};

export const pointKey = (point) => {
  if (!Array.isArray(point) || point.length !== 2) return "";
  const [lat, lon] = point;
  return `${Number(lat).toFixed(5)},${Number(lon).toFixed(5)}`;
};

export const sanitizeColor = (value, fallback = "#03a9f4") => {
  if (typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value.trim())) {
    return value.trim();
  }
  return fallback;
};

export const getInitials = (name) => {
  const cleaned = String(name || "").trim();
  if (!cleaned) return "?";
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
  }
  return cleaned.slice(0, 2).toUpperCase();
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

// Perpendicular distance squared in degree space for fast Ramer-Douglas-Peucker decimation
const perpendicularDistSq = (pt, lineStart, lineEnd) => {
  const dx = lineEnd[1] - lineStart[1];
  const dy = lineEnd[0] - lineStart[0];
  if (dx === 0 && dy === 0) {
    const dLat = pt[0] - lineStart[0];
    const dLon = pt[1] - lineStart[1];
    return dLat * dLat + dLon * dLon;
  }
  const t = Math.max(
    0,
    Math.min(
      1,
      ((pt[1] - lineStart[1]) * dx + (pt[0] - lineStart[0]) * dy) / (dx * dx + dy * dy)
    )
  );
  const projLat = lineStart[0] + t * dy;
  const projLon = lineStart[1] + t * dx;
  const dLat = pt[0] - projLat;
  const dLon = pt[1] - projLon;
  return dLat * dLat + dLon * dLon;
};

const decimateToMaxPoints = (points, maxPoints) => {
  if (points.length <= maxPoints || maxPoints < 3) return points;
  // Fast importance-preserving stride + peak retention so 1m/1y tracks never freeze the browser
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  const bucketCount = maxPoints - 2;
  const bucketSize = (points.length - 2) / bucketCount;
  for (let b = 0; b < bucketCount; b += 1) {
    const start = 1 + Math.floor(b * bucketSize);
    const end = Math.min(points.length - 1, 1 + Math.floor((b + 1) * bucketSize));
    if (start >= end) {
      keep[Math.min(start, points.length - 2)] = 1;
      continue;
    }
    const prevPt = points[start - 1];
    const nextPt = points[end];
    let bestIdx = start;
    let bestDist = -1;
    for (let i = start; i < end; i += 1) {
      const dist = perpendicularDistSq(points[i], prevPt, nextPt);
      if (dist > bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
    keep[bestIdx] = 1;
  }

  const out = [];
  for (let i = 0; i < points.length; i += 1) {
    if (keep[i]) out.push(points[i]);
  }
  return out;
};

// Filter out redundant consecutive points within minDistanceMeters and cap vertex count
export const simplifyPoints = (points, minDistanceMeters = 3, maxPoints = 2200) => {
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
  if (result.length > maxPoints) {
    return decimateToMaxPoints(result, maxPoints);
  }
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
      if (
        stay.person &&
        !matchedCluster.people.some((p) => p.entity_id === stay.person.entity_id)
      ) {
        matchedCluster.people.push(stay.person);
      }
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
        people: stay.person ? [stay.person] : [],
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
      cdnScript.crossOrigin = "anonymous";
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

export const getSharedCanvasRenderer = (map) => {
  if (!map || !window.L) return null;
  if (!map._zeitachseCanvasRenderer) {
    map._zeitachseCanvasRenderer = window.L.canvas({ padding: 0.5 });
  }
  return map._zeitachseCanvasRenderer;
};

export const createDirectionArrowIcon = (color, bearing, opacity = 0.9, size = 16) => {
  if (!window.L) return null;
  const safeColor = sanitizeColor(color);
  const safeBearing = Number.isFinite(Number(bearing)) ? Number(bearing) : 0;
  return window.L.divIcon({
    className: "zeitachse-direction-arrow",
    html: `
      <div style="
        transform: rotate(${safeBearing}deg);
        width: ${size}px;
        height: ${size}px;
        display: flex;
        align-items: center;
        justify-content: center;
        opacity: ${opacity};
        pointer-events: none;
      ">
        <svg viewBox="0 0 24 24" width="${size}" height="${size}" style="filter: drop-shadow(0 1px 2px rgba(0,0,0,0.6));">
          <path d="M12 2 L21 21 L12 17 L3 21 Z" fill="${safeColor}" stroke="#ffffff" stroke-width="1.5" stroke-linejoin="round"/>
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
  const maxPoints = options.maxPoints || 2200;
  const simplified = simplifyPoints(points, tolerance, maxPoints);
  if (simplified.length === 0) return layers;

  const safeColor = sanitizeColor(person?.color);
  const initials = escapeHtml(getInitials(person?.name));
  const renderer = getSharedCanvasRenderer(map);

  // Single point case
  if (simplified.length === 1) {
    const singleIcon = window.L.divIcon({
      className: "zeitachse-person-pin",
      html: `
        <div style="
          width: 30px;
          height: 30px;
          border-radius: 50%;
          background: #1c1c1c;
          border: 2.5px solid ${safeColor};
          color: #ffffff;
          font-size: 11px;
          font-weight: 700;
          display: flex;
          align-items: center;
          justify-content: center;
          box-shadow: 0 2px 8px rgba(0,0,0,0.55);
        ">${initials}</div>
      `,
      iconSize: [30, 30],
      iconAnchor: [15, 15],
      popupAnchor: [0, -15],
    });
    const singleMarker = window.L.marker(simplified[0], {
      icon: singleIcon,
      zIndexOffset: 1000,
    }).addTo(map);
    singleMarker.bindPopup(`<strong>${escapeHtml(person?.name)}</strong><br>1 Snapshot`);
    layers.push(singleMarker);
    return layers;
  }

  // 2+ points: Timeline Gradient & Direction Arrows using a SINGLE shared Canvas renderer
  const totalPoints = simplified.length;
  const numSegments = Math.min(12, totalPoints - 1);
  const pointsPerSegment = (totalPoints - 1) / numSegments;

  for (let s = 0; s < numSegments; s += 1) {
    const startIdx = Math.floor(s * pointsPerSegment);
    const endIdx = Math.min(totalPoints - 1, Math.floor((s + 1) * pointsPerSegment) + 1);
    const segmentSlice = simplified.slice(startIdx, endIdx);
    if (segmentSlice.length < 2) continue;

    const t = (s + 1) / numSegments;
    const opacity = Math.min(0.95, 0.25 + 0.7 * t);
    const weight = 2.8 + 2.2 * t;

    const polyline = window.L.polyline(segmentSlice, {
      color: safeColor,
      opacity,
      weight,
      lineCap: "round",
      lineJoin: "round",
      renderer,
    }).addTo(map);
    layers.push(polyline);
  }

  // Start Marker
  const startPoint = simplified[0];
  const startMarker = window.L.circleMarker(startPoint, {
    color: safeColor,
    fillColor: "#1c1c1c",
    fillOpacity: 0.95,
    radius: 5,
    weight: 2.5,
    renderer,
  }).addTo(map);
  startMarker.bindPopup(
    `<strong>${escapeHtml(person?.name)}</strong> · Startpunkt<br>Ausgangspunkt im gewählten Zeitraum`
  );
  layers.push(startMarker);

  // End / Latest Marker styled like Home Assistant entity badge with directional pointer
  const lastPoint = simplified[totalPoints - 1];
  const prevPoint = simplified[totalPoints - 2];
  const finalBearing = calculateBearing(prevPoint, lastPoint);
  const headingStr = compassHeading(finalBearing);

  const endIcon = window.L.divIcon({
    className: "zeitachse-direction-pin",
    html: `
      <div style="
        position: relative;
        width: 36px;
        height: 36px;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
      ">
        <svg viewBox="0 0 36 36" width="36" height="36" style="position: absolute; top: 0; left: 0; transform: rotate(${finalBearing}deg); filter: drop-shadow(0 2px 5px rgba(0,0,0,0.6)); overflow: visible;">
          <polygon points="18,0 24,10 18,7.5 12,10" fill="${safeColor}" stroke="#ffffff" stroke-width="1.2" stroke-linejoin="round"/>
        </svg>
        <div style="
          width: 24px;
          height: 24px;
          border-radius: 50%;
          background: #1c1c1c;
          border: 2.5px solid ${safeColor};
          color: #ffffff;
          font-size: 10px;
          font-weight: 700;
          letter-spacing: -0.3px;
          display: flex;
          align-items: center;
          justify-content: center;
          box-shadow: 0 2px 6px rgba(0,0,0,0.5);
          z-index: 2;
        ">${initials}</div>
      </div>
    `,
    iconSize: [36, 36],
    iconAnchor: [18, 18],
    popupAnchor: [0, -16],
  });

  const endMarker = window.L.marker(lastPoint, {
    icon: endIcon,
    zIndexOffset: 1000,
  }).addTo(map);

  endMarker.bindPopup(
    `<strong>${escapeHtml(person?.name)}</strong> · Aktuell / Letzter Standort<br>Bewegungsrichtung: ${finalBearing}° · ${headingStr}<br>${points.length} Snapshots`
  );
  layers.push(endMarker);

  return layers;
};

const boxesOverlap = (a, b) => {
  return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
};

// Dynamic screen-space collision culling: longest stays stay visible longest
export const updateOverlapCulledTooltips = (map, stayClusters, stayMarkers) => {
  if (!map || !Array.isArray(stayMarkers) || stayMarkers.length === 0) return;

  const mapSize = map.getSize ? map.getSize() : { x: 1200, y: 800 };
  const viewportWidth = mapSize.x || 1200;
  const viewportHeight = mapSize.y || 800;

  // Map clusterId -> marker for O(1) lookup
  const markerByClusterId = new Map();
  for (const marker of stayMarkers) {
    if (marker && marker._clusterId) {
      markerByClusterId.set(marker._clusterId, marker);
    }
  }

  // Sort clusters descending by total stay duration (longest stay has highest priority)
  const sortedClusters = [...(stayClusters || [])].sort((a, b) => {
    const diff = (b.totalDurationMs || 0) - (a.totalDurationMs || 0);
    if (diff !== 0) return diff;
    return (b.sampleCount || 0) - (a.sampleCount || 0);
  });

  const placedBoxes = [];
  const padX = 6;
  const padY = 4;

  for (const cluster of sortedClusters) {
    const marker = markerByClusterId.get(cluster.id);
    if (!marker) continue;
    const tooltip = marker.getTooltip ? marker.getTooltip() : null;
    if (!tooltip) continue;
    const el = tooltip.getElement ? tooltip.getElement() : null;
    if (!el) continue;

    if (!map.latLngToContainerPoint) {
      el.style.display = "block";
      continue;
    }

    const pt = map.latLngToContainerPoint(cluster.point);
    if (
      !pt ||
      pt.x < -80 ||
      pt.y < -40 ||
      pt.x > viewportWidth + 80 ||
      pt.y > viewportHeight + 40
    ) {
      el.style.display = "none";
      continue;
    }

    // Measure or estimate label dimensions in pixels
    if (!marker._labelWidth || !marker._labelHeight) {
      const text = marker._labelText || el.textContent || "Aufenthalt";
      const measuredW = el.offsetWidth;
      const measuredH = el.offsetHeight;
      if (measuredW > 10 && measuredH > 8) {
        marker._labelWidth = measuredW;
        marker._labelHeight = measuredH;
      } else {
        marker._labelWidth = Math.min(240, Math.max(52, text.length * 6.6 + 20));
        marker._labelHeight = 24;
      }
    }

    const halfW = marker._labelWidth / 2;
    const labelH = marker._labelHeight;
    // Tooltip is anchored above the marker with offset [0, -8]
    const candidateBox = {
      left: pt.x - halfW - padX,
      right: pt.x + halfW + padX,
      top: pt.y - 10 - labelH - padY,
      bottom: pt.y + 4 + padY,
    };

    let hasCollision = false;
    for (let i = 0; i < placedBoxes.length; i += 1) {
      if (boxesOverlap(candidateBox, placedBoxes[i])) {
        hasCollision = true;
        break;
      }
    }

    if (hasCollision) {
      el.style.display = "none";
    } else {
      el.style.display = "block";
      placedBoxes.push(candidateBox);
    }
  }
};

export const BASEMAP_PROVIDERS = {
  local_osm: {
    name: "OpenStreetMap - HA Cache",
    url: "/api/zeitachse/tiles/{z}/{x}/{y}.png",
    options: {
      maxZoom: 19,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
    },
  },
  osm_de: {
    name: "OpenStreetMap - DE",
    url: "https://tile.openstreetmap.de/{z}/{x}/{y}.png",
    options: {
      maxZoom: 19,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
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
    name: "OpenStreetMap - Direkt",
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    options: {
      maxZoom: 19,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
    },
  },
};

export const setupTileLayer = (map, config = {}) => {
  if (!map || !window.L) return null;

  let activeProviderKey = config.provider || "local_osm";
  let activeUrl = config.url;
  let activeToken = config.tileToken || "";
  const activeAttribution = config.attribution;

  const getProviderConfig = (key) => {
    return BASEMAP_PROVIDERS[key] || BASEMAP_PROVIDERS.local_osm;
  };

  const resolveTileUrl = (providerKey, customUrl, token) => {
    const provider = getProviderConfig(providerKey);
    let base = providerKey === "custom" && customUrl ? customUrl : provider.url;
    if (providerKey === "local_osm" && token && base.startsWith("/api/zeitachse/tiles/")) {
      const sep = base.includes("?") ? "&" : "?";
      base = `${base}${sep}token=${encodeURIComponent(token)}`;
    }
    return base;
  };

  const createLayer = (providerKey, customUrl, token) => {
    const provider = getProviderConfig(providerKey);
    const tileUrl = resolveTileUrl(providerKey, customUrl, token);
    const tileOptions = {
      attribution: activeAttribution || provider.options.attribution,
      maxZoom: provider.options.maxZoom || 19,
      subdomains: provider.options.subdomains || "abc",
      referrerPolicy: "origin",
      updateWhenIdle: false,
      keepBuffer: 3,
    };
    const layer = window.L.tileLayer(tileUrl, tileOptions).addTo(map);

    let consecutiveErrors = 0;
    layer.on("tileload", () => {
      consecutiveErrors = 0;
    });
    layer.on("tileerror", () => {
      consecutiveErrors += 1;
      if (
        consecutiveErrors >= 8 &&
        activeProviderKey !== "local_osm" &&
        activeProviderKey !== "esri_street" &&
        !activeUrl
      ) {
        console.warn("[zeitachse] External tile layer failed repeatedly, falling back to local_osm cache...");
        consecutiveErrors = 0;
        map.removeLayer(layer);
        const fallback = BASEMAP_PROVIDERS.local_osm;
        tileLayer = window.L.tileLayer(resolveTileUrl("local_osm", null, activeToken), {
          attribution: fallback.options.attribution,
          maxZoom: fallback.options.maxZoom,
        }).addTo(map);
      }
    });
    return layer;
  };

  let tileLayer = createLayer(activeProviderKey, activeUrl, activeToken);

  return {
    get tileLayer() {
      return tileLayer;
    },
    setProvider(newKey, newUrl = null, newToken = null) {
      activeProviderKey = newKey || activeProviderKey;
      activeUrl = newUrl;
      if (newToken !== null) {
        activeToken = newToken;
      }
      if (tileLayer) {
        map.removeLayer(tileLayer);
      }
      tileLayer = createLayer(activeProviderKey, activeUrl, activeToken);
      return tileLayer;
    },
  };
};
