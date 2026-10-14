// Live connection to Microsoft Flight Simulator through SimConnect.
import { EventEmitter } from 'node:events';
import {
  open,
  Protocol,
  SimConnectConstants,
  SimConnectDataType,
  SimConnectPeriod,
  FacilityDataType,
  InitPosition,
  RawBuffer,
  type SimConnectConnection,
  type RecvFacilityData,
} from 'node-simconnect';
import type { AirportDetails, AirportFrequency, Command, FlightPlan, Procedure, Runway, Telemetry } from '../../shared/types.js';
import { destinationPoint, distanceNm } from '../../shared/geo.js';
import { buildTelemetry, FUEL_TANKS, NUMERIC_VARS, STRING_VARS } from './simvars.js';
import { eventsForCommand } from './events.js';
import { CommandError, type SimBridge } from './types.js';
import { emptyProcedure, type AirportProcedureLegs, type LegFix, type ProcedureLegs } from '../flightplan/procedures.js';
import type { RawGround } from '../ground/graph.js';
import { log } from '../log.js';

const USER = SimConnectConstants.OBJECT_ID_USER;
// node-simconnect exposes these as const enums, which are not available at runtime here.
const PRIORITY_HIGHEST = 1;
const FLAG_GROUPID_IS_PRIORITY = 16;
const DATA_REQUEST_FLAG_CHANGED = 1;

enum Def { Numeric = 1, Strings, FuelCapacity, FuelQuantity, InitPosition, ApAltitudeWrite, ApSpeedWrite, FacAirport = 100, FacWaypoint, FacProcedureLegs, FacGround }
enum Req { Numeric = 1, Strings, FuelCapacity, SimState }
enum SysEvent { Pause = 1, Sim, AircraftLoaded, FlightPlanActivated, FlightLoaded }

const TELEMETRY_INTERVAL_MS = 66; // ~15 updates per second
const RECONNECT_MS = 3000;
const FIRST_FACILITY_REQUEST = 1000;

const APPROACH_TYPES: Record<number, string> = {
  1: 'GPS', 2: 'VOR', 3: 'NDB', 4: 'ILS', 5: 'LOC', 6: 'SDF', 7: 'LDA', 8: 'VOR/DME', 9: 'NDB/DME', 10: 'RNAV', 11: 'LOC BC',
};
const FREQUENCY_TYPES: Record<number, string> = {
  1: 'ATIS', 2: 'MULTICOM', 3: 'UNICOM', 4: 'CTAF', 5: 'GROUND', 6: 'TOWER', 7: 'CLEARANCE', 8: 'APPROACH',
  9: 'DEPARTURE', 10: 'CENTER', 11: 'FSS', 12: 'AWOS', 13: 'ASOS', 14: 'CLEARANCE', 15: 'CLEARANCE',
};
const DESIGNATORS = ['', 'L', 'R', 'C', 'W', 'A', 'B'];

export function runwayName(number: number, designator: number): string {
  if (number < 1 || number > 36) return '';
  return String(number).padStart(2, '0') + (DESIGNATORS[designator] ?? '');
}

interface PendingFacility {
  items: RecvFacilityData[];
  resolve: (items: RecvFacilityData[] | null) => void;
  timer: NodeJS.Timeout;
}

export class SimConnectBridge extends EventEmitter implements SimBridge {
  readonly kind = 'sim' as const;
  connected = false;
  simName = '';
  /** What MSFS reports through the "Sim" system state/event. It also reads 1 in the main menu. */
  private simRunning = false;
  /** In the main menu and World Map the user aircraft is parked at 0°N 0°E. */
  private atNullIsland = true;

  get inFlight(): boolean {
    return this.connected && this.simRunning && !this.atNullIsland;
  }

