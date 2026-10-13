// Flight plan editing helpers used by the planner, the map and the command bar.
import type { FlightPlan, PlanWaypoint, SearchResult, Telemetry } from '../../shared/types';
import { bearingDeg, distanceNm } from '../../shared/geo';
import { api } from './api';
import { getState } from './store';

export interface Leg {
  from: PlanWaypoint;
  to: PlanWaypoint;
  distNm: number;
  courseTrue: number;
  cumulativeNm: number;
}

export function planLegs(plan: FlightPlan | null): Leg[] {
  if (!plan) return [];
  const legs: Leg[] = [];
  let cum = 0;
  for (let i = 1; i < plan.waypoints.length; i++) {
    const a = plan.waypoints[i - 1];
    const b = plan.waypoints[i];
    const d = distanceNm(a.lat, a.lon, b.lat, b.lon);
    cum += d;
    legs.push({ from: a, to: b, distNm: d, courseTrue: bearingDeg(a.lat, a.lon, b.lat, b.lon), cumulativeNm: cum });
  }
  return legs;
}

export const planDistance = (plan: FlightPlan | null) => planLegs(plan).at(-1)?.cumulativeNm ?? 0;

/** The route as loaded into the aircraft: with SID/STAR/approach fixes when the server could expand them. */
export function routeOf(plan: FlightPlan | null): PlanWaypoint[] {
  if (!plan) return [];
  return plan.expanded?.length ? plan.expanded : plan.waypoints;
}

