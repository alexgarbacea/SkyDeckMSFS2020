// The current flight plan, shared by every connected browser and persisted between sessions.
import { EventEmitter } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FlightPlan, PlanWaypoint, Telemetry } from '../../shared/types.js';
import { APP_DIR, PLANS_DIR } from '../config.js';
import { buildPln } from './pln.js';

const PLAN_FILE = path.join(APP_DIR, 'current-plan.json');

export class PlanStore extends EventEmitter {
  plan: FlightPlan | null = null;

  async load() {
    try {
      this.plan = JSON.parse(await readFile(PLAN_FILE, 'utf8')) as FlightPlan;
    } catch {
      this.plan = null;
    }
  }

  async set(plan: FlightPlan | null, opts: { sent?: boolean } = {}) {
    if (plan) {
      plan.waypoints = plan.waypoints.map((w) => ({ ...w, id: w.id || randomUUID() }));
      plan.updatedAt = Date.now();
      plan.sentToSimAt = opts.sent ? plan.updatedAt : null;
      plan.expanded = null; // recomputed by the server from the simulator database
    }
    this.plan = plan;
    await mkdir(APP_DIR, { recursive: true });
    await writeFile(PLAN_FILE, JSON.stringify(plan));
    this.emit('change', plan);
  }

  /** Stores the procedure-expanded route, unless the plan changed in the meantime. */
  async setExpanded(revision: number, expanded: PlanWaypoint[] | null) {
    if (!this.plan || this.plan.updatedAt !== revision) return;
    this.plan.expanded = expanded;
    await writeFile(PLAN_FILE, JSON.stringify(this.plan));
    this.emit('change', this.plan);
  }

  async markSent() {
    if (!this.plan) return;
    this.plan.sentToSimAt = Date.now();
    await writeFile(PLAN_FILE, JSON.stringify(this.plan));
    this.emit('change', this.plan);
  }

  /** Writes the plan as a .PLN file the simulator can load, returning its path. */
  async writePln(plan: FlightPlan): Promise<string> {
    await mkdir(PLANS_DIR, { recursive: true });
    const file = path.join(PLANS_DIR, 'SkyDeck.pln');
    await writeFile(file, buildPln(plan), 'utf8');
    return file;
  }
}

/**
 * Builds a "direct to" version of a plan: a user waypoint at the aircraft's present position followed by the target
 * and, when the target was already in the plan, everything after it.
 */
export function directToPlan(plan: FlightPlan | null, target: PlanWaypoint, t: Telemetry): FlightPlan {
  const ppos: PlanWaypoint = {
    id: randomUUID(),
    ident: 'PPOS',
    type: 'user',
    lat: t.position.lat,
    lon: t.position.lon,
    altFt: Math.round(t.position.altFt),
  };
  if (!plan || plan.waypoints.length < 2) {
    return {
      title: `Direct ${target.ident}`,
      rules: 'IFR',
      cruiseAltFt: Math.max(1000, Math.round(t.position.altFt / 500) * 500),
      waypoints: [ppos, target],
      procedures: {},
      source: 'Direct-to',
      updatedAt: Date.now(),
      sentToSimAt: null,
    };
  }
  const wps = plan.waypoints;
  const idx = wps.findIndex((w) => w.id === target.id || (w.ident === target.ident && Math.abs(w.lat - target.lat) < 0.01 && Math.abs(w.lon - target.lon) < 0.01));
  const departure = wps[0];
  const destination = wps[wps.length - 1];
  // Off-plan targets keep only the destination after them, like a GPS "direct to" does.
  const rest = idx >= 0 ? wps.slice(idx) : destination.type === 'airport' ? [target, destination] : [target];
  // Keep the departure airport first: MSFS expects plans to start at an airport.
  const head = departure.type === 'airport' && idx !== 0 ? [departure] : [];
  return {
    ...plan,
    // A SID no longer applies once you are flying direct to somewhere.
    procedures: { ...plan.procedures, sid: undefined, sidTransition: undefined },
    waypoints: [...head, ppos, ...rest.filter((w) => w.ident !== 'PPOS' && !w.procedure)],
    source: plan.source.endsWith('(direct-to)') ? plan.source : `${plan.source} (direct-to)`,
  };
}
