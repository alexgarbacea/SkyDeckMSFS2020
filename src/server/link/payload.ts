// Converts a SkyDeck flight plan into the compact form SkyDeck Link applies inside the avionics.
import type { FlightPlan, WaypointType } from '../../shared/types.js';
import { parseApproachName } from '../flightplan/pln.js';

export interface LinkWaypoint {
  ident: string;
  type: WaypointType;
  region?: string;
  lat: number;
  lon: number;
}

export interface LinkPlan {
  origin?: { ident: string; runway?: string };
  departure?: { name: string; runway?: string; transition?: string };
  enroute: LinkWaypoint[];
  destination?: { ident: string; runway?: string };
  arrival?: { name: string; runway?: string; transition?: string };
  approach?: { name: string; type: number; runwayNumber: number; runwayDesignator: number; suffix: string; transition?: string };
  cruiseAltFt: number;
}

// Same numbering as the simulator's facility data (and the WT SDK's ApproachType / RunwayDesignator enums).
const APPROACH_TYPE_IDS: Record<string, number> = {
  GPS: 1, VOR: 2, NDB: 3, ILS: 4, LOC: 5, SDF: 6, LDA: 7, 'VOR/DME': 8, 'NDB/DME': 9, RNAV: 10, 'LOC BC': 11,
};
const DESIGNATOR_IDS: Record<string, number> = { '': 0, L: 1, R: 2, C: 3, W: 4, A: 5, B: 6 };

/** "6L" / "06L" / "6" -> "06L" / "06", the padded form the avionics use. */
export function normalizeRunway(runway: string | undefined): string | undefined {
  if (!runway) return undefined;
  const m = /^(\d{1,2})([LRCWAB]?)$/i.exec(runway.trim());
  return m ? m[1].padStart(2, '0') + m[2].toUpperCase() : runway.trim().toUpperCase();
}

export function toLinkPlan(plan: FlightPlan): LinkPlan {
  const wps = plan.waypoints.filter((w) => !w.procedure);
  const p = plan.procedures;
  const first = wps[0];
  const last = wps.length > 1 ? wps[wps.length - 1] : undefined;
  const origin = first?.type === 'airport' ? first : undefined;
  const destination = last?.type === 'airport' ? last : undefined;
  const enroute = wps.slice(origin ? 1 : 0, destination ? -1 : undefined).map((w) => ({
    ident: w.ident.toUpperCase(),
    type: w.type,
    region: w.region,
    lat: w.lat,
    lon: w.lon,
  }));

  const out: LinkPlan = { enroute, cruiseAltFt: plan.cruiseAltFt };
  if (origin) {
    out.origin = { ident: origin.ident, runway: normalizeRunway(p.departureRunway) };
    if (p.sid) out.departure = { name: p.sid, runway: normalizeRunway(p.departureRunway), transition: p.sidTransition };
  }
  if (destination) {
    out.destination = { ident: destination.ident, runway: normalizeRunway(p.arrivalRunway) };
    if (p.star) out.arrival = { name: p.star, runway: normalizeRunway(p.arrivalRunway), transition: p.starTransition };
    const a = p.approach ? parseApproachName(p.approach) : null;
    if (a) {
      const rwy = /^(\d{1,2})([LRCWAB]?)$/.exec(a.runway);
      out.approach = {
        name: p.approach!,
        type: APPROACH_TYPE_IDS[a.type] ?? 0,
        runwayNumber: rwy ? Number(rwy[1]) : 0,
        runwayDesignator: DESIGNATOR_IDS[rwy?.[2] ?? ''] ?? 0,
        suffix: a.suffix ?? '',
      };
    }
  }
  return out;
}
