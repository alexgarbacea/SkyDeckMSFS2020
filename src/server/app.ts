// HTTP API + WebSocket hub. Everything the browser UI needs goes through here.
import http from 'node:http';
import os from 'node:os';
import { readFile } from 'node:fs/promises';
import express, { type NextFunction, type Request, type Response } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import type { AirportDetails, ClientMessage, FlightPlan, PlanWaypoint, SearchResult, ServerMessage, ServerStatus, Settings } from '../shared/types.js';
import { BridgeManager } from './bridge/manager.js';
import { CommandError } from './bridge/types.js';
import { getSettings, updateSettings } from './config.js';
import { customFlightPlanPath, detectInstalls, inspectInstall, isDirectory, listFolders, readPackagesPath } from './msfs.js';
import { airportDetailsOffline, navDataFile, nearestAirports, regionsNear, search } from './navdata.js';
import { buildPln, parsePln } from './flightplan/pln.js';
import { directToPlan, PlanStore } from './flightplan/store.js';
import { expandPlan } from './flightplan/procedures.js';
import { fetchSimbrief, SimbriefError } from './flightplan/simbrief.js';
import { parseRoute, resolveIdent } from './flightplan/route.js';
import { WEB_DIR } from './paths.js';
import { LinkError, LinkManager } from './link/manager.js';
import { toLinkPlan } from './link/payload.js';
import { installLink, linkStatus, uninstallLink } from './link/install.js';
import { log } from './log.js';

export const VERSION = '0.1.0';

/** Errors whose message is safe and useful to show to the user. */
class UserError extends Error {}

const asyncRoute =
  (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal && !ni.address.startsWith('169.254.')) out.push(ni.address);
    }
  }
  return out;
}

export class SkyDeckServer {
  readonly bridges = new BridgeManager();
  readonly plans = new PlanStore();
  readonly link = new LinkManager();
  private readonly app = express();
  private server: http.Server | null = null;
  private wss = new WebSocketServer({ noServer: true });
  private linkWss = new WebSocketServer({ noServer: true });
  private lastTelemetrySent = 0;
  port = 0;

  constructor(private readonly dev: boolean) {
    this.routes();
    this.wss.on('connection', (ws) => this.onSocket(ws));
    this.linkWss.on('connection', (ws) => this.link.attach(ws));
    this.link.on('change', () => this.broadcast({ type: 'status', status: this.status() }));
    this.link.on('state', (state) => this.broadcast({ type: 'avionics', state }));
    this.bridges.on('telemetry', () => this.flushTelemetry());
    this.bridges.on('status', () => this.broadcast({ type: 'status', status: this.status() }));
    this.bridges.on('notice', (level, message) => this.broadcast({ type: 'notice', level, message }));
    this.bridges.on('simFlightPlan', (file: string) => void this.onSimFlightPlan(file));
    this.plans.on('change', (plan: FlightPlan | null) => {
      this.broadcast({ type: 'plan', plan });
      // Fill in SID/STAR/approach fixes in the background so the map can draw them.
      if (plan && plan.expanded == null) void this.refreshExpanded(plan);
    });
  }

  status(): ServerStatus {
    const s = getSettings();
    return {
      connection: this.bridges.state,
      message: this.bridges.message,
      simName: this.bridges.sim.connected ? this.bridges.sim.simName : undefined,
      hasAircraft: this.bridges.latest != null,
      lanUrls: s.allowLan ? lanAddresses().map((ip) => `http://${ip}:${this.port}`) : [],
      link: { connected: this.link.connected, avionics: this.link.avionics, version: this.link.version },
      version: VERSION,
    };
  }

  // ---------------------------------------------------------------- Listening

