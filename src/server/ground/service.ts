// Keeps the taxi graphs of airports, the active taxi route and live guidance along it (progress, next turn,
// docking onto the stand).
import { EventEmitter } from 'node:events';
import type { AirportDetails, GroundLayout, GroundState, Stand, TaxiRoute, Telemetry } from '../../shared/types.js';
import { angleDiff } from '../../shared/geo.js';
import type { SimBridge } from '../bridge/types.js';
import { nearestAirports } from '../navdata.js';
import { log } from '../log.js';
import { buildGround, calibrate, findRoute, groundLayout, standAt, syntheticGround, type AirportGround, type TaxiFrom, type TaxiTarget } from './graph.js';
import { frameAt, runwayAt, runwayGeoms, toLocal } from './geometry.js';

export interface GroundDeps {
  bridge(): SimBridge | null;
  airport(ident: string): Promise<AirportDetails | null>;
}

const EMPTY: GroundState = { airport: null, runway: null, route: null, progress: null, docking: null, assignedStand: null };

export class GroundService extends EventEmitter {
  private cache = new Map<string, Promise<AirportGround | null>>();
  private loaded = new Map<string, AirportGround>();
  private route: TaxiRoute | null = null;
  private routeLocal: { pts: Array<{ x: number; y: number }>; cum: number[] } | null = null;
  private lastAlong = 0;
  private assigned: GroundState['assignedStand'] = null;
  private airport: string | null = null;
  private lastAirportCheck = 0;
  private lastEmit = 0;
  private lastJson = '';
  state: GroundState = EMPTY;

  constructor(private readonly deps: GroundDeps) {
    super();
  }

  /** The taxi graph of an airport: from the scenery, or a simple stand-in for the demo aircraft. Cached. */
  ground(ident: string): Promise<AirportGround | null> {
    const bridge = this.deps.bridge();
    if (!bridge) return Promise.resolve(null);
    const key = `${bridge.kind}:${ident.toUpperCase()}`;
    let p = this.cache.get(key);
    if (!p) {
      p = this.load(bridge, ident.toUpperCase()).catch((err) => {
        log.warn(`Could not read the taxiways of ${ident}:`, (err as Error).message);
        return null;
      });
      this.cache.set(key, p);
      void p.then((g) => {
        if (g) this.loaded.set(g.ident, g);
        else this.cache.delete(key);
      });
    }
    return p;
  }

  private async load(bridge: SimBridge, ident: string): Promise<AirportGround | null> {
    const details = await this.deps.airport(ident);
    if (!details) return null;
    if (bridge.kind === 'demo') return syntheticGround(ident, details);
    const raw = await bridge.airportGround(ident);
    if (!raw) return null;
    const cal = calibrate(raw, runwayGeoms(details));
    const g = buildGround(ident, raw, details, cal.orientation);
    log.info(`Taxiways of ${ident}: ${g.nodes.length} points, ${g.edges.length} segments, ${g.stands.length} stands${Number.isFinite(cal.fitM) ? ` (runway fit ${cal.fitM.toFixed(1)} m${cal.orientation ? `, orientation ${cal.orientation}` : ''})` : ''}.`);
    return g;
  }

  async layout(ident: string): Promise<GroundLayout | null> {
    const g = await this.ground(ident);
    return g ? groundLayout(g) : null;
  }

  /** Plans a taxi route without making it the active one. */
  async plan(ident: string, from: TaxiFrom, target: TaxiTarget): Promise<TaxiRoute | null> {
    const g = await this.ground(ident);
    return g ? findRoute(g, from, target) : null;
  }

  async standByIndex(ident: string, index: number): Promise<Stand | null> {
    const g = await this.ground(ident);
    return g?.stands[index] ?? null;
  }

  /** The stand the aircraft is on at the current airport, if the airport's taxiways are loaded. */
  standHere(lat: number, lon: number): Stand | null {
    const g = this.airport ? this.loaded.get(this.airport) : undefined;
    return g ? standAt(g, lat, lon) : null;
  }

  get activeRoute() {
    return this.route;
  }

  get assignedStand() {
    return this.assigned;
  }

  setRoute(route: TaxiRoute | null) {
    this.route = route;
    this.lastAlong = 0;
    this.routeLocal = null;
    if (route) {
      const f = frameAt(route.points[0][1], route.points[0][0]);
      const pts = route.points.map(([lon, lat]) => toLocal(f, lat, lon));
      const cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
      this.routeLocal = { pts, cum };
    }
    this.lastJson = '';
    this.emitState(true);
  }

