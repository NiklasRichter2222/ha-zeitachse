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
