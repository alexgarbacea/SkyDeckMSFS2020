// Imports the latest SimBrief OFP for a user (public API, no key needed).
import { randomUUID } from 'node:crypto';
import type { FlightPlan, PlanWaypoint, WaypointType } from '../../shared/types.js';

interface SimbriefFix {
  ident: string;
  name?: string;
  type: string;
  pos_lat: string;
  pos_long: string;
  altitude_feet?: string;
  via_airway?: string;
  is_sid_star?: string;
  icao_region?: string;
}

interface SimbriefOfp {
  fetch?: { status?: string };
  general?: { initial_altitude?: string; flight_number?: string; icao_airline?: string };
  origin?: { icao_code: string; name?: string; pos_lat: string; pos_long: string; elevation?: string; plan_rwy?: string };
  destination?: { icao_code: string; name?: string; pos_lat: string; pos_long: string; elevation?: string; plan_rwy?: string };
  navlog?: { fix?: SimbriefFix | SimbriefFix[] };
}

const TYPE_MAP: Record<string, WaypointType> = { wpt: 'fix', vor: 'vor', ndb: 'ndb', apt: 'airport', ltlg: 'user' };

export class SimbriefError extends Error {}

export async function fetchSimbrief(username: string): Promise<FlightPlan> {
  const user = username.trim();
  if (!user) throw new SimbriefError('Enter your SimBrief username first (Settings, or the import dialog).');
  const isId = /^\d+$/.test(user);
  const url = `https://www.simbrief.com/api/xml.fetcher.php?${isId ? 'userid' : 'username'}=${encodeURIComponent(user)}&json=1`;
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  } catch {
    throw new SimbriefError('Could not reach SimBrief. Check your internet connection.');
  }
  const ofp = (await res.json().catch(() => ({}))) as SimbriefOfp;
  if (!res.ok || !ofp.origin || !ofp.destination) {
    const status = ofp.fetch?.status ?? '';
    throw new SimbriefError(
      /user/i.test(status) ? `SimBrief does not know the user "${user}".` : `SimBrief returned no flight plan${status ? ` (${status})` : ''}. Generate one on simbrief.com first.`,
    );
  }
  return simbriefToPlan(ofp);
}

export function simbriefToPlan(ofp: SimbriefOfp): FlightPlan {
  const o = ofp.origin!;
  const d = ofp.destination!;
  const raw = ofp.navlog?.fix;
  const fixes = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter((f) => !['TOC', 'TOD'].includes(f.ident));

  // SID/STAR legs are expanded by the aircraft's own database, so only keep the fixes where they join the route.
  const sidFixes = fixes.filter((f, i) => f.is_sid_star === '1' && i < fixes.length / 2);
  const starFixes = fixes.filter((f, i) => f.is_sid_star === '1' && i >= fixes.length / 2);
  const sid = sidFixes[0]?.via_airway;
  const star = starFixes[0]?.via_airway;
  const keep = fixes.filter((f) => {
    if (f.type === 'apt' && (f.ident === o.icao_code || f.ident === d.icao_code)) return false;
    if (f.is_sid_star !== '1') return true;
    return f === sidFixes[sidFixes.length - 1] || f === starFixes[0];
  });

  const airport = (a: typeof o): PlanWaypoint => ({
    id: randomUUID(),
    ident: a.icao_code,
    type: 'airport',
    lat: Number(a.pos_lat),
    lon: Number(a.pos_long),
    name: a.name,
    altFt: Number(a.elevation ?? 0),
  });
  const waypoints: PlanWaypoint[] = [
    airport(o),
    ...keep.map((f): PlanWaypoint => ({
      id: randomUUID(),
      ident: f.ident,
      type: TYPE_MAP[f.type] ?? 'fix',
      lat: Number(f.pos_lat),
      lon: Number(f.pos_long),
      name: f.name,
      region: f.icao_region || undefined,
      airway: f.via_airway && f.via_airway !== 'DCT' && f.is_sid_star !== '1' ? f.via_airway : undefined,
      altFt: f.altitude_feet ? Number(f.altitude_feet) : null,
    })),
    airport(d),
  ];
  const flight = [ofp.general?.icao_airline, ofp.general?.flight_number].filter(Boolean).join('');
  return {
    title: `${o.icao_code} to ${d.icao_code}${flight ? ` (${flight})` : ''}`,
    rules: 'IFR',
    cruiseAltFt: Number(ofp.general?.initial_altitude ?? 0) || 10000,
    waypoints,
    procedures: {
      departureRunway: o.plan_rwy || undefined,
      sid: sid || undefined,
      star: star || undefined,
      arrivalRunway: d.plan_rwy || undefined,
    },
    source: 'SimBrief',
    updatedAt: Date.now(),
    sentToSimAt: null,
  };
}