  private handle: SimConnectConnection | null = null;
  private stopped = true;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private numeric: Record<string, number> = {};
  private strings: Record<string, string> = {};
  private paused = false;
  private lastEmit = 0;
  private latest: Telemetry | null = null;
  private eventIds = new Map<string, number>();
  private nextEventId = 100;
  private nextRequestId = FIRST_FACILITY_REQUEST;
  private facilityRequests = new Map<number, PendingFacility>();
  private fuelCapacityWaiter: ((caps: number[]) => void) | null = null;
  /** sendId -> description, so SimConnect exceptions can be traced back to what caused them. */
  private sent = new Map<number, string>();

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.handle?.close();
    this.handle = null;
    this.setConnected(false);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    try {
      const { recvOpen, handle } = await open('SkyDeck', Protocol.KittyHawk);
      if (this.stopped) {
        handle.close();
        return;
      }
      this.handle = handle;
      this.simName = recvOpen.applicationName === 'KittyHawk' ? 'Microsoft Flight Simulator' : recvOpen.applicationName;
      log.info(`Connected to ${this.simName} (${recvOpen.applicationVersionMajor}.${recvOpen.applicationVersionMinor})`);
      this.eventIds.clear();
      this.setup(handle);
      this.setConnected(true);
    } catch {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => void this.connect(), RECONNECT_MS);
  }

  private setConnected(value: boolean) {
    if (this.connected === value) return;
    this.connected = value;
    if (!value) {
      this.simRunning = false;
      this.atNullIsland = true;
      this.latest = null;
      for (const p of this.facilityRequests.values()) {
        clearTimeout(p.timer);
        p.resolve(null);
      }
      this.facilityRequests.clear();
    }
    this.emit('state');
  }

  private track(sendId: number, what: string) {
    this.sent.set(sendId, what);
    if (this.sent.size > 2000) this.sent.delete(this.sent.keys().next().value!);
  }

  private setup(h: SimConnectConnection) {
    const lost = () => {
      if (this.handle !== h) return;
      log.info('Simulator connection closed; waiting for it to come back.');
      this.handle = null;
      this.setConnected(false);
      this.scheduleReconnect();
    };
    h.on('quit', lost);
    h.on('close', lost);
    h.on('error', (err) => log.warn('SimConnect error:', err.message));
    h.on('exception', (e) => {
      const what = this.sent.get(e.sendId) ?? 'unknown request';
      // Facility look-ups for unknown idents are expected to fail; keep the log quiet for those.
      if (!what.startsWith('facility')) log.warn(`SimConnect rejected ${what}: ${e.exceptionName}`);
    });

    NUMERIC_VARS.forEach(([name, unit]) => this.track(h.addToDataDefinition(Def.Numeric, name, unit, SimConnectDataType.FLOAT64), `variable "${name}"`));
    STRING_VARS.forEach(([name, size]) => {
      const type = size === 256 ? SimConnectDataType.STRING256 : size === 64 ? SimConnectDataType.STRING64 : SimConnectDataType.STRING32;
      this.track(h.addToDataDefinition(Def.Strings, name, null, type), `variable "${name}"`);
    });
    FUEL_TANKS.forEach((tank) => {
      h.addToDataDefinition(Def.FuelCapacity, `FUEL TANK ${tank} CAPACITY`, 'gallons', SimConnectDataType.FLOAT64);
      h.addToDataDefinition(Def.FuelQuantity, `FUEL TANK ${tank} QUANTITY`, 'gallons', SimConnectDataType.FLOAT64);
    });
    h.addToDataDefinition(Def.InitPosition, 'Initial Position', null, SimConnectDataType.INITPOSITION);
    h.addToDataDefinition(Def.ApAltitudeWrite, 'AUTOPILOT ALTITUDE LOCK VAR:1', 'feet', SimConnectDataType.FLOAT64);
    h.addToDataDefinition(Def.ApSpeedWrite, 'AUTOPILOT AIRSPEED HOLD VAR', 'knots', SimConnectDataType.FLOAT64);
    this.defineFacilities(h);

    h.requestDataOnSimObject(Req.Numeric, Def.Numeric, USER, SimConnectPeriod.SIM_FRAME, 0, 0, 2);
    h.requestDataOnSimObject(Req.Strings, Def.Strings, USER, SimConnectPeriod.SECOND, DATA_REQUEST_FLAG_CHANGED);

    h.subscribeToSystemEvent(SysEvent.Pause, 'Pause');
    h.subscribeToSystemEvent(SysEvent.Sim, 'Sim');
    h.subscribeToSystemEvent(SysEvent.AircraftLoaded, 'AircraftLoaded');
    h.subscribeToSystemEvent(SysEvent.FlightPlanActivated, 'FlightPlanActivated');
    h.subscribeToSystemEvent(SysEvent.FlightLoaded, 'FlightLoaded');
    h.requestSystemState(Req.SimState, 'Sim');

    h.on('systemState', (s) => {
      if (s.requestID === Req.SimState) this.setInFlight(s.dataInteger === 1);
    });
    h.on('event', (e) => {
      switch (e.clientEventId) {
        case SysEvent.Pause:
          this.paused = e.data === 1;
          break;
        case SysEvent.Sim:
          this.setInFlight(e.data === 1);
          break;
        case SysEvent.FlightLoaded:
          h.requestSystemState(Req.SimState, 'Sim');
          break;
      }
    });
    h.on('eventFilename', (e) => {
      if (e.clientEventId === SysEvent.FlightPlanActivated && e.fileName) this.emit('simFlightPlan', e.fileName);
    });
    h.on('simObjectData', (d) => {
      if (d.requestID === Req.Numeric) {
        for (const [name] of NUMERIC_VARS) this.numeric[name] = d.data.readFloat64();
        this.publish();
      } else if (d.requestID === Req.Strings) {
        for (const [name, size] of STRING_VARS) {
          this.strings[name] = (size === 256 ? d.data.readString256() : size === 64 ? d.data.readString64() : d.data.readString32()).trim();
        }
      } else if (d.requestID === Req.FuelCapacity) {
        const caps = FUEL_TANKS.map(() => d.data.readFloat64());
        this.fuelCapacityWaiter?.(caps);
        this.fuelCapacityWaiter = null;
      }
    });
    h.on('facilityData', (r) => this.facilityRequests.get(r.userRequestId)?.items.push(r));
    h.on('facilityDataEnd', (r) => {
      const pending = this.facilityRequests.get(r.userRequestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.facilityRequests.delete(r.userRequestId);
      pending.resolve(pending.items);
    });
  }

  private setInFlight(value: boolean) {
    const before = this.inFlight;
    this.simRunning = value;
    if (this.inFlight !== before) this.emit('state');
  }

  private publish() {
    const before = this.inFlight;
    this.atNullIsland = Math.abs(this.numeric['PLANE LATITUDE']) < 0.02 && Math.abs(this.numeric['PLANE LONGITUDE']) < 0.05;
    if (this.inFlight !== before) this.emit('state');
    const now = Date.now();
    if (now - this.lastEmit < TELEMETRY_INTERVAL_MS) return;
    this.lastEmit = now;
    const t = buildTelemetry(this.numeric, this.strings);
    t.sim.paused = this.paused;
    this.latest = t;
    this.emit('telemetry', t);
  }

  // ------------------------------------------------------------------ Commands

  private requireHandle(): SimConnectConnection {
    if (!this.handle) throw new CommandError('Microsoft Flight Simulator is not connected.');
    return this.handle;
  }

  private transmit(name: string, value = 0) {
    const h = this.requireHandle();
    let id = this.eventIds.get(name);
    if (id == null) {
      id = this.nextEventId++;
      this.track(h.mapClientEventToSimEvent(id, name), `event ${name}`);
      this.eventIds.set(name, id);
    }
    // Events carry an unsigned 32-bit value; negative numbers (e.g. descent rates) use two's complement.
    this.track(h.transmitClientEvent(USER, id, value >>> 0, PRIORITY_HIGHEST, FLAG_GROUPID_IS_PRIORITY), `event ${name}`);
  }

  async command(cmd: Command): Promise<void> {
    const events = eventsForCommand(cmd, this.latest);
    if (events) {
      this.requireHandle();
      for (const e of events) this.transmit(e.name, e.value);
      if (cmd.type === 'ap.set' && (cmd.key === 'alt' || cmd.key === 'spd')) await this.settleApValue(cmd.key, cmd.value);
      return;
    }
    switch (cmd.type) {
      case 'fuel.set':
        return this.setFuel(cmd.pct);
      case 'teleport':
        return this.teleport(cmd);
      default:
        throw new CommandError('That action is not available with the simulator connected.');
    }
  }

  /**
   * Some avionics (e.g. the G1000 NXi) treat the "set" events as a single knob click towards the value.
   * If the aircraft did not take the value, write the selected value directly instead.
   */
  private async settleApValue(key: 'alt' | 'spd', target: number) {
    const def = key === 'alt' ? Def.ApAltitudeWrite : Def.ApSpeedWrite;
    for (let attempt = 0; attempt < 2; attempt++) {
      await new Promise((r) => setTimeout(r, 300));
      const current = this.latest?.autopilot[key];
      if (current == null || Math.abs(current - target) < 1 || !this.handle) return;
      const buffer = new RawBuffer(8);
      buffer.writeFloat64(target);
      this.track(this.handle.setDataOnSimObject(def, USER, { buffer, arrayCount: 0, tagged: false }), `autopilot ${key} value`);
    }
  }

  private async setFuel(pct: number) {
    const h = this.requireHandle();
    const fraction = Math.max(0, Math.min(100, pct)) / 100;
    const caps = await new Promise<number[]>((resolve, reject) => {
      const timer = setTimeout(() => reject(new CommandError('The simulator did not report fuel tank sizes.')), 3000);
      this.fuelCapacityWaiter = (c) => {
        clearTimeout(timer);
        resolve(c);
      };
      h.requestDataOnSimObject(Req.FuelCapacity, Def.FuelCapacity, USER, SimConnectPeriod.ONCE);
    });
    const buffer = new RawBuffer(8 * caps.length);
    caps.forEach((c) => buffer.writeFloat64(c * fraction));
    this.track(h.setDataOnSimObject(Def.FuelQuantity, USER, { buffer, arrayCount: 0, tagged: false }), 'fuel quantity');
  }

  private async teleport(cmd: Extract<Command, { type: 'teleport' }>) {
    const h = this.requireHandle();
    const pos = new InitPosition();
    pos.latitude = cmd.lat;
    pos.longitude = cmd.lon;
    pos.altitude = cmd.altFt;
    pos.heading = cmd.headingTrue;
    pos.pitch = 0;
    pos.bank = 0;
    pos.onGround = cmd.onGround;
    pos.airspeed = Math.round(cmd.kts);
    this.track(h.setDataOnSimObject(Def.InitPosition, USER, [pos]), 'aircraft position');
  }

  async loadFlightPlan(_plan: FlightPlan, plnPath: string): Promise<void> {
    // Also allowed outside a flight: avionics like the G1000 NXi read the sim's plan when a flight starts.
    const h = this.requireHandle();
    // SimConnect expects the path without the .PLN extension.
    this.track(h.flightPlanLoad(plnPath.replace(/\.pln$/i, '')), 'flight plan load');
  }

  // ------------------------------------------------------------------ Facilities

  private defineFacilities(h: SimConnectConnection) {
    const airport = [
      'OPEN AIRPORT', 'LATITUDE', 'LONGITUDE', 'ALTITUDE', 'NAME',
      'OPEN RUNWAY', 'LATITUDE', 'LONGITUDE', 'ALTITUDE', 'HEADING', 'LENGTH', 'WIDTH',
      'PRIMARY_NUMBER', 'PRIMARY_DESIGNATOR', 'SECONDARY_NUMBER', 'SECONDARY_DESIGNATOR', 'CLOSE RUNWAY',
      'OPEN FREQUENCY', 'TYPE', 'FREQUENCY', 'NAME', 'CLOSE FREQUENCY',
      'OPEN APPROACH', 'TYPE', 'SUFFIX', 'RUNWAY_NUMBER', 'RUNWAY_DESIGNATOR',
      'OPEN APPROACH_TRANSITION', 'IAF_ICAO', 'CLOSE APPROACH_TRANSITION', 'CLOSE APPROACH',
      'OPEN DEPARTURE', 'NAME',
      'OPEN RUNWAY_TRANSITION', 'RUNWAY_NUMBER', 'RUNWAY_DESIGNATOR', 'CLOSE RUNWAY_TRANSITION',
      'OPEN ENROUTE_TRANSITION', 'NAME', 'CLOSE ENROUTE_TRANSITION', 'CLOSE DEPARTURE',
      'OPEN ARRIVAL', 'NAME',
      'OPEN RUNWAY_TRANSITION', 'RUNWAY_NUMBER', 'RUNWAY_DESIGNATOR', 'CLOSE RUNWAY_TRANSITION',
      'OPEN ENROUTE_TRANSITION', 'NAME', 'CLOSE ENROUTE_TRANSITION', 'CLOSE ARRIVAL',
      'CLOSE AIRPORT',
    ];
    airport.forEach((f) => h.addToFacilityDefinition(Def.FacAirport, f));
    ['OPEN WAYPOINT', 'LATITUDE', 'LONGITUDE', 'ICAO', 'REGION', 'CLOSE WAYPOINT'].forEach((f) => h.addToFacilityDefinition(Def.FacWaypoint, f));

    const leg = (container: string) => [`OPEN ${container}`, ...LEG_FIELDS, `CLOSE ${container}`];
    const sidStar = (kind: 'DEPARTURE' | 'ARRIVAL') => [
      `OPEN ${kind}`, 'NAME',
      'OPEN RUNWAY_TRANSITION', 'RUNWAY_NUMBER', 'RUNWAY_DESIGNATOR', ...leg('APPROACH_LEG'), 'CLOSE RUNWAY_TRANSITION',
      ...leg('APPROACH_LEG'),
      'OPEN ENROUTE_TRANSITION', 'NAME', ...leg('APPROACH_LEG'), 'CLOSE ENROUTE_TRANSITION',
      `CLOSE ${kind}`,
    ];
    [
      'OPEN AIRPORT',
      'OPEN APPROACH', 'TYPE', 'SUFFIX', 'RUNWAY_NUMBER', 'RUNWAY_DESIGNATOR',
      'OPEN APPROACH_TRANSITION', 'IAF_ICAO', ...leg('APPROACH_LEG'), 'CLOSE APPROACH_TRANSITION',
      ...leg('FINAL_APPROACH_LEG'),
      'CLOSE APPROACH',
      ...sidStar('DEPARTURE'),
      ...sidStar('ARRIVAL'),
      'CLOSE AIRPORT',
    ].forEach((f) => h.addToFacilityDefinition(Def.FacProcedureLegs, f));
    [
      'OPEN AIRPORT', 'LATITUDE', 'LONGITUDE',
      'OPEN TAXI_POINT', 'TYPE', 'BIAS_X', 'BIAS_Z', 'CLOSE TAXI_POINT',
      'OPEN TAXI_PARKING', 'TYPE', 'NAME', 'NUMBER', 'HEADING', 'RADIUS', 'BIAS_X', 'BIAS_Z', 'CLOSE TAXI_PARKING',
      'OPEN TAXI_PATH', 'TYPE', 'START', 'END', 'NAME_INDEX', 'CLOSE TAXI_PATH',
      'OPEN TAXI_NAME', 'NAME', 'CLOSE TAXI_NAME',
      'CLOSE AIRPORT',
    ].forEach((f) => h.addToFacilityDefinition(Def.FacGround, f));
  }

  /** Taxiways, hold-short points and stands of an airport, as the scenery defines them. */
  async airportGround(icao: string): Promise<RawGround | null> {
    const items = await this.requestFacility(Def.FacGround, icao.toUpperCase(), '', undefined, 10000);
    if (!items?.length) return null;
    const raw = parseGroundFacility(items);
    return raw.points.length ? raw : null;
  }

  private legCache = new Map<string, Promise<AirportProcedureLegs | null>>();

  /** Every SID, STAR and approach of an airport with its fixes. Cached: the database does not change mid-session. */
  procedureLegs(icao: string): Promise<AirportProcedureLegs | null> {
    const key = icao.toUpperCase();
    let p = this.legCache.get(key);
    if (!p) {
      p = this.requestFacility(Def.FacProcedureLegs, key, '', undefined, 8000).then((items) => (items?.length ? parseProcedureLegs(items) : null));
      this.legCache.set(key, p);
      void p.then((r) => r ?? this.legCache.delete(key));
    }
    return p;
  }

  private requestFacility(def: Def, icao: string, region = '', type?: 'W', timeoutMs = 5000): Promise<RecvFacilityData[] | null> {
    const h = this.handle;
    if (!h) return Promise.resolve(null);
    const id = this.nextRequestId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.facilityRequests.delete(id);
        resolve(null);
      }, timeoutMs);
      this.facilityRequests.set(id, { items: [], resolve, timer });
      this.track(h.requestFacilityData(def, id, icao, region, type), `facility ${icao}`);
    });
  }

  async airportFromSim(icao: string): Promise<Partial<AirportDetails> | null> {
    const items = await this.requestFacility(Def.FacAirport, icao.toUpperCase());
    if (!items?.length) return null;
    return parseAirportFacility(items);
  }

  async findFix(ident: string, near?: { lat: number; lon: number }, regions: string[] = []) {
    if (!this.handle || regions.length === 0) return null;
    const results = await Promise.all(
      regions.map(async (region) => {
        const items = await this.requestFacility(Def.FacWaypoint, ident.toUpperCase(), region, 'W', 2500);
        const r = items?.find((i) => i.type === FacilityDataType.WAYPOINT);
        if (!r) return null;
        const lat = r.data.readFloat64();
        const lon = r.data.readFloat64();
        r.data.readString8();
        return { ident: ident.toUpperCase(), lat, lon, region: r.data.readString8() || region, type: 'fix' as const };
      }),
    );
    const found = results.filter((r): r is NonNullable<typeof r> => r != null);
    if (!found.length) return null;
    if (!near) return found[0];
    return found.sort((a, b) => distanceNm(near.lat, near.lon, a.lat, a.lon) - distanceNm(near.lat, near.lon, b.lat, b.lon))[0];
  }
}