  assignStand(airport: string, stand: Stand | null) {
    this.assigned = stand ? { airport: airport.toUpperCase(), stand } : null;
    this.lastJson = '';
    this.emitState(true);
  }

  /** Clears everything tied to a flight (route, stand), e.g. when ATC is reset. */
  reset() {
    this.assigned = null;
    this.setRoute(null);
  }

  update(t: Telemetry | null) {
    if (!t) {
      if (this.state !== EMPTY) {
        this.state = { ...EMPTY, route: this.route, assignedStand: this.assigned };
        this.emitState(true);
      }
      return;
    }
    const now = Date.now();
    const { lat, lon } = t.position;
    if (now - this.lastAirportCheck > 5000) {
      this.lastAirportCheck = now;
      const near = t.position.onGround || t.position.aglFt < 300 ? nearestAirports(lat, lon, 1)[0] : undefined;
      this.airport = near && near.distNm < 3 ? near.ident : null;
      if (this.airport) void this.ground(this.airport);
    }
    const g = this.airport ? this.loaded.get(this.airport) : undefined;
    const rw = g && t.position.onGround ? runwayAt(g.runways, lat, lon) : null;

    this.state = {
      airport: this.airport,
      runway: rw?.name ?? null,
      route: this.route,
      progress: this.progress(t),
      docking: this.docking(t),
      assignedStand: this.assigned,
    };
    this.emitState(false);
  }

  private progress(t: Telemetry): GroundState['progress'] {
    const route = this.route;
    const local = this.routeLocal;
    if (!route || !local) return null;
    const f = frameAt(route.points[0][1], route.points[0][0]);
    const p = toLocal(f, t.position.lat, t.position.lon);
    let best = { d: Infinity, along: 0 };
    const scan = (windowed: boolean) => {
      for (let i = 1; i < local.pts.length; i++) {
        if (windowed && (local.cum[i] < this.lastAlong - 100 || local.cum[i - 1] > this.lastAlong + 400)) continue;
        const a = local.pts[i - 1];
        const b = local.pts[i];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len2 = dx * dx + dy * dy || 1;
        const s = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
        const d = Math.hypot(p.x - (a.x + s * dx), p.y - (a.y + s * dy));
        if (d < best.d) best = { d, along: local.cum[i - 1] + s * Math.sqrt(len2) };
      }
    };
    scan(true);
    if (best.d > 60) scan(false);
    this.lastAlong = best.along;
    const total = local.cum[local.cum.length - 1];
    const remainingM = Math.max(0, total - best.along);
    const next = route.steps.find((s) => s.atM > best.along + 5) ?? route.steps[route.steps.length - 1] ?? null;
    const dock = route.to.kind === 'stand' ? this.docking(t) : null;
    const arrived = dock ? dock.distanceM < 6 && Math.abs(dock.lateralM) < 6 && t.speed.gs < 2 : remainingM < 40 && t.speed.gs < 3;
    return {
      remainingM: Math.round(remainingM),
      offRouteM: Math.round(best.d),
      next,
      nextInM: next ? Math.max(0, Math.round(next.atM - best.along)) : null,
      arrived,
    };
  }

  /** Guidance onto the stand the aircraft is heading to, once it is close. */
  private docking(t: Telemetry): GroundState['docking'] {
    const stand = this.route?.to.kind === 'stand' ? this.route.to.stand : this.assigned?.airport === this.airport ? this.assigned?.stand : undefined;
    if (!stand || !t.position.onGround) return null;
    const f = frameAt(stand.lat, stand.lon);
    const p = toLocal(f, t.position.lat, t.position.lon);
    if (Math.hypot(p.x, p.y) > 120) return null;
    const h = (stand.headingTrue * Math.PI) / 180;
    const ux = Math.sin(h);
    const uy = Math.cos(h);
    const along = p.x * ux + p.y * uy; // negative: still short of the stop point
    const lateral = p.x * uy - p.y * ux; // positive: right of the lead-in line
    return {
      stand: stand.name,
      distanceM: Math.round(Math.max(0, -along) * 10) / 10,
      lateralM: Math.round(lateral * 10) / 10,
      headingError: Math.round(angleDiff(t.attitude.hdgTrue, stand.headingTrue)),
    };
  }

  private emitState(force: boolean) {
    const now = Date.now();
    if (!force && now - this.lastEmit < 250) return;
    const json = JSON.stringify(this.state);
    if (!force && json === this.lastJson) return;
    if (force) this.state = { ...this.state, route: this.route, assignedStand: this.assigned };
    this.lastJson = JSON.stringify(this.state);
    this.lastEmit = now;
    this.emit('state', this.state);
  }
}