  async listen(port: number, allowLan: boolean): Promise<number> {
    const host = allowLan ? '0.0.0.0' : '127.0.0.1';
    for (let p = port; p < port + 10; p++) {
      try {
        await this.bind(p, host);
        this.port = p;
        return p;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
        log.warn(`Port ${p} is busy, trying ${p + 1}.`);
      }
    }
    throw new Error(`Ports ${port}-${port + 9} are all in use. Change the port in settings.json.`);
  }

  private bind(port: number, host: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = http.createServer(this.app);
      server.on('upgrade', (req, socket, head) => {
        // SkyDeck Link connects from inside the simulator (Coherent pages have a coui:// or no origin).
        if (req.url?.startsWith('/link') && this.linkOriginAllowed(req.headers.origin, req.headers.host)) {
          this.linkWss.handleUpgrade(req, socket, head, (ws) => this.linkWss.emit('connection', ws, req));
          return;
        }
        if (!req.url?.startsWith('/ws') || !this.originAllowed(req.headers.origin, req.headers.host)) {
          socket.destroy();
          return;
        }
        this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req));
      });
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        this.server = server;
        resolve();
      });
    });
  }

  /** Re-binds to localhost-only or all interfaces when the LAN setting changes. */
  private async rebind(allowLan: boolean) {
    const old = this.server;
    if (!old) return;
    for (const ws of this.wss.clients) ws.close(1012, 'Restarting');
    await new Promise<void>((resolve) => {
      old.close(() => resolve());
      old.closeAllConnections();
    });
    await this.bind(this.port, allowLan ? '0.0.0.0' : '127.0.0.1');
    log.info(allowLan ? `Network access on: other devices can open ${lanAddresses().map((ip) => `http://${ip}:${this.port}`).join(' or ')}` : 'Network access off: only this PC can open SkyDeck.');
  }

  /** Blocks other websites (and DNS-rebinding tricks) from talking to SkyDeck through the user's browser. */
  private originAllowed(origin: string | undefined, host: string | undefined): boolean {
    if (!host) return false;
    const hostName = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    const allowedHosts = new Set(['localhost', '127.0.0.1', '::1', os.hostname().toLowerCase(), ...lanAddresses()]);
    if (!allowedHosts.has(hostName.toLowerCase())) return false;
    if (!origin) return true;
    try {
      const o = new URL(origin);
      // In development the UI is served by Vite on another port of the same machine.
      return o.host === host || (this.dev && allowedHosts.has(o.hostname));
    } catch {
      return false;
    }
  }

  private linkOriginAllowed(origin: string | undefined, host: string | undefined): boolean {
    const hostName = (host ?? '').replace(/:\d+$/, '');
    if (hostName !== '127.0.0.1' && hostName !== 'localhost') return false;
    return !origin || origin === 'null' || /^(coui|file):/i.test(origin);
  }

  // ---------------------------------------------------------------- WebSocket

  private send(ws: WebSocket, msg: ServerMessage) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  broadcast(msg: ServerMessage) {
    const data = JSON.stringify(msg);
    for (const ws of this.wss.clients) if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }

  private flushTelemetry() {
    const now = Date.now();
    if (now - this.lastTelemetrySent < 60 || !this.bridges.latest) return;
    this.lastTelemetrySent = now;
    this.broadcast({ type: 'telemetry', data: this.bridges.latest });
  }

  private onSocket(ws: WebSocket) {
    this.send(ws, { type: 'status', status: this.status() });
    this.send(ws, { type: 'settings', settings: getSettings() });
    this.send(ws, { type: 'plan', plan: this.plans.plan });
    if (this.bridges.latest) this.send(ws, { type: 'telemetry', data: this.bridges.latest });
    this.send(ws, { type: 'avionics', state: this.link.state });
    ws.on('message', async (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(raw)) as ClientMessage;
      } catch {
        return;
      }
      if (msg.type !== 'command') return;
      try {
        await this.bridges.command(msg.command);
        this.send(ws, { type: 'result', id: msg.id, ok: true });
      } catch (err) {
        const message = err instanceof CommandError ? err.message : 'Something went wrong sending that to the simulator.';
        if (!(err instanceof CommandError)) log.error('Command failed', msg.command, err);
        this.send(ws, { type: 'result', id: msg.id, ok: false, message });
      }
    });
  }

  private async onSimFlightPlan(file: string) {
    // Loading a plan from SkyDeck also fires this event; only announce plans that came from elsewhere.
    if (/skydeck(\.pln)?$/i.test(file) || Date.now() - (this.plans.plan?.sentToSimAt ?? 0) < 10000) return;
    log.info(`MSFS activated a flight plan: ${file}`);
    this.broadcast({ type: 'notice', level: 'info', message: 'MSFS has a new flight plan. Use Import → "From MSFS" to bring it into SkyDeck.' });
  }

  // ---------------------------------------------------------------- Procedures

  /** The plan's route with SID/STAR/approach fixes from the simulator, or null if there is nothing to add. */
  private async expand(plan: FlightPlan): Promise<PlanWaypoint[] | null> {
    const bridge = this.bridges.active;
    const p = plan.procedures;
    if (!bridge || plan.waypoints.length < 2 || !(p.sid || p.star || p.approach)) return null;
    const dep = plan.waypoints[0];
    const dest = plan.waypoints[plan.waypoints.length - 1];
    const [depLegs, arrLegs] = await Promise.all([
      p.sid && dep.type === 'airport' ? bridge.procedureLegs(dep.ident) : null,
      (p.star || p.approach) && dest.type === 'airport' ? bridge.procedureLegs(dest.ident) : null,
    ]);
    if (!depLegs && !arrLegs) return null;
    return expandPlan(plan, depLegs, arrLegs);
  }

  private async refreshExpanded(plan: FlightPlan) {
    try {
      const expanded = await this.expand(plan);
      if (expanded) await this.plans.setExpanded(plan.updatedAt, expanded);
    } catch (err) {
      log.warn('Could not look up procedures:', (err as Error).message);
    }
  }

  // ---------------------------------------------------------------- HTTP routes

  private nearPoint(): { lat: number; lon: number } | undefined {
    const t = this.bridges.latest;
    if (t) return { lat: t.position.lat, lon: t.position.lon };
    const wp = this.plans.plan?.waypoints[0];
    return wp ? { lat: wp.lat, lon: wp.lon } : undefined;
  }

  private routes() {
    const app = this.app;
    app.disable('x-powered-by');
    app.use((req, res, next) => {
      if (!this.originAllowed(req.headers.origin, req.headers.host)) {
        res.status(403).json({ error: 'Requests from other websites are not allowed.' });
        return;
      }
      next();
    });
    // strict: false so a plain `null` (clearing the flight plan) is accepted.
    app.use(express.json({ limit: '2mb', strict: false }));
    app.use(express.text({ type: ['text/plain', 'application/xml', 'text/xml'], limit: '2mb' }));

    app.get('/api/state', (_req, res) => {
      res.json({ status: this.status(), settings: getSettings(), plan: this.plans.plan, telemetry: this.bridges.latest });
    });

    // --- Settings & first-run setup
    app.put('/api/settings', asyncRoute(async (req, res) => {
      const before = getSettings();
      const patch = req.body as Partial<Settings>;
      if (patch.msfsDataPath) {
        if (!(await isDirectory(patch.msfsDataPath))) throw new UserError('That folder does not exist.');
        patch.msfsPackagesPath ??= await readPackagesPath(patch.msfsDataPath);
      }
      const settings = await updateSettings(patch);
      this.broadcast({ type: 'settings', settings });
      res.json(settings);
      if (before.allowLan !== settings.allowLan) {
        setTimeout(() => void this.rebind(settings.allowLan).then(() => this.broadcast({ type: 'status', status: this.status() })), 100);
      }
    }));
    app.get('/api/setup/detect', asyncRoute(async (_req, res) => res.json(await detectInstalls())));
    app.get('/api/setup/folders', asyncRoute(async (req, res) => {
      try {
        res.json(await listFolders(typeof req.query.path === 'string' && req.query.path ? req.query.path : null));
      } catch {
        throw new UserError('That folder cannot be opened.');
      }
    }));
    app.post('/api/setup/inspect', asyncRoute(async (req, res) => {
      const p = String(req.body?.path ?? '');
      const found = p ? await inspectInstall(p) : null;
      if (!found) throw new UserError('This folder does not look like an MSFS folder (no UserCfg.opt or MISSIONS folder inside).');
      res.json(found);
    }));

    // --- Navigation data
    app.get('/api/navdata/:file', (req, res) => {
      const file = req.params.file;
      if (file !== 'airports.json' && file !== 'navaids.json') {
        res.status(404).end();
        return;
      }
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.sendFile(navDataFile(file));
    });
    app.get('/api/search', asyncRoute(async (req, res) => {
      const q = String(req.query.q ?? '');
      const near = this.nearPoint();
      const results: SearchResult[] = search(q, near);
      // Named fixes are not in the offline data; ask the simulator for an exact match.
      const ident = q.trim().toUpperCase();
      const bridge = this.bridges.active;
      if (bridge?.kind === 'sim' && near && /^[A-Z0-9]{2,5}$/.test(ident) && !results.some((r) => r.ident === ident)) {
        const fix = await bridge.findFix(ident, near, regionsNear(near.lat, near.lon));
        if (fix) results.unshift({ kind: 'fix', ident: fix.ident, name: `Waypoint (${fix.region})`, lat: fix.lat, lon: fix.lon, region: fix.region });
      }
      res.json(results);
    }));
    app.get('/api/airport/:ident', asyncRoute(async (req, res) => {
      const ident = req.params.ident.toUpperCase();
      const offline = airportDetailsOffline(ident);
      const bridge = this.bridges.active;
      const fromSim = bridge?.kind === 'sim' ? await bridge.airportFromSim(ident) : null;
      if (!offline && !fromSim) throw new UserError(`No airport called ${ident} was found.`);
      const merged: AirportDetails = {
        ident,
        name: offline?.name ?? fromSim?.name ?? ident,
        city: offline?.city ?? '',
        country: offline?.country ?? '',
        lat: fromSim?.lat ?? offline!.lat,
        lon: fromSim?.lon ?? offline!.lon,
        elevFt: offline?.elevFt ?? fromSim?.elevFt ?? null,
        size: offline?.size ?? 'small',
        iata: offline?.iata,
        // Runway geometry from the sim matches the scenery; OurAirports adds surface info when the sim has none.
        runways: fromSim?.runways?.length ? fromSim.runways : offline?.runways ?? [],
        frequencies: fromSim?.frequencies?.length ? fromSim.frequencies : offline?.frequencies ?? [],
        procedures: fromSim?.procedures ?? null,
        source: fromSim ? 'sim' : 'offline',
      };
      res.json(merged);
    }));
    app.get('/api/nearest', (req, res) => {
      const lat = Number(req.query.lat);
      const lon = Number(req.query.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        res.status(400).json({ error: 'lat and lon are required' });
        return;
      }
      const list = nearestAirports(lat, lon, 8).map((a) => ({ ...a, frequencies: airportDetailsOffline(a.ident)?.frequencies ?? [] }));
      res.json(list);
    });
    app.post('/api/resolve', asyncRoute(async (req, res) => {
      const wp = await resolveIdent(String(req.body?.ident ?? ''), this.nearPoint(), this.bridges.active);
      if (!wp) throw new UserError(`Could not find "${req.body?.ident}". Check the spelling, or click the map to add a custom point.`);
      res.json(wp);
    }));

    // --- SkyDeck Link (in-sim add-on)
    const linkSettings = () => {
      const s = getSettings();
      return { packagesPath: s.msfsPackagesPath, port: s.port };
    };
    app.get('/api/link', asyncRoute(async (_req, res) => {
      const { packagesPath, port } = linkSettings();
      res.json(await linkStatus(packagesPath, port));
    }));
    app.post('/api/link/install', asyncRoute(async (_req, res) => {
      const { packagesPath, port } = linkSettings();
      if (!packagesPath) throw new UserError('Set the simulator folder in Settings first.');
      try {
        await installLink(packagesPath, port);
      } catch (err) {
        throw new UserError((err as Error).message);
      }
      log.info('SkyDeck Link installed into the Community folder.');
      res.json(await linkStatus(packagesPath, port));
    }));
    app.post('/api/link/uninstall', asyncRoute(async (_req, res) => {
      const { packagesPath, port } = linkSettings();
      if (!packagesPath) throw new UserError('Set the simulator folder in Settings first.');
      try {
        await uninstallLink(packagesPath);
      } catch (err) {
        throw new UserError((err as Error).message);
      }
      log.info('SkyDeck Link removed from the Community folder.');
      res.json(await linkStatus(packagesPath, port));
    }));

    // --- Flight plan
    app.get('/api/plan', (_req, res) => res.json(this.plans.plan));
    app.put('/api/plan', asyncRoute(async (req, res) => {
      const plan = req.body as FlightPlan | null;
      if (plan && !Array.isArray(plan.waypoints)) throw new UserError('Invalid flight plan.');
      await this.plans.set(plan);
      res.json(this.plans.plan);
    }));
    app.post('/api/plan/send', asyncRoute(async (_req, res) => {
      const plan = this.plans.plan;
      if (!plan || plan.waypoints.length < 2) throw new UserError('Add at least a departure and a destination first.');
      log.debug(`Send plan: link connected=${this.link.connected} ready=${this.link.ready}, sim inFlight=${this.bridges.sim.inFlight}`);
      // Glass cockpits with SkyDeck Link: edit the avionics' own flight plan.
      if (this.link.ready) {
        try {
          const result = await this.link.loadPlan(toLinkPlan(plan));
          await this.plans.markSent();
          res.json({ ok: true, via: 'avionics', avionics: this.link.avionics, warnings: result?.warnings ?? [] });
        } catch (err) {
          throw new UserError(err instanceof LinkError ? `${this.link.avionics ?? 'The avionics'}: ${err.message}` : 'Sending to the avionics failed.');
        }
        return;
      }
      const bridge = this.bridges.active;
      if (!bridge) throw new UserError('Microsoft Flight Simulator is not connected yet.');
      const expanded = await this.expand(plan);
      const full = { ...plan, expanded, waypoints: expanded ?? plan.waypoints };
      const file = await this.plans.writePln(full);
      try {
        await bridge.loadFlightPlan(full, file);
      } catch (err) {
        if (err instanceof CommandError) throw new UserError(err.message);
        throw err;
      }
      if (expanded) await this.plans.setExpanded(plan.updatedAt, expanded);
      await this.plans.markSent();
      const preflight = bridge.kind === 'sim' && !this.bridges.sim.inFlight;
      res.json({ ok: true, via: preflight ? 'preflight' : bridge.kind === 'demo' ? 'demo' : 'sim' });
    }));
    app.post('/api/plan/direct', asyncRoute(async (req, res) => {
      const t = this.bridges.latest;
      if (!t) throw new UserError('Direct-to needs a flying aircraft. Connect MSFS (or start the demo) first.');
      const body = req.body as { waypoint?: PlanWaypoint; ident?: string };
      const target = body.waypoint ?? (body.ident ? await resolveIdent(body.ident, this.nearPoint(), this.bridges.active) : null);
      if (!target) throw new UserError('Direct-to target not found.');
      log.debug(`Direct-to ${target.ident}: link connected=${this.link.connected} ready=${this.link.ready}`);
      if (this.link.ready) {
        try {
          await this.link.directTo({ ident: target.ident.toUpperCase(), type: target.type, region: target.region, lat: target.lat, lon: target.lon });
        } catch (err) {
          throw new UserError(err instanceof LinkError ? err.message : 'Direct-to failed.');
        }
        res.json(this.plans.plan);
        return;
      }
      const plan = directToPlan(this.plans.plan, target, t);
      await this.plans.set(plan);
      const bridge = this.bridges.active;
      if (bridge) {
        const expanded = await this.expand(plan);
        const full = { ...plan, expanded, waypoints: expanded ?? plan.waypoints };
        await bridge.loadFlightPlan(full, await this.plans.writePln(full));
        if (expanded) await this.plans.setExpanded(plan.updatedAt, expanded);
        await this.plans.markSent();
      }
      res.json(this.plans.plan);
    }));
    app.post('/api/plan/import/simbrief', asyncRoute(async (req, res) => {
      const user = String(req.body?.user ?? getSettings().simbriefUser ?? '');
      try {
        const plan = await fetchSimbrief(user);
        if (user && user !== getSettings().simbriefUser) {
          this.broadcast({ type: 'settings', settings: await updateSettings({ simbriefUser: user }) });
        }
        await this.plans.set(plan);
        res.json(plan);
      } catch (err) {
        if (err instanceof SimbriefError) throw new UserError(err.message);
        throw err;
      }
    }));
    app.post('/api/plan/import/msfs', asyncRoute(async (_req, res) => {
      const dataPath = getSettings().msfsDataPath;
      if (!dataPath) throw new UserError('Tell SkyDeck where MSFS is installed first (Settings → Simulator folder).');
      let xml: string;
      try {
        xml = await readFile(customFlightPlanPath(dataPath), 'utf8');
      } catch {
        throw new UserError('MSFS has not saved a flight plan yet. Plan a flight on the World Map, press Fly, then try again.');
      }
      const plan = parsePln(xml, 'MSFS World Map');
      await this.plans.set(plan);
      res.json(plan);
    }));
    app.post('/api/plan/import/pln', asyncRoute(async (req, res) => {
      try {
        const plan = parsePln(String(req.body ?? ''), 'PLN file');
        await this.plans.set(plan);
        res.json(plan);
      } catch (err) {
        throw new UserError((err as Error).message);
      }
    }));
    app.post('/api/plan/route', asyncRoute(async (req, res) => {
      const route = String(req.body?.route ?? '');
      const cruise = Number(req.body?.cruiseAltFt) || this.plans.plan?.cruiseAltFt || 8000;
      try {
        const { plan, skipped } = await parseRoute(route, cruise, this.bridges.active, this.nearPoint());
        await this.plans.set(plan);
        res.json({ plan, skipped });
      } catch (err) {
        throw new UserError((err as Error).message);
      }
    }));
    app.get('/api/plan/export.pln', (_req, res) => {
      const plan = this.plans.plan;
      if (!plan || plan.waypoints.length < 2) {
        res.status(400).json({ error: 'There is no flight plan to export.' });
        return;
      }
      const name = `${plan.waypoints[0].ident}-${plan.waypoints[plan.waypoints.length - 1].ident}.pln`;
      res.setHeader('Content-Type', 'application/xml');
      res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
      res.send(buildPln(plan));
    });

    app.use('/api', (_req, res) => {
      res.status(404).json({ error: 'Not found' });
    });

    // --- The web UI (production build)
    if (!this.dev) {
      app.use(express.static(WEB_DIR, { index: 'index.html', maxAge: '1h' }));
      app.get('*', (_req, res) => res.sendFile('index.html', { root: WEB_DIR }));
    }

    app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      if (err instanceof UserError) {
        res.status(400).json({ error: err.message });
        return;
      }
      log.error(err);
      res.status(500).json({ error: 'Something went wrong. See the SkyDeck window for details.' });
    });
  }
}