const LEG_FIELDS = ['TYPE', 'FIX_ICAO', 'FIX_REGION', 'FIX_TYPE', 'FIX_LATITUDE', 'FIX_LONGITUDE'];
const FIX_TYPES: Record<string, LegFix['type'] | 'runway'> = { W: 'fix', V: 'vor', N: 'ndb', A: 'airport', R: 'runway' };

export function approachName(type: number, suffixCode: number, runwayNumber: number, runwayDesignator: number): string {
  const rwy = runwayName(runwayNumber, runwayDesignator);
  const suffix = suffixCode >= 65 && suffixCode <= 90 ? ` ${String.fromCharCode(suffixCode)}` : '';
  return `${APPROACH_TYPES[type] ?? 'APP'} ${rwy || 'CIRCLING'}${suffix}`.trim();
}

/** Builds SID/STAR/approach leg lists from the ordered facility records. Children point at their parent's id. */
export function parseProcedureLegs(items: RecvFacilityData[]): AirportProcedureLegs {
  const out: AirportProcedureLegs = { departures: {}, arrivals: {}, approaches: {} };
  const procs = new Map<number, ProcedureLegs>();
  const containers = new Map<number, LegFix[]>();
  for (const r of items) {
    const b = r.data;
    switch (r.type) {
      case FacilityDataType.APPROACH: {
        const p = emptyProcedure();
        out.approaches[approachName(b.readInt32(), b.readInt32(), b.readInt32(), b.readInt32())] = p;
        procs.set(r.uniqueRequestId, p);
        break;
      }
      case FacilityDataType.DEPARTURE:
      case FacilityDataType.ARRIVAL: {
        const p = emptyProcedure();
        (r.type === FacilityDataType.DEPARTURE ? out.departures : out.arrivals)[b.readString8()] = p;
        procs.set(r.uniqueRequestId, p);
        break;
      }
      case FacilityDataType.APPROACH_TRANSITION: {
        const p = procs.get(r.parentUniqueRequestId);
        const iaf = b.readString8();
        if (p && iaf) containers.set(r.uniqueRequestId, (p.transitions[iaf] = []));
        break;
      }
      case FacilityDataType.RUNWAY_TRANSITION: {
        const p = procs.get(r.parentUniqueRequestId);
        const rwy = runwayName(b.readInt32(), b.readInt32());
        if (p) containers.set(r.uniqueRequestId, (p.runways[rwy || 'ALL'] = []));
        break;
      }
      case FacilityDataType.ENROUTE_TRANSITION: {
        const p = procs.get(r.parentUniqueRequestId);
        const name = b.readString8();
        if (p && name) containers.set(r.uniqueRequestId, (p.transitions[name] = []));
        break;
      }
      case FacilityDataType.APPROACH_LEG:
      case FacilityDataType.FINAL_APPROACH_LEG: {
        b.readInt32(); // leg type
        const ident = b.readString8();
        const region = b.readString8();
        const fixType = FIX_TYPES[String.fromCharCode(b.readInt32())] ?? 'fix';
        const lat = b.readFloat64();
        const lon = b.readFloat64();
        if (!ident || fixType === 'runway' || (!lat && !lon)) break;
        const list = containers.get(r.parentUniqueRequestId) ?? procs.get(r.parentUniqueRequestId)?.common;
        list?.push({ ident, region, type: fixType, lat, lon });
        break;
      }
    }
  }
  return out;
}

