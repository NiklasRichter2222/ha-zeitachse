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