/** Index in `list` of the waypoint the aircraft's GPS is flying to, if it can be matched. */
export function activeIndexIn(list: PlanWaypoint[], t: Telemetry | null): number {
  if (!t?.gps.hasPlan || !t.gps.nextId) return -1;
  const id = t.gps.nextId.toUpperCase();
  let best = -1;
  let bestD = Infinity;
  list.forEach((w, i) => {
    if (w.ident.toUpperCase() !== id) return;
    const d = distanceNm(w.lat, w.lon, t.gps.nextLat, t.gps.nextLon);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return bestD < 2 ? best : -1;
}

/** Index in the plan's own waypoint list (what the planner table shows) of the active waypoint. */
export function activeIndex(plan: FlightPlan | null, t: Telemetry | null): number {
  return plan ? activeIndexIn(plan.waypoints, t) : -1;
}

/** Distance still to fly along the route from the aircraft's position. */
export function remainingNm(plan: FlightPlan | null, t: Telemetry | null): number | null {
  const route = routeOf(plan);
  const idx = activeIndexIn(route, t);
  if (!t || idx < 0) return null;
  let d = distanceNm(t.position.lat, t.position.lon, route[idx].lat, route[idx].lon);
  for (let i = idx; i < route.length - 1; i++) d += distanceNm(route[i].lat, route[i].lon, route[i + 1].lat, route[i + 1].lon);
  return d;
}

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

export function waypointFromResult(r: SearchResult): PlanWaypoint {
  if (r.kind === 'airport') return { id: uid(), ident: r.ident, type: 'airport', lat: r.lat, lon: r.lon, name: r.name, altFt: r.elevFt };
  if (r.kind === 'navaid') return { id: uid(), ident: r.ident, type: r.type.startsWith('NDB') ? 'ndb' : 'vor', lat: r.lat, lon: r.lon, name: r.name };
  return { id: uid(), ident: r.ident, type: 'fix', lat: r.lat, lon: r.lon, region: r.region };
}

let userPointCounter = 1;
export function userWaypoint(lat: number, lon: number): PlanWaypoint {
  return { id: uid(), ident: `USR${String(userPointCounter++).padStart(2, '0')}`, type: 'user', lat, lon };
}

export function emptyPlan(): FlightPlan {
  return { title: '', rules: 'IFR', cruiseAltFt: 8000, waypoints: [], procedures: {}, source: 'SkyDeck', updatedAt: Date.now(), sentToSimAt: null };
}

function withTitle(plan: FlightPlan): FlightPlan {
  const w = plan.waypoints;
  return { ...plan, title: w.length >= 2 ? `${w[0].ident} to ${w[w.length - 1].ident}` : plan.title };
}

/** Saves a modified plan (optimistically updates the UI). */
export function savePlan(plan: FlightPlan | null) {
  return api.savePlan(plan ? withTitle(plan) : null);
}

export function current(): FlightPlan {
  return getState().plan ?? emptyPlan();
}

export function setDeparture(wp: PlanWaypoint) {
  const p = current();
  const w = [...p.waypoints];
  if (w.length && w[0].type === 'airport' && w.length > 1) w[0] = wp;
  else w.unshift(wp);
  return savePlan({ ...p, waypoints: w, procedures: { ...p.procedures, departureRunway: undefined, sid: undefined, sidTransition: undefined } });
}

export function setDestination(wp: PlanWaypoint) {
  const p = current();
  const w = [...p.waypoints];
  const last = w[w.length - 1];
  if (w.length > 1 && last.type === 'airport') w[w.length - 1] = wp;
  else w.push(wp);
  return savePlan({ ...p, waypoints: w, procedures: { ...p.procedures, arrivalRunway: undefined, star: undefined, starTransition: undefined, approach: undefined } });
}

/** Inserts a waypoint before the destination (or at the end when there is no destination airport yet). */
export function insertWaypoint(wp: PlanWaypoint, index?: number) {
  const p = current();
  const w = [...p.waypoints];
  const lastIsDest = w.length > 1 && w[w.length - 1].type === 'airport';
  const at = index ?? (lastIsDest ? w.length - 1 : w.length);
  w.splice(at, 0, wp);
  return savePlan({ ...p, waypoints: w });
}

/** Inserts a waypoint into the leg it is closest to, so map clicks land in a sensible place. */
export function insertNearest(wp: PlanWaypoint) {
  const p = current();
  const w = p.waypoints;
  if (w.length < 2) return insertWaypoint(wp);
  let best = w.length - 1;
  let bestExtra = Infinity;
  for (let i = 1; i < w.length; i++) {
    const a = w[i - 1];
    const b = w[i];
    const extra = distanceNm(a.lat, a.lon, wp.lat, wp.lon) + distanceNm(wp.lat, wp.lon, b.lat, b.lon) - distanceNm(a.lat, a.lon, b.lat, b.lon);
    if (extra < bestExtra) {
      bestExtra = extra;
      best = i;
    }
  }
  return insertWaypoint(wp, best);
}

export function removeWaypoint(id: string) {
  const p = current();
  return savePlan({ ...p, waypoints: p.waypoints.filter((w) => w.id !== id) });
}

export function moveWaypoint(from: number, to: number) {
  const p = current();
  const w = [...p.waypoints];
  const [item] = w.splice(from, 1);
  w.splice(to, 0, item);
  return savePlan({ ...p, waypoints: w });
}

export function updateWaypoint(id: string, patch: Partial<PlanWaypoint>) {
  const p = current();
  return savePlan({ ...p, waypoints: p.waypoints.map((w) => (w.id === id ? { ...w, ...patch } : w)) });
}

export function updatePlan(patch: Partial<FlightPlan>) {
  return savePlan({ ...current(), ...patch });
}

export function routeString(plan: FlightPlan): string {
  const parts: string[] = [];
  plan.waypoints.forEach((w, i) => {
    if (i === 1 && plan.procedures.sid) parts.push(plan.procedures.sid);
    if (i === plan.waypoints.length - 1 && i > 0 && plan.procedures.star) parts.push(plan.procedures.star);
    if (w.airway && i > 0) parts.push(w.airway);
    parts.push(w.type === 'user' ? `${w.lat.toFixed(3)},${w.lon.toFixed(3)}` : w.ident);
  });
  return parts.join(' ');
}
