// Small great-circle helpers. Distances in nautical miles, angles in degrees.

const R_NM = 3440.065;
const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

export function normalizeDeg(deg: number): number {
  const d = deg % 360;
  return d < 0 ? d + 360 : d;
}

/** Heading shown to pilots: 1..360, never 0. */
export function displayHeading(deg: number): number {
  const d = Math.round(normalizeDeg(deg));
  return d === 0 ? 360 : d;
}

export function distanceNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Initial true course from point 1 to point 2. */
export function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  return normalizeDeg(toDeg(Math.atan2(y, x)));
}

/** Point reached travelling `distNm` from a start point on a true course. */
export function destinationPoint(lat: number, lon: number, courseDeg: number, distNm: number): { lat: number; lon: number } {
  const d = distNm / R_NM;
  const c = toRad(courseDeg);
  const la1 = toRad(lat);
  const lo1 = toRad(lon);
  const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(c));
  const lo2 = lo1 + Math.atan2(Math.sin(c) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * Math.sin(la2));
  return { lat: toDeg(la2), lon: ((toDeg(lo2) + 540) % 360) - 180 };
}

/** Signed smallest difference a - b in degrees, in (-180, 180]. */
export function angleDiff(a: number, b: number): number {
  let d = normalizeDeg(a) - normalizeDeg(b);
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/** Points along the great circle, for drawing curved route lines. */
export function greatCirclePoints(lat1: number, lon1: number, lat2: number, lon2: number, segmentNm = 50): Array<[number, number]> {
  const dist = distanceNm(lat1, lon1, lat2, lon2);
  const steps = Math.max(1, Math.ceil(dist / segmentNm));
  const course = bearingDeg(lat1, lon1, lat2, lon2);
  if (steps === 1) return [[lon1, lat1], [lon2, lat2]];
  const pts: Array<[number, number]> = [[lon1, lat1]];
  // Recompute the course each step from the current point so the line follows the great circle.
  let cur = { lat: lat1, lon: lon1 };
  for (let i = 1; i < steps; i++) {
    const remaining = distanceNm(cur.lat, cur.lon, lat2, lon2);
    const step = remaining / (steps - i + 1);
    cur = destinationPoint(cur.lat, cur.lon, i === 1 ? course : bearingDeg(cur.lat, cur.lon, lat2, lon2), step);
    pts.push([cur.lon, cur.lat]);
  }
  pts.push([lon2, lat2]);
  return pts;
}
