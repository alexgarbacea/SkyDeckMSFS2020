// Offline navigation data (OurAirports) used for search, map overlays and airport info.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { AirportDetails, AirportSummary, NavaidSummary, Runway, SearchResult } from '../shared/types.js';
import { distanceNm } from '../shared/geo.js';
import { NAVDATA_DIR } from './paths.js';

type AirportRow = [string, string, string, string, number, number, number | null, 'L' | 'M' | 'S' | 'W', string];
type RunwayRow = [string, string, number | null, number | null, string, number | null, number | null, number | null, number | null, number | null, number | null, number | null, number | null, 0 | 1];
type FreqRow = [string, string, number];
type NavaidRow = [string, string, string, number | null, number, number, string];

const SIZE = { L: 'large', M: 'medium', S: 'small', W: 'seaplane' } as const;
const SIZE_RANK = { large: 0, medium: 1, small: 2, seaplane: 3 } as const;

let airports: AirportSummary[] = [];
let byIdent = new Map<string, AirportSummary>();
let runways: Record<string, RunwayRow[]> = {};
let freqs: Record<string, FreqRow[]> = {};
let navaids: NavaidSummary[] = [];
let loaded = false;

export async function loadNavData(): Promise<{ airports: number; navaids: number }> {
  const read = async <T>(name: string): Promise<T> => JSON.parse(await readFile(path.join(NAVDATA_DIR, name), 'utf8')) as T;
  const [a, r, f, n] = await Promise.all([
    read<AirportRow[]>('airports.json'),
    read<Record<string, RunwayRow[]>>('runways.json'),
    read<Record<string, FreqRow[]>>('frequencies.json'),
    read<NavaidRow[]>('navaids.json'),
  ]);
  airports = a.map(([ident, name, city, country, lat, lon, elevFt, type, iata]) => ({
    ident, name, city, country, lat, lon, elevFt, size: SIZE[type], ...(iata ? { iata } : {}),
  }));
  byIdent = new Map();
  // Prefer the bigger airport when two share an identifier.
  for (const ap of airports) {
    const existing = byIdent.get(ap.ident);
    if (!existing || SIZE_RANK[ap.size] < SIZE_RANK[existing.size]) byIdent.set(ap.ident, ap);
  }
  runways = r;
  freqs = f;
  navaids = n.map(([ident, name, type, freqKhz, lat, lon, country]) => ({ ident, name, type, freqKhz, lat, lon, country }));
  loaded = true;
  return { airports: airports.length, navaids: navaids.length };
}

export const navDataFile = (name: 'airports.json' | 'navaids.json') => path.join(NAVDATA_DIR, name);

export function isNavDataLoaded() {
  return loaded;
}

export function getAirport(ident: string): AirportSummary | undefined {
  return byIdent.get(ident.toUpperCase());
}

export function findNavaid(ident: string, near?: { lat: number; lon: number }): NavaidSummary | undefined {
  const matches = navaids.filter((n) => n.ident === ident.toUpperCase());
  if (!near || matches.length < 2) return matches[0];
  return matches.sort((a, b) => distanceNm(near.lat, near.lon, a.lat, a.lon) - distanceNm(near.lat, near.lon, b.lat, b.lon))[0];
}

function offlineRunways(ident: string): Runway[] {
  return (runways[ident] ?? []).map((r) => ({
    ends: [
      { ident: r[0], lat: r[5], lon: r[6], headingTrue: r[7], elevFt: r[11] },
      { ident: r[1], lat: r[8], lon: r[9], headingTrue: r[10], elevFt: r[12] },
    ],
    lengthFt: r[2],
    widthFt: r[3],
    surface: r[4],
    lighted: r[13] === 1,
  }));
}

export function airportDetailsOffline(ident: string): AirportDetails | null {
  const ap = getAirport(ident);
  if (!ap) return null;
  return {
    ...ap,
    runways: offlineRunways(ap.ident),
    frequencies: (freqs[ap.ident] ?? []).map(([type, name, mhz]) => ({ type, name, mhz })),
    procedures: null,
    source: 'offline',
  };
}

export function search(query: string, near?: { lat: number; lon: number }, limit = 20): SearchResult[] {
  const q = query.trim().toUpperCase();
  if (q.length < 2) return [];
  const scored: Array<{ score: number; result: SearchResult }> = [];
  const dist = (lat: number, lon: number) => (near ? distanceNm(near.lat, near.lon, lat, lon) : 0);

  for (const ap of airports) {
    let score = -1;
    if (ap.ident === q) score = 1000;
    else if (ap.iata === q) score = 900;
    else if (ap.ident.startsWith(q)) score = 600;
    else if (q.length >= 3) {
      const name = ap.name.toUpperCase();
      const city = ap.city.toUpperCase();
      if (name.startsWith(q) || city.startsWith(q)) score = 400;
      else if (name.includes(q) || city.includes(q)) score = 300;
    }
    if (score < 0) continue;
    score += (3 - SIZE_RANK[ap.size]) * 30;
    if (near) score -= Math.min(100, dist(ap.lat, ap.lon) / 50);
    scored.push({ score, result: { kind: 'airport', ...ap } });
  }
  for (const n of navaids) {
    let score = -1;
    if (n.ident === q) score = 950;
    else if (n.ident.startsWith(q) && q.length >= 2) score = 500;
    else if (q.length >= 3 && n.name.toUpperCase().includes(q)) score = 250;
    if (score < 0) continue;
    if (near) score -= Math.min(200, dist(n.lat, n.lon) / 20);
    scored.push({ score, result: { kind: 'navaid', ...n } });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.result);
}

export function nearestAirports(lat: number, lon: number, count = 10, sizes: AirportSummary['size'][] = ['large', 'medium', 'small']) {
  return airports
    .filter((a) => sizes.includes(a.size) && Math.abs(a.lat - lat) < 3 && Math.abs(a.lon - lon) < 4)
    .map((a) => ({ ...a, distNm: distanceNm(lat, lon, a.lat, a.lon) }))
    .sort((a, b) => a.distNm - b.distNm)
    .slice(0, count);
}

/**
 * ICAO region codes likely to contain fixes near a point. The simulator needs the region to look up a fix,
 * and for most of the world it equals the first two letters of nearby airports' ICAO codes.
 */
export function regionsNear(lat: number, lon: number, radiusNm = 250): string[] {
  const counts = new Map<string, number>();
  for (const a of airports) {
    if (Math.abs(a.lat - lat) > 5 || Math.abs(a.lon - lon) > 7) continue;
    if (!/^[A-Z]{4}$/.test(a.ident) || a.size === 'seaplane') continue;
    if (distanceNm(lat, lon, a.lat, a.lon) > radiusNm) continue;
    const prefix = a.ident.slice(0, 2);
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }
  const regions = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p);
  // The US uses numbered regions (K1-K7) instead of "K?" prefixes.
  if (regions.some((r) => r.startsWith('K'))) regions.push('K1', 'K2', 'K3', 'K4', 'K5', 'K6', 'K7');
  return [...new Set(regions)].slice(0, 12);
}
