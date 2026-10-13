// Turns identifiers ("LGIR", "SIT", "ASTON") and route strings into flight plan waypoints.
import { randomUUID } from 'node:crypto';
import type { FlightPlan, PlanWaypoint } from '../../shared/types.js';
import { findNavaid, getAirport, regionsNear } from '../navdata.js';
import type { SimBridge } from '../bridge/types.js';

const AIRWAY = /^(?:[A-Z]{1,2}\d{1,4}[A-Z]?)$/;
const PROCEDURE = /^[A-Z]{2,5}\d[A-Z]$/;

export async function resolveIdent(
  ident: string,
  near: { lat: number; lon: number } | undefined,
  bridge: SimBridge | null,
): Promise<PlanWaypoint | null> {
  const id = ident.trim().toUpperCase();
  if (!id) return null;
  const ap = getAirport(id);
  if (ap && id.length === 4) {
    return { id: randomUUID(), ident: ap.ident, type: 'airport', lat: ap.lat, lon: ap.lon, name: ap.name, altFt: ap.elevFt };
  }
  const nav = findNavaid(id, near);
  if (nav) {
    return { id: randomUUID(), ident: nav.ident, type: nav.type.startsWith('NDB') ? 'ndb' : 'vor', lat: nav.lat, lon: nav.lon, name: nav.name };
  }
  if (bridge?.kind === 'sim' && near && /^[A-Z0-9]{2,5}$/.test(id)) {
    const fix = await bridge.findFix(id, near, regionsNear(near.lat, near.lon));
    if (fix) return { id: randomUUID(), ident: fix.ident, type: 'fix', lat: fix.lat, lon: fix.lon, region: fix.region };
  }
  if (ap) return { id: randomUUID(), ident: ap.ident, type: 'airport', lat: ap.lat, lon: ap.lon, name: ap.name, altFt: ap.elevFt };
  return null;
}

export interface RouteResult {
  plan: FlightPlan;
  skipped: string[];
}

/** Parses "LGIR DCT SIT UL53 KEA LGAV" style routes. Airways are not expanded (no airway database offline). */
export async function parseRoute(route: string, cruiseAltFt: number, bridge: SimBridge | null, start?: { lat: number; lon: number }): Promise<RouteResult> {
  const tokens = route.toUpperCase().split(/[\s,]+/).filter(Boolean);
  const waypoints: PlanWaypoint[] = [];
  const skipped: string[] = [];
  const procedures: FlightPlan['procedures'] = {};
  let near = start;

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i].replace(/\/.*$/, ''); // drop speed/level suffixes like "SIT/N0110F065"
    if (tok === 'DCT' || tok === 'SID' || tok === 'STAR') continue;
    const isLast = i === tokens.length - 1;
    if (PROCEDURE.test(tok) && !isLast) {
      if (waypoints.length === 1 && waypoints[0].type === 'airport') procedures.sid = tok;
      else procedures.star = tok;
      continue;
    }
    if (AIRWAY.test(tok) && waypoints.length > 0 && !isLast) {
      skipped.push(`${tok} (airway: add its waypoints individually)`);
      continue;
    }
    const wp = await resolveIdent(tok, near, bridge);
    if (!wp) {
      skipped.push(tok);
      continue;
    }
    waypoints.push(wp);
    near = { lat: wp.lat, lon: wp.lon };
  }
  if (waypoints.length < 2) throw new Error('The route needs at least two recognisable waypoints (for example "LGIR LGAV").');
  const first = waypoints[0];
  const last = waypoints[waypoints.length - 1];
  return {
    plan: {
      title: `${first.ident} to ${last.ident}`,
      rules: 'IFR',
      cruiseAltFt,
      waypoints,
      procedures,
      source: 'Route',
      updatedAt: Date.now(),
      sentToSimAt: null,
    },
    skipped,
  };
}
