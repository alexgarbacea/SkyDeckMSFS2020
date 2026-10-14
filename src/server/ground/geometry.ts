// Flat-earth helpers for airport-sized distances (metres), and runway geometry.
import type { AirportDetails } from '../../shared/types.js';
import { normalizeDeg } from '../../shared/geo.js';

const M_PER_DEG = 111_320;

export interface LocalFrame {
  lat: number;
  lon: number;
  cosLat: number;
}

export const frameAt = (lat: number, lon: number): LocalFrame => ({ lat, lon, cosLat: Math.cos((lat * Math.PI) / 180) });

/** East (x) and north (y) metres from the frame origin. */
export function toLocal(f: LocalFrame, lat: number, lon: number): { x: number; y: number } {
  return { x: (lon - f.lon) * M_PER_DEG * f.cosLat, y: (lat - f.lat) * M_PER_DEG };
}

export function fromLocal(f: LocalFrame, x: number, y: number): { lat: number; lon: number } {
  return { lat: f.lat + y / M_PER_DEG, lon: f.lon + x / (M_PER_DEG * f.cosLat) };
}

export function metresBetween(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const f = frameAt(lat1, lon1);
  const p = toLocal(f, lat2, lon2);
  return Math.hypot(p.x, p.y);
}

/** True course (degrees) of a local vector. */
export const courseOf = (dx: number, dy: number) => normalizeDeg((Math.atan2(dx, dy) * 180) / Math.PI);

export interface RunwayGeom {
  /** Both ends, e.g. "09/27". */
  name: string;
  idents: [string, string];
  /** Threshold of each end. */
  ends: [{ lat: number; lon: number }, { lat: number; lon: number }];
  lengthM: number;
  halfWidthM: number;
}

/** Runways with usable coordinates for both ends. */
export function runwayGeoms(airport: Pick<AirportDetails, 'runways'>): RunwayGeom[] {
  const out: RunwayGeom[] = [];
  for (const r of airport.runways) {
    const [a, b] = r.ends;
    if (a.lat == null || a.lon == null || b.lat == null || b.lon == null) continue;
    const lengthM = metresBetween(a.lat, a.lon, b.lat, b.lon);
    if (lengthM < 50) continue;
    out.push({
      name: [a.ident, b.ident].filter(Boolean).join('/'),
      idents: [a.ident, b.ident],
      ends: [{ lat: a.lat, lon: a.lon }, { lat: b.lat, lon: b.lon }],
      lengthM,
      halfWidthM: ((r.widthFt ?? 100) * 0.3048) / 2,
    });
  }
  return out;
}

/**
 * Where a point is relative to a runway: `along` metres from the threshold of `fromEnd` towards the other end,
 * `lateral` metres from the centre line (always positive).
 */
export function runwayFrame(rw: RunwayGeom, lat: number, lon: number, fromEnd: 0 | 1 = 0): { along: number; lateral: number } {
  const start = rw.ends[fromEnd];
  const end = rw.ends[fromEnd === 0 ? 1 : 0];
  const f = frameAt(start.lat, start.lon);
  const e = toLocal(f, end.lat, end.lon);
  const p = toLocal(f, lat, lon);
  const len = Math.hypot(e.x, e.y) || 1;
  const ux = e.x / len;
  const uy = e.y / len;
  return { along: p.x * ux + p.y * uy, lateral: Math.abs(p.x * uy - p.y * ux) };
}

/** The runway a point is on (inside the paved rectangle plus `marginM`), if any. */
export function runwayAt(runways: RunwayGeom[], lat: number, lon: number, marginM = 0): RunwayGeom | null {
  for (const rw of runways) {
    const { along, lateral } = runwayFrame(rw, lat, lon);
    if (along >= -marginM && along <= rw.lengthM + marginM && lateral <= rw.halfWidthM + marginM) return rw;
  }
  return null;
}

/** Finds the runway and end for an identifier like "27" or "09L". */
export function runwayEnd(runways: RunwayGeom[], ident: string): { rw: RunwayGeom; end: 0 | 1 } | null {
  const want = ident.toUpperCase().replace(/^RW/, '');
  for (const rw of runways) {
    const i = rw.idents.findIndex((x) => x.toUpperCase() === want);
    if (i >= 0) return { rw, end: i as 0 | 1 };
  }
  return null;
}

/** True course of a runway end (pointing down the runway from its threshold). */
export function runwayCourse(rw: RunwayGeom, end: 0 | 1): number {
  const a = rw.ends[end];
  const b = rw.ends[end === 0 ? 1 : 0];
  const f = frameAt(a.lat, a.lon);
  const p = toLocal(f, b.lat, b.lon);
  return courseOf(p.x, p.y);
}
