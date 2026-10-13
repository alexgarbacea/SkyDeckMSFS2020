// Expands SIDs, STARs and approaches into the fixes MSFS expects to find in a flight plan file.
import { randomUUID } from 'node:crypto';
import type { FlightPlan, PlanWaypoint, WaypointType } from '../../shared/types.js';

export interface LegFix {
  ident: string;
  region: string;
  type: WaypointType;
  lat: number;
  lon: number;
}

export interface ProcedureLegs {
  /** Legs flown from a specific runway (SID) or to a specific runway (STAR), keyed by runway ("23", "34L"). */
  runways: Record<string, LegFix[]>;
  /** Legs every variant shares. For approaches: the final approach. */
  common: LegFix[];
  /** Named transitions: enroute transitions (SID/STAR) or approach transitions (keyed by IAF). */
  transitions: Record<string, LegFix[]>;
}

export interface AirportProcedureLegs {
  departures: Record<string, ProcedureLegs>;
  arrivals: Record<string, ProcedureLegs>;
  approaches: Record<string, ProcedureLegs>;
}

export const emptyProcedure = (): ProcedureLegs => ({ runways: {}, common: [], transitions: {} });

/** Runway legs for "23" also match a procedure stored for "23" with or without a designator. */
function runwayLegs(p: ProcedureLegs, runway?: string): LegFix[] {
  if (!runway) return [];
  const key = runway.toUpperCase();
  return p.runways[key] ?? p.runways[key.replace(/^0/, '')] ?? p.runways[key.padStart(2, '0')] ?? Object.entries(p.runways).find(([k]) => k.startsWith(key.slice(0, 2)))?.[1] ?? [];
}

function dedupe(fixes: LegFix[]): LegFix[] {
  return fixes.filter((f, i) => f.ident && (i === 0 || fixes[i - 1].ident !== f.ident));
}

function toWaypoints(fixes: LegFix[], procedure: NonNullable<PlanWaypoint['procedure']>, altFt: number | null): PlanWaypoint[] {
  return dedupe(fixes).map((f) => ({ id: randomUUID(), ident: f.ident, type: f.type, lat: f.lat, lon: f.lon, region: f.region || undefined, altFt, procedure }));
}

export function sidFixes(p: ProcedureLegs, runway?: string, transition?: string): LegFix[] {
  return [...runwayLegs(p, runway), ...p.common, ...(transition ? p.transitions[transition] ?? [] : [])];
}

export function starFixes(p: ProcedureLegs, runway?: string, transition?: string): LegFix[] {
  return [...(transition ? p.transitions[transition] ?? [] : []), ...p.common, ...runwayLegs(p, runway)];
}

export function approachFixes(p: ProcedureLegs, transition?: string): LegFix[] {
  return [...(transition ? p.transitions[transition] ?? [] : []), ...p.common];
}

/**
 * Inserts procedure fixes around the enroute part of the plan. Enroute waypoints that duplicate the first/last
 * procedure fix (e.g. the SID's exit fix) are dropped so the route does not double back.
 */
export function expandPlan(plan: FlightPlan, dep: AirportProcedureLegs | null, arr: AirportProcedureLegs | null): PlanWaypoint[] {
  const wps = plan.waypoints;
  if (wps.length < 2) return wps;
  const first = wps[0];
  const last = wps[wps.length - 1];
  let enroute = wps.slice(1, -1).filter((w) => !w.procedure);
  const pr = plan.procedures;

  let sid: PlanWaypoint[] = [];
  const sidData = pr.sid && dep ? dep.departures[pr.sid] : undefined;
  if (sidData) {
    sid = toWaypoints(sidFixes(sidData, pr.departureRunway, pr.sidTransition), { kind: 'sid', name: pr.sid!, runway: pr.departureRunway }, null);
    const exit = sid[sid.length - 1]?.ident;
    if (exit && enroute[0]?.ident === exit) enroute = enroute.slice(1);
  }

  let star: PlanWaypoint[] = [];
  const starData = pr.star && arr ? arr.arrivals[pr.star] : undefined;
  if (starData) {
    star = toWaypoints(starFixes(starData, pr.arrivalRunway, pr.starTransition), { kind: 'star', name: pr.star!, runway: pr.arrivalRunway }, null);
    const entry = star[0]?.ident;
    if (entry && enroute[enroute.length - 1]?.ident === entry) enroute = enroute.slice(0, -1);
  }

  let approach: PlanWaypoint[] = [];
  const appData = pr.approach && arr ? arr.approaches[pr.approach] : undefined;
  if (appData) {
    approach = toWaypoints(approachFixes(appData), { kind: 'approach', name: pr.approach!, runway: pr.arrivalRunway }, null);
    // Where the STAR ends at the approach's first fix, fly it once.
    if (star.length && approach.length && star[star.length - 1].ident === approach[0].ident) star = star.slice(0, -1);
  }

  return [first, ...sid, ...enroute, ...star, ...approach, last];
}