/** Reads the taxi records of one airport. List order is significant: paths refer to points and parkings by index. */
export function parseGroundFacility(items: RecvFacilityData[]): RawGround {
  const raw: RawGround = { refLat: 0, refLon: 0, points: [], parkings: [], paths: [], names: [] };
  for (const r of items) {
    const b = r.data;
    switch (r.type) {
      case FacilityDataType.AIRPORT:
        raw.refLat = b.readFloat64();
        raw.refLon = b.readFloat64();
        break;
      case FacilityDataType.TAXI_POINT:
        raw.points.push({ type: b.readInt32(), x: b.readFloat32(), z: b.readFloat32() });
        break;
      case FacilityDataType.TAXI_PARKING:
        raw.parkings.push({ type: b.readInt32(), name: b.readInt32(), number: b.readInt32(), heading: b.readFloat32(), radius: b.readFloat32(), x: b.readFloat32(), z: b.readFloat32() });
        break;
      case FacilityDataType.TAXI_PATH:
        raw.paths.push({ type: b.readInt32(), start: b.readInt32(), end: b.readInt32(), nameIndex: b.readInt32() });
        break;
      case FacilityDataType.TAXI_NAME:
        raw.names.push(b.readString32());
        break;
    }
  }
  return raw;
}

/** Turns the ordered facility records for one airport into AirportDetails fields. Reading order matters. */
export function parseAirportFacility(items: RecvFacilityData[]): Partial<AirportDetails> {
  const runways: Runway[] = [];
  const frequencies: AirportFrequency[] = [];
  const approaches = new Map<number, Procedure>();
  const departures = new Map<number, Procedure>();
  const arrivals = new Map<number, Procedure>();
  const parentOf = (uid: number) => departures.get(uid) ?? arrivals.get(uid);
  let base: Partial<AirportDetails> = {};

  for (const r of items) {
    const b = r.data;
    switch (r.type) {
      case FacilityDataType.AIRPORT: {
        const lat = b.readFloat64();
        const lon = b.readFloat64();
        const altM = b.readFloat64();
        base = { lat, lon, elevFt: Math.round(altM * 3.28084), name: b.readString32() };
        break;
      }
      case FacilityDataType.RUNWAY: {
        const lat = b.readFloat64();
        const lon = b.readFloat64();
        const altFt = Math.round(b.readFloat64() * 3.28084);
        const heading = b.readFloat32();
        const lengthM = b.readFloat32();
        const widthM = b.readFloat32();
        const p = runwayName(b.readInt32(), b.readInt32());
        const s = runwayName(b.readInt32(), b.readInt32());
        if (!p && !s) break;
        const half = lengthM / 2 / 1852;
        const pEnd = destinationPoint(lat, lon, heading + 180, half);
        const sEnd = destinationPoint(lat, lon, heading, half);
        runways.push({
          ends: [
            { ident: p, lat: pEnd.lat, lon: pEnd.lon, headingTrue: Math.round(heading * 10) / 10, elevFt: altFt },
            { ident: s, lat: sEnd.lat, lon: sEnd.lon, headingTrue: Math.round(((heading + 180) % 360) * 10) / 10, elevFt: altFt },
          ],
          lengthFt: Math.round(lengthM * 3.28084),
          widthFt: Math.round(widthM * 3.28084),
          surface: '',
          lighted: true,
        });
        break;
      }
      case FacilityDataType.FREQUENCY: {
        const type = b.readInt32();
        const hz = b.readInt32();
        const name = b.readString64();
        frequencies.push({ type: FREQUENCY_TYPES[type] ?? 'OTHER', name, mhz: Math.round(hz / 1000) / 1000 });
        break;
      }
      case FacilityDataType.APPROACH: {
        const type = b.readInt32();
        const suffixCode = b.readInt32();
        const number = b.readInt32();
        const designator = b.readInt32();
        const rwy = runwayName(number, designator);
        approaches.set(r.uniqueRequestId, { name: approachName(type, suffixCode, number, designator), runways: rwy ? [rwy] : ['ALL'], transitions: [] });
        break;
      }
      case FacilityDataType.APPROACH_TRANSITION: {
        const iaf = b.readString8();
        if (iaf) approaches.get(r.parentUniqueRequestId)?.transitions.push(iaf);
        break;
      }
      case FacilityDataType.DEPARTURE:
        departures.set(r.uniqueRequestId, { name: b.readString8(), runways: [], transitions: [] });
        break;
      case FacilityDataType.ARRIVAL:
        arrivals.set(r.uniqueRequestId, { name: b.readString8(), runways: [], transitions: [] });
        break;
      case FacilityDataType.RUNWAY_TRANSITION: {
        const rwy = runwayName(b.readInt32(), b.readInt32());
        const parent = parentOf(r.parentUniqueRequestId);
        if (parent && rwy && !parent.runways.includes(rwy)) parent.runways.push(rwy);
        break;
      }
      case FacilityDataType.ENROUTE_TRANSITION: {
        const name = b.readString8();
        const parent = parentOf(r.parentUniqueRequestId);
        if (parent && name) parent.transitions.push(name);
        break;
      }
    }
  }
  const finish = (m: Map<number, Procedure>) =>
    [...m.values()]
      .map((p) => ({ ...p, runways: p.runways.length ? p.runways.sort() : ['ALL'] }))
      .sort((a, b) => a.name.localeCompare(b.name));
  return {
    ...base,
    runways,
    frequencies,
    procedures: { departures: finish(departures), arrivals: finish(arrivals), approaches: finish(approaches) },
    source: 'sim',
  };
}
