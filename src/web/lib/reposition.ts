// Computes where to put the aircraft for "move to runway" and "move to final" actions.
import type { AirportDetails, Command, RunwayEnd } from '../../shared/types';
import { destinationPoint, normalizeDeg } from '../../shared/geo';

export interface RunwayOption {
  ident: string;
  end: RunwayEnd;
  lengthFt: number | null;
}

/** All landable runway directions at an airport, e.g. 09, 27, 12, 30. */
export function runwayOptions(airport: AirportDetails): RunwayOption[] {
  const out: RunwayOption[] = [];
  for (const rw of airport.runways) {
    for (const end of rw.ends) {
      if (end.ident && end.lat != null && end.lon != null && end.headingTrue != null) out.push({ ident: end.ident, end, lengthFt: rw.lengthFt });
    }
  }
  return out.sort((a, b) => a.ident.localeCompare(b.ident, undefined, { numeric: true }));
}

/** Picks the runway most aligned with the wind (or the longest one). */
export function bestRunway(options: RunwayOption[], windDir?: number): RunwayOption | undefined {
  if (!options.length) return undefined;
  if (windDir == null) return [...options].sort((a, b) => (b.lengthFt ?? 0) - (a.lengthFt ?? 0))[0];
  return [...options].sort((a, b) => Math.cos(((b.end.headingTrue! - windDir) * Math.PI) / 180) - Math.cos(((a.end.headingTrue! - windDir) * Math.PI) / 180))[0];
}

/**
 * Builds a teleport command. finalNm = 0 lines up on the runway threshold; otherwise the aircraft is placed
 * on a 3° approach path that many miles out, flying towards the runway.
 */
export function repositionCommand(airport: AirportDetails, runway: RunwayOption, finalNm: number, approachKts: number): Command {
  const end = runway.end;
  const hdg = normalizeDeg(end.headingTrue!);
  const elev = end.elevFt ?? airport.elevFt ?? 0;
  if (finalNm <= 0) {
    // Slightly down the runway so the aircraft is past the threshold markings.
    const p = destinationPoint(end.lat!, end.lon!, hdg, 0.04);
    return { type: 'teleport', lat: p.lat, lon: p.lon, altFt: elev, headingTrue: hdg, kts: 0, onGround: true };
  }
  const p = destinationPoint(end.lat!, end.lon!, normalizeDeg(hdg + 180), finalNm);
  // 3° glide path ≈ 318 ft per nautical mile, plus threshold crossing height.
  const altFt = Math.round(elev + 50 + finalNm * 318);
  return { type: 'teleport', lat: p.lat, lon: p.lon, altFt, headingTrue: hdg, kts: approachKts, onGround: false };
}
