// Text ATC. Follows the flight from clearance delivery to the parking stand: the pilot picks what to say from a
// short list of requests, controllers answer, and the aircraft is handed from one controller to the next as it
// taxis, takes off, climbs, cruises, descends, lands and parks.
import { EventEmitter } from 'node:events';
import type { AirportDetails, AirportSummary, AtcMessage, AtcPhase, AtcRequest, AtcState, AtcStation, FlightPlan, Telemetry } from '../../shared/types.js';
import { bearingDeg, distanceNm } from '../../shared/geo.js';
import type { GroundService } from '../ground/service.js';
import { runwayEnd, runwayFrame, runwayGeoms } from '../ground/geometry.js';
import { pickStand } from '../ground/graph.js';
import {
  airportLabel,
  airportStations,
  centerStation,
  chooseRunway,
  fmtAlt,
  fmtMhz,
  fmtPressure,
  fmtWind,
  isUsStyle,
  roundUp,
  sectorCentre,
  sectorOf,
  unicomStation,
  type AirportStations,
} from './stations.js';

export class AtcError extends Error {}

export interface AtcDeps {
  airport(ident: string): Promise<AirportDetails | null>;
  ground: GroundService;
  plan(): FlightPlan | null;
  nearest(lat: number, lon: number, count: number, sizes?: AirportSummary['size'][]): Array<AirportSummary & { distNm: number }>;
  /** Callsign from the settings; empty for the aircraft's registration. */
  callsign(): string;
  /** How long controllers take to answer (ms). */
  replyDelayMs?: number;
}

type RequestId =
  | 'clearance' | 'readback' | 'pushback' | 'taxi' | 'at-holding' | 'ready' | 'checkin' | 'descent'
  | 'approach' | 'landing' | 'goaround' | 'taxi-in' | 'inbound' | 'say-again';

const MAX_TRANSCRIPT = 300;
const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];

interface Airport {
  details: AirportDetails;
  stations: AirportStations;
  label: string;
}

export class AtcEngine extends EventEmitter {
  private active = false;
  private phase: AtcPhase = 'idle';
  private rules: 'IFR' | 'VFR' = 'VFR';
  private callsign = '';
  private dep: Airport | null = null;
  private dest: Airport | null = null;
  private cruiseFt = 5000;
  private station: AtcStation | null = null;
  private checkedIn = false;
  private t: Telemetry | null = null;

  private depRunway: string | null = null;
  private arrRunway: string | null = null;
  private squawk: string | null = null;
  private assignedAlt: number | null = null;
  private assignedDir: 'climb' | 'descend' | null = null;
  private initialAlt = 0;
  private cleared = false;
  private takeoffCleared = false;
  private approachCleared = false;
  private landingCleared = false;
  private descentIssued = false;
  private vacateIssued = false;
  private airborne = false;
  private standName: string | null = null;
  private allowedRunways = new Set<string>();
  private pendingReadback: { text: string; reply?: () => void } | null = null;

  private transcript: AtcMessage[] = [];
  private msgId = 0;
  private warned = new Set<string>();
  private busy = 0;
  private queue: Promise<void> = Promise.resolve();
  private sector: string | null = null;
  private lastHandoff = 0;
  private lastRunwayOn: string | null = null;
  private emitPending = false;

  constructor(private readonly deps: AtcDeps) {
    super();
  }

  // ---------------------------------------------------------------- Lifecycle

  /** Starts a session for the current flight: works out departure, destination and where in the flight we are. */
  async start(t: Telemetry | null): Promise<void> {
    if (!t) throw new AtcError('ATC needs an aircraft. Start a flight in MSFS (or the demo) first.');
    this.reset(false);
    this.t = t;
    const plan = this.deps.plan();
    const wps = plan?.waypoints ?? [];
    const first = wps[0]?.type === 'airport' ? wps[0].ident : null;
    const last = wps.length > 1 && wps[wps.length - 1].type === 'airport' ? wps[wps.length - 1].ident : null;
    const here = this.deps.nearest(t.position.lat, t.position.lon, 1)[0];
    const atAirport = t.position.onGround && here && here.distNm < 3 ? here.ident : null;

    let depIdent = first ?? atAirport;
    let destIdent = last ?? depIdent;
    if (!depIdent && !destIdent) throw new AtcError('Create a flight plan with a departure and destination airport first, or start ATC on the ground at an airport.');
    // Started on the ground somewhere other than the planned departure: depart from here.
    if (atAirport && atAirport !== depIdent && atAirport !== destIdent) {
      depIdent = atAirport;
      destIdent = last ?? atAirport;
    }
    const [dep, dest] = await Promise.all([this.loadAirport(depIdent), this.loadAirport(destIdent)]);
    if (!dep && !dest) throw new AtcError(`No airport data for ${depIdent ?? destIdent}.`);
    this.dep = dep ?? dest;
    this.dest = dest ?? dep;
    this.rules = plan?.rules ?? 'VFR';
    this.cruiseFt = plan?.cruiseAltFt || Math.max(3000, roundUp((this.dep!.details.elevFt ?? 0) + 2500, 500));
    this.callsign = this.deps.callsign().trim().toUpperCase() || t.aircraft.atcId.trim().toUpperCase() || 'SKYDECK';
    this.active = true;
    void this.deps.ground.ground(this.dep!.details.ident);
    if (this.dest!.details.ident !== this.dep!.details.ident) void this.deps.ground.ground(this.dest!.details.ident);

    if (t.position.onGround && atAirport === this.dest!.details.ident && this.dest !== this.dep) {
      this.airborne = true;
      this.setPhase('landed', this.destGround(), false);
      this.vacateIssued = true;
    } else if (t.position.onGround) {
      this.setPhase('preflight', this.rules === 'IFR' ? this.depDelivery() : this.depGround(), false);
    } else {
      this.airborne = true;
      this.cleared = true;
      this.takeoffCleared = true;
      const destDist = this.distTo(this.dest!);
      this.assignedAlt = this.cruiseFt;
      if (this.rules === 'VFR') this.setPhase('vfr-enroute', null, false);
      else if (destDist < 35) this.setPhase('approach', this.arrivalApproach(), false);
      else this.setPhase('enroute', this.center(), false);
    }
    const route = `${this.dep!.details.ident}${this.dest!.details.ident !== this.dep!.details.ident ? ` to ${this.dest!.details.ident}` : ' (local flight)'}`;
    this.system(`ATC started for ${this.callsign}, ${this.rules} ${route}.${this.station ? ` First contact: ${this.station.name} on ${fmtMhz(this.station.mhz)}.` : ''}`);
    this.changed();
  }

  stop() {
    this.reset(true);
    this.changed();
  }

  private reset(clearGround: boolean) {
    Object.assign(this, {
      active: false, phase: 'idle', dep: null, dest: null, station: null, checkedIn: false, depRunway: null, arrRunway: null,
      squawk: null, assignedAlt: null, assignedDir: null, cleared: false, takeoffCleared: false, approachCleared: false,
      landingCleared: false, descentIssued: false, vacateIssued: false, airborne: false, standName: null, pendingReadback: null,
      transcript: [], sector: null, lastHandoff: 0, lastRunwayOn: null,
    });
    this.allowedRunways = new Set();
    this.warned = new Set();
    if (clearGround) this.deps.ground.reset();
  }

  /** Resolves once every queued controller reply has been delivered. */
  idle(): Promise<void> {
    return this.queue;
  }

  private async loadAirport(ident: string | null): Promise<Airport | null> {
    if (!ident) return null;
    const details = await this.deps.airport(ident);
    if (!details) return null;
    return { details, stations: airportStations(details), label: airportLabel(details) };
  }

  // ---------------------------------------------------------------- Stations

  private unicom(a: Airport) {
    return unicomStation(a.details, a.stations);
  }
  private depGround() {
    const s = this.dep!.stations;
    return s.ground ?? s.tower ?? this.unicom(this.dep!);
  }
  private depDelivery() {
    const s = this.dep!.stations;
    return s.delivery ?? s.ground ?? s.tower ?? this.center();
  }
  private depTower() {
    return this.dep!.stations.tower ?? this.unicom(this.dep!);
  }
  private departureStation() {
    const s = this.dep!.stations;
    return s.departure ?? s.approach ?? this.center();
  }
  private arrivalApproach() {
    return this.dest!.stations.approach ?? this.center();
  }
  private destTower() {
    return this.dest!.stations.tower ?? this.unicom(this.dest!);
  }
  private destGround() {
    const s = this.dest!.stations;
    return s.ground ?? s.tower ?? this.unicom(this.dest!);
  }
  private center(): AtcStation {
    const t = this.t!;
    const sector = sectorOf(t.position.lat, t.position.lon);
    this.sector = sector;
    const c = sectorCentre(sector);
    const city = this.deps.nearest(c.lat, c.lon, 1, ['large'])[0]?.city?.split(/[,(/]/)[0].trim() || null;
    return centerStation(sector, city, this.usStyle);
  }

  private get usStyle() {
    return isUsStyle(this.dest?.details.ident ?? this.dep?.details.ident);
  }

  private setPhase(phase: AtcPhase, station: AtcStation | null, checkedIn: boolean) {
    this.phase = phase;
    if (station !== this.station) this.lastHandoff = Date.now();
    this.station = station;
    this.checkedIn = checkedIn || station?.role === 'unicom';
    this.changed();
  }

  private handoff(from: AtcStation | null, to: AtcStation | null, phase: AtcPhase, extra = '') {
    if (!to || (from && to.name === from.name && to.mhz === from.mhz)) {
      this.setPhase(phase, to, true);
      return;
    }
    if (!from || from.role === 'unicom') {
      this.setPhase(phase, to, false);
      return;
    }
    this.reply(from, `${extra}contact ${to.name} ${fmtMhz(to.mhz)}${phase === 'departure' || phase === 'vfr-enroute' ? ', good day' : ''}.`, () => this.setPhase(phase, to, false));
  }

  // ---------------------------------------------------------------- Messages

  private changed() {
    if (this.emitPending) return;
    this.emitPending = true;
    queueMicrotask(() => {
      this.emitPending = false;
      this.emit('state', this.state());
    });
  }

  private push(m: Omit<AtcMessage, 'id' | 'time'>) {
    this.transcript.push({ ...m, id: ++this.msgId, time: Date.now() });
    if (this.transcript.length > MAX_TRANSCRIPT) this.transcript.splice(0, this.transcript.length - MAX_TRANSCRIPT);
    this.changed();
  }

  private system(text: string, level: AtcMessage['level'] = 'info') {
    this.push({ from: 'system', station: 'SkyDeck', mhz: null, text, level });
  }

  private warn(key: string, text: string) {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.system(text, 'warning');
  }

  /** A controller answers after a short pause; `then` runs when the answer is heard. */
  private reply(station: AtcStation, text: string, then?: () => void) {
    this.busy++;
    this.changed();
    const delay = this.deps.replyDelayMs ?? 1800;
    const session = this.transcript;
    this.queue = this.queue
      .then(() => new Promise<void>((r) => setTimeout(r, delay)))
      .then(() => {
        // Dropped if ATC was stopped or restarted meanwhile.
        if (session !== this.transcript || !this.active) return;
        this.push({ from: 'atc', station: station.name, mhz: station.mhz, text: `${this.callsign}, ${text}` });
        then?.();
      })
      .finally(() => {
        this.busy = Math.max(0, this.busy - 1);
        this.changed();
      });
  }

  /** Sets what the pilot is expected to read back. */
  private expectReadback(text: string, reply?: () => void) {
    this.pendingReadback = { text: `${text}, ${this.callsign}.`, reply };
  }

  // ---------------------------------------------------------------- Pilot requests

  async request(id: string): Promise<void> {
    if (!this.active) throw new AtcError('Start ATC first.');
    if (this.busy) throw new AtcError('Wait for ATC to answer first.');
    const req = this.requests().find((r) => r.id === id);
    if (!req) throw new AtcError('That call is not possible right now.');
    if (this.station && !this.isTuned()) throw new AtcError(`Tune ${this.station.name} (${fmtMhz(this.station.mhz)}) on COM 1 or COM 2 first.`);
    this.push({ from: 'pilot', station: this.station?.name ?? '', mhz: this.station?.mhz ?? null, text: req.text });
    await this.handle(id as RequestId);
  }

  private requests(): AtcRequest[] {
    if (!this.active || !this.t) return [];
    const ids: Array<[RequestId, string, boolean?]> = [];
    if (this.pendingReadback) ids.push(['readback', 'Read back', true]);
    const st = this.station;
    const unicom = st?.role === 'unicom';
    switch (this.phase) {
      case 'preflight':
        if (this.rules === 'IFR') {
          if (!this.cleared && !this.busy) ids.push(['clearance', 'Request IFR clearance', true]);
        } else {
          ids.push(['taxi', unicom ? 'Announce taxi' : 'Request taxi', true]);
          if (!unicom) ids.push(['pushback', 'Request pushback']);
        }
        break;
      case 'cleared':
        ids.push(['taxi', unicom ? 'Announce taxi' : 'Request taxi', true]);
        if (!unicom) ids.push(['pushback', 'Request pushback']);
        break;
      case 'pushback':
        ids.push(['taxi', unicom ? 'Announce taxi' : 'Request taxi', true]);
        break;
      case 'taxi-out':
        ids.push(['at-holding', 'At the holding point']);
        break;
      case 'holding':
        ids.push(['ready', unicom ? 'Announce departure' : 'Ready for departure', true]);
        break;
      case 'departure':
        if (!this.checkedIn) ids.push(['checkin', 'Check in', true]);
        break;
      case 'enroute':
        if (!this.checkedIn) ids.push(['checkin', 'Check in', true]);
        if (!this.descentIssued) ids.push(['descent', 'Request descent']);
        break;
      case 'vfr-enroute':
        if (this.distTo(this.dest!) < 40) ids.push(['inbound', unicom || !this.dest!.stations.tower ? 'Announce inbound' : 'Call Tower inbound', true]);
        break;
      case 'approach':
        if (!this.checkedIn) ids.push(['checkin', 'Check in', true]);
        else if (!this.approachCleared) ids.push(['approach', 'Request approach clearance']);
        break;
      case 'final':
        if (!this.landingCleared) ids.push(['landing', unicom ? 'Announce final' : 'Request landing clearance', true]);
        ids.push(['goaround', 'Going around']);
        break;
      case 'landed':
        if (this.vacateIssued) ids.push(['taxi-in', unicom ? 'Announce taxi to parking' : 'Request taxi to parking', true]);
        break;
    }
    if (st && !unicom && this.transcript.some((m) => m.from === 'atc')) ids.push(['say-again', 'Say again']);
    const seen = new Set<string>();
    return ids
      .filter(([id]) => (seen.has(id) ? false : (seen.add(id), true)))
      .map(([id, label, primary]) => ({ id, label, text: this.pilotText(id), ...(primary ? { primary: true } : {}) }))
      .map((r, i, all) => (r.primary && all.some((x, j) => j < i && x.primary) ? { ...r, primary: undefined } : r));
  }

  private pilotText(id: RequestId): string {
    const st = this.station;
    const cs = this.callsign;
    const unicom = st?.role === 'unicom';
    const call = st ? `${st.name}, ${cs}` : cs;
    const atis = this.atisLetterPart();
    switch (id) {
      case 'readback':
        return this.pendingReadback?.text ?? '';
      case 'clearance':
        return `${call}, ${atis}request IFR clearance to ${this.dest!.details.ident}.`;
      case 'pushback': {
        const stand = this.currentStand();
        return `${call}, ${stand ? `at ${stand}, ` : ''}request pushback.`;
      }
      case 'taxi':
        if (unicom) return `${call} taxiing to runway ${this.departureRunway()}, ${this.dep!.label}.`;
        if (this.rules === 'VFR') return `${call}, ${aircraftType(this.t!.aircraft.atcModel)} VFR to ${this.dest!.details.ident}, ${atis}request taxi.`;
        return `${call}, request taxi.`;
      case 'at-holding':
        return `${call}, holding point runway ${this.departureRunway()}.`;
      case 'ready':
        return unicom ? `${call} departing runway ${this.departureRunway()}, ${this.dep!.label}.` : `${call}, holding point runway ${this.departureRunway()}, ready for departure.`;
      case 'checkin':
        return `${call}, ${this.levelReport()}${this.phase === 'approach' ? `, ${atis.replace(/, $/, '')}` : ''}.`.replace(/, \./, '.');
      case 'descent':
        return `${call}, request descent.`;
      case 'approach':
        return `${call}, request ${this.approachText()}.`;
      case 'landing':
        if (unicom) return `${call} final runway ${this.arrivalRunway()}, full stop, ${this.dest!.label}.`;
        return this.rules === 'IFR' ? `${call}, established ${this.approachShort()}.` : `${call}, final runway ${this.arrivalRunway()}.`;
      case 'goaround':
        return `${call}, going around.`;
      case 'taxi-in':
        if (unicom) return `${call} clear of runway ${this.arrivalRunway()}, taxiing to parking, ${this.dest!.label}.`;
        return `${call}, runway ${this.arrivalRunway()} vacated, request taxi to parking.`;
      case 'inbound': {
        const d = this.dest!.details;
        const dist = Math.round(this.distTo(this.dest!));
        const dir = COMPASS[Math.round(bearingDeg(d.lat, d.lon, this.t!.position.lat, this.t!.position.lon) / 45) % 8];
        const alt = fmtAlt(Math.round(this.t!.position.indicatedAltFt / 100) * 100, this.usStyle);
        if (unicom) return `${call}, ${dist} miles ${dir}, ${alt}, inbound for landing runway ${this.arrivalRunway()}, ${this.dest!.label}.`;
        return `${call}, ${dist} miles ${dir} of the field, ${alt}, inbound for landing${atis ? `, ${atis.replace(/, $/, '')}` : ''}.`;
      }
      case 'say-again':
        return `${call}, say again.`;
    }
  }

  private async handle(id: RequestId) {
    const st = this.station!;
    const unicom = st?.role === 'unicom';
    const t = this.t!;
    switch (id) {
      case 'readback': {
        const rb = this.pendingReadback;
        this.pendingReadback = null;
        rb?.reply?.();
        this.changed();
        return;
      }
      case 'say-again': {
        const last = [...this.transcript].reverse().find((m) => m.from === 'atc');
        if (last) this.reply(st, last.text.replace(`${this.callsign}, `, 'I say again, '));
        return;
      }
      case 'clearance': {
        const rwy = this.departureRunway();
        const p = this.planProcedures('departure');
        const dep = this.departureStation();
        this.initialAlt = Math.min(this.cruiseFt, Math.max(roundUp((this.dep!.details.elevFt ?? 0) + 4000, 1000), 3000));
        this.squawk = makeSquawk();
        const via = p?.sid ? `via the ${p.sid} departure${p.sidTransition ? `, ${p.sidTransition} transition` : ''}, then flight planned route` : 'via flight planned route';
        const alt = fmtAlt(this.initialAlt, this.usStyle);
        this.reply(st, `cleared to ${this.dest!.details.ident} ${via}, departure runway ${rwy}, climb ${alt}, expect ${fmtAlt(this.cruiseFt, this.usStyle)} ten minutes after departure, departure frequency ${fmtMhz(dep.mhz)}, squawk ${this.squawk}.`, () => {
          this.cleared = true;
          this.assignedAlt = this.initialAlt;
          this.assignedDir = 'climb';
          this.expectReadback(`Cleared to ${this.dest!.details.ident} ${via}, runway ${rwy}, climb ${alt}, departure ${fmtMhz(dep.mhz)}, squawk ${this.squawk}`, () => {
            const ground = this.depGround();
            if (ground.name === st.name) this.reply(st, 'readback correct, call me when ready for pushback or taxi.', () => this.setPhase('cleared', st, true));
            else this.reply(st, `readback correct. Contact ${ground.name} ${fmtMhz(ground.mhz)} for pushback and taxi.`, () => this.setPhase('cleared', ground, false));
          });
        });
        return;
      }
      case 'pushback':
        this.reply(st, 'push and start approved.', () => {
          this.setPhase('pushback', st, true);
          this.system('Use Simulator → Pushback (or your own tug) to push back. Request taxi when you are done.');
        });
        return;
      case 'taxi': {
        const rwy = this.departureRunway();
        const route = await this.deps.ground.plan(this.dep!.details.ident, here(t), { kind: 'runway', runway: rwy });
        this.deps.ground.setRoute(route);
        for (const c of route?.crossings ?? []) this.allowedRunways.add(c);
        const via = route?.via.length ? ` via ${route.via.join(', ')}` : '';
        const cross = route?.crossings.length ? `, cross runway ${route.crossings.join(', runway ')}` : '';
        const vfrSquawk = this.rules === 'VFR' && !this.squawk ? (this.usStyle ? '1200' : '7000') : null;
        if (vfrSquawk) this.squawk = vfrSquawk;
        const instr = `taxi to holding point runway ${rwy}${via}${cross}, hold short of runway ${rwy}`;
        if (unicom) {
          this.setPhase('taxi-out', st, true);
          this.system(route ? `Taxi route to runway ${rwy}${via || ' is on the map'}${cross}.` : `No taxiway data here: taxi to runway ${rwy} yourself.`);
          return;
        }
        this.reply(st, `${instr}${this.rules === 'VFR' ? `, ${fmtPressure(t.environment.seaLevelPressureMb, this.usStyle)}` : ''}${vfrSquawk ? `, squawk ${vfrSquawk}` : ''}.`, () => {
          this.setPhase('taxi-out', st, true);
          this.expectReadback(instr.replace(/^taxi to/, 'Taxi to').replace('hold short of', 'holding short'));
        });
        return;
      }
      case 'at-holding':
        this.reachHolding();
        return;
      case 'ready': {
        const rwy = this.departureRunway();
        this.allowedRunways.add(rwy);
        if (unicom) {
          this.takeoffCleared = true;
          this.setPhase('takeoff', st, true);
          return;
        }
        this.reply(st, `${this.windPhrase()}, runway ${rwy}, cleared for takeoff.`, () => {
          this.takeoffCleared = true;
          this.setPhase('takeoff', st, true);
          this.expectReadback(`Cleared for takeoff runway ${rwy}`);
        });
        return;
      }
      case 'checkin': {
        if (this.phase === 'departure') {
          const next = Math.min(this.cruiseFt, Math.max(this.assignedAlt ?? this.initialAlt, 15000));
          const verb = next > (this.assignedAlt ?? 0) ? 'climb' : 'maintain';
          this.reply(st, `${st.name}, radar contact. ${cap(verb)} ${fmtAlt(next, this.usStyle)}.`, () => {
            this.checkedIn = true;
            this.assign(next, 'climb');
            if (verb === 'climb') this.expectReadback(`Climb ${fmtAlt(next, this.usStyle)}`);
          });
        } else if (this.phase === 'enroute') {
          const climb = !this.descentIssued && (this.assignedAlt ?? 0) < this.cruiseFt;
          this.reply(st, `${st.name}, identified.${climb ? ` Climb ${fmtAlt(this.cruiseFt, this.usStyle)}.` : ''}`, () => {
            this.checkedIn = true;
            if (climb) {
              this.assign(this.cruiseFt, 'climb');
              this.expectReadback(`Climb ${fmtAlt(this.cruiseFt, this.usStyle)}`);
            }
          });
        } else if (this.phase === 'approach') {
          const rwy = this.arrivalRunway();
          const alt = this.approachAlt();
          const descend = alt < (this.assignedAlt ?? Infinity) || alt < t.position.indicatedAltFt - 300;
          this.reply(st, `${st.name}, radar contact. Expect ${this.approachText()}${descend ? `, descend ${fmtAlt(alt, this.usStyle)}` : ''}, ${fmtPressure(t.environment.seaLevelPressureMb, this.usStyle)}.`, () => {
            this.checkedIn = true;
            this.arrRunway = rwy;
            if (descend) {
              this.assign(alt, 'descend');
              this.expectReadback(`Descend ${fmtAlt(alt, this.usStyle)}, ${fmtPressure(t.environment.seaLevelPressureMb, this.usStyle)}`);
            }
          });
        }
        return;
      }
      case 'descent':
        this.issueDescent(st);
        return;
      case 'approach':
        this.clearApproach(st);
        return;
      case 'landing': {
        const rwy = this.arrivalRunway();
        this.allowedRunways.add(rwy);
        if (unicom) {
          this.landingCleared = true;
          this.changed();
          return;
        }
        this.reply(st, `${this.windPhrase()}, runway ${rwy}, cleared to land.`, () => {
          this.landingCleared = true;
          this.checkedIn = true;
          this.expectReadback(`Cleared to land runway ${rwy}`);
        });
        return;
      }
      case 'goaround': {
        const app = this.arrivalApproach();
        const alt = this.approachAlt();
        this.landingCleared = false;
        this.approachCleared = false;
        if (unicom) {
          if (this.rules === 'IFR') this.setPhase('approach', app, false);
          return;
        }
        if (this.rules === 'VFR') {
          this.reply(st, `roger, join the circuit for runway ${this.arrivalRunway()}, report final.`);
          return;
        }
        this.reply(st, `roger, fly runway heading, climb ${fmtAlt(alt, this.usStyle)}, contact ${app.name} ${fmtMhz(app.mhz)}.`, () => {
          this.assign(alt, 'climb');
          this.setPhase('approach', app, false);
        });
        return;
      }
      case 'taxi-in': {
        const ident = this.dest!.details.ident;
        const stand = await this.standForArrival();
        const route = stand ? await this.deps.ground.plan(ident, here(t), { kind: 'stand', index: stand.index }) : null;
        this.deps.ground.setRoute(route);
        this.standName = stand?.name ?? null;
        for (const c of route?.crossings ?? []) this.allowedRunways.add(c);
        const via = route?.via.length ? ` via ${route.via.join(', ')}` : '';
        const cross = route?.crossings.length ? `, cross runway ${route.crossings.join(', runway ')}` : '';
        const instr = `taxi to ${stand ? stand.name.replace(/^Gate /, 'gate ').replace(/^Parking /, 'parking ') : 'parking'}${via}${cross}`;
        if (unicom) {
          this.setPhase('taxi-in', st, true);
          this.system(route ? `Taxi route to ${stand!.name}${via}${cross}.` : 'No taxiway data here: taxi to parking yourself.');
          return;
        }
        this.reply(st, `${instr}.`, () => {
          this.setPhase('taxi-in', st, true);
          this.expectReadback(cap(instr));
        });
        return;
      }
      case 'inbound': {
        const tower = this.destTower();
        const rwy = this.arrivalRunway();
        this.allowedRunways.add(rwy);
        if (tower.role === 'unicom' || unicom) {
          this.setPhase('final', tower, true);
          return;
        }
        this.reply(tower, `${tower.name}, runway ${rwy}, ${fmtPressure(t.environment.seaLevelPressureMb, this.usStyle)}, join final runway ${rwy}, report final.`, () => {
          this.setPhase('final', tower, true);
          this.expectReadback(`Runway ${rwy}, join final, wilco`);
        });
        return;
      }
    }
  }

  // ---------------------------------------------------------------- Controller-initiated calls

  private reachHolding() {
    const tower = this.depTower();
    const st = this.station!;
    if (st.name === tower.name || st.role === 'unicom') {
      this.setPhase('holding', st, true);
      return;
    }
    this.reply(st, `hold short of runway ${this.departureRunway()}, contact ${tower.name} ${fmtMhz(tower.mhz)}.`, () => this.setPhase('holding', tower, false));
  }

  private issueDescent(st: AtcStation) {
    const target = this.descentTarget();
    this.descentIssued = true;
    this.reply(st, `descend ${fmtAlt(target, this.usStyle)}.`, () => {
      this.assign(target, 'descend');
      this.expectReadback(`Descend ${fmtAlt(target, this.usStyle)}`);
    });
  }

  private clearApproach(st: AtcStation) {
    const alt = this.approachAlt();
    const text = this.approachText();
    this.approachCleared = true;
    const visual = text.startsWith('visual');
    this.reply(st, visual ? `cleared ${text}.` : `cleared ${text}, maintain ${fmtAlt(alt, this.usStyle)} until established.`, () => {
      this.expectReadback(`Cleared ${text}`);
    });
  }

  private assign(alt: number, dir: 'climb' | 'descend') {
    this.assignedAlt = alt;
    this.assignedDir = dir;
    for (const k of [...this.warned]) if (k.startsWith('alt-')) this.warned.delete(k);
    this.changed();
  }

  // ---------------------------------------------------------------- Live monitoring

  update(t: Telemetry | null) {
    if (!t) return;
    const wasTuned = this.t ? this.isTuned() : false;
    this.t = t;
    if (!this.active) return;
    if (this.isTuned() !== wasTuned) this.changed();
    const g = this.deps.ground.state;
    const onGround = t.position.onGround;
    const agl = t.position.aglFt;
    if (!onGround && agl > 100) this.airborne = true;

    this.checkCompliance(t);
    if (this.busy) return;

    switch (this.phase) {
      case 'taxi-out': {
        const near = g.route?.to.kind === 'runway' && g.progress ? g.progress.remainingM < 80 && t.speed.gs < 15 : this.nearDepartureThreshold();
        if (near) this.reachHolding();
        if (!onGround) this.leaveGround();
        break;
      }
      case 'preflight':
      case 'cleared':
      case 'pushback':
      case 'holding':
        if (!onGround && agl > 100) this.leaveGround();
        break;
      case 'takeoff':
        if (!onGround && agl > 400) this.leaveGround();
        break;
      case 'departure': {
        const dist = this.distTo(this.dep!);
        // Out of the terminal area, or nearly up to the assigned level a little way out.
        const toCenter = dist > 30 || (this.checkedIn && dist > 12 && t.position.indicatedAltFt > (this.assignedAlt ?? 0) - 1500);
        if (toCenter) this.handoff(this.station, this.center(), 'enroute');
        break;
      }
      case 'enroute':
      case 'vfr-enroute': {
        const destDist = this.distTo(this.dest!);
        if (this.phase === 'vfr-enroute' && destDist < 40 && !this.station) {
          const tower = this.destTower();
          this.setPhase('vfr-enroute', tower, false);
          this.system(`${this.dest!.details.ident} is ${Math.round(destDist)} nm away. Tune ${tower.name} ${fmtMhz(tower.mhz)} and call inbound.`);
        }
        if (this.phase === 'enroute') {
          if (destDist < 40) {
            this.handoff(this.station, this.arrivalApproach(), 'approach');
            break;
          }
          const target = this.descentTarget();
          const tod = ((t.position.indicatedAltFt - target) / 1000) * 3 + 15;
          if (!this.descentIssued && this.cruiseFt > 12000 && t.position.indicatedAltFt > target + 2000 && destDist < tod && this.station) {
            this.issueDescent(this.station);
            break;
          }
          const sector = sectorOf(t.position.lat, t.position.lon);
          if (this.station?.role === 'center' && sector !== this.sector && Date.now() - this.lastHandoff > 120_000) {
            this.handoff(this.station, this.center(), 'enroute');
          }
        }
        break;
      }
      case 'approach': {
        const thr = this.thresholdDist();
        if (this.checkedIn && !this.approachCleared && thr < 18) this.clearApproach(this.station!);
        else if (thr < 10 && (this.approachCleared || !this.checkedIn)) {
          const tower = this.destTower();
          if (tower.role === 'unicom') {
            if (this.station && this.station.role !== 'unicom') this.reply(this.station, 'change to advisory frequency approved.', () => this.setPhase('final', tower, true));
            else this.setPhase('final', tower, true);
          } else this.handoff(this.station, tower, 'final');
        }
        break;
      }
      case 'final':
        if (onGround && this.airborne) {
          if (!this.landingCleared && this.station?.role !== 'unicom') this.warn('land-noclear', 'You landed without a landing clearance.');
          this.allowedRunways.add(this.arrivalRunway());
          this.setPhase('landed', this.station, true);
        }
        break;
      case 'landed':
        if (!this.vacateIssued && onGround && t.speed.gs < 40) {
          this.vacateIssued = true;
          const ground = this.destGround();
          const st = this.station!;
          if (st.role === 'unicom' || ground.name === st.name) this.changed();
          else this.reply(st, `vacate runway when able, contact ${ground.name} ${fmtMhz(ground.mhz)} when vacated.`, () => this.setPhase('landed', ground, false));
        }
        break;
      case 'taxi-in': {
        const arrived = g.route?.to.kind === 'stand' ? !!g.progress?.arrived : t.speed.gs < 1 && !g.runway && (t.systems.parkingBrake || t.engines.list.every((e) => !e.running));
        if (arrived) {
          this.phase = 'parked';
          this.pendingReadback = null;
          this.system(`Parked${this.standName ? ` at ${this.standName}` : ''}. Welcome to ${this.dest!.label}! Flight complete.`);
        }
        break;
      }
    }
  }

  private leaveGround() {
    if (!this.takeoffCleared && this.depTower().role !== 'unicom') this.warn('takeoff-noclear', 'You took off without a takeoff clearance.');
    this.takeoffCleared = true;
    this.pendingReadback = null;
    this.deps.ground.setRoute(null);
    this.allowedRunways.clear();
    const st = this.station;
    if (this.rules === 'IFR') {
      this.assignedAlt ??= this.initialAlt || this.cruiseFt;
      this.assignedDir = 'climb';
      const dep = this.departureStation();
      if (st && st.role !== 'unicom' && st.role !== 'tower') this.setPhase('departure', dep, false);
      else this.handoff(st, dep, 'departure');
    } else if (st && st.role === 'tower') {
      this.reply(st, 'frequency change approved, good day.', () => this.setPhase('vfr-enroute', null, true));
      this.phase = 'vfr-enroute';
    } else this.setPhase('vfr-enroute', null, true);
  }

  private checkCompliance(t: Telemetry) {
    const g = this.deps.ground.state;
    const onGround = t.position.onGround;
    const st = this.station;
    if (onGround && t.speed.gs > 5 && t.systems.pushbackState === 3 && ['preflight', 'cleared', 'pushback'].includes(this.phase) && st?.role !== 'unicom') {
      this.warn('taxi-noclear', 'You are taxiing without a taxi clearance. Ask Ground for taxi first.');
    }
    // Runway incursions: being on a runway nobody cleared you onto.
    if (onGround && g.runway) {
      const allowed = g.runway.split('/').some((i) => this.allowedRunways.has(i));
      if (!allowed && g.runway !== this.lastRunwayOn && st?.role !== 'unicom' && this.phase !== 'parked' && this.phase !== 'preflight') {
        this.system(`Runway incursion: you are on runway ${g.runway} without a clearance. Leave the runway or hold position.`, 'warning');
      }
      this.lastRunwayOn = g.runway;
    } else this.lastRunwayOn = null;
    // Taxi route deviation.
    if (onGround && g.progress && g.progress.offRouteM > 60 && t.speed.gs > 3 && (this.phase === 'taxi-out' || this.phase === 'taxi-in')) {
      this.warn(`offroute-${g.route?.lengthM}`, 'You have left the taxi route. Check the map and rejoin it.');
    }
    // Altitude.
    if (!onGround && this.assignedAlt != null && ['departure', 'enroute', 'approach'].includes(this.phase)) {
      const alt = t.position.indicatedAltFt;
      const bust = this.assignedDir === 'descend' ? alt < this.assignedAlt - 400 && this.phase !== 'approach' : alt > this.assignedAlt + 400;
      if (bust) this.warn(`alt-${this.assignedAlt}`, `Check your altitude: you are cleared to ${fmtAlt(this.assignedAlt, this.usStyle)}.`);
    }
    // Squawk.
    if (!onGround && this.squawk && this.airborne && t.radios.xpdrCode !== this.squawk && t.position.aglFt > 1500) {
      this.warn(`squawk-${this.squawk}`, `Your transponder shows ${t.radios.xpdrCode}; ATC assigned squawk ${this.squawk}.`);
    }
  }

  // ---------------------------------------------------------------- Helpers

  private isTuned(): boolean {
    const st = this.station;
    const t = this.t;
    if (!st || !t) return true;
    return [t.radios.com1.active, t.radios.com2.active].some((f) => Math.abs(f - st.mhz) < 0.004);
  }

  private distTo(a: Airport): number {
    const t = this.t!;
    return distanceNm(t.position.lat, t.position.lon, a.details.lat, a.details.lon);
  }

  private windPhrase(): string {
    const t = this.t!;
    return fmtWind(t.environment.windDir - t.attitude.magVar, t.environment.windKt);
  }

  private departureRunway(): string {
    if (!this.depRunway) {
      const t = this.t!;
      const pref = this.planProcedures('departure').departureRunway;
      this.depRunway = chooseRunway(this.dep!.details, t.environment.windDir, t.environment.windKt, pref)?.ident ?? pref ?? '—';
    }
    return this.depRunway;
  }

  /** Decided once within 60 nm, where the wind at the aircraft says something about the wind at the airport. */
  private arrivalRunway(): string {
    if (this.arrRunway) return this.arrRunway;
    const t = this.t!;
    const pref = this.planProcedures('arrival').arrivalRunway;
    const near = this.distTo(this.dest!) < 60;
    const rwy = chooseRunway(this.dest!.details, t.environment.windDir, near ? t.environment.windKt : 0, pref)?.ident ?? pref ?? '—';
    if (near || pref) this.arrRunway = rwy;
    return rwy;
  }

  /** The flight plan's procedures, only when the plan starts / ends at the airports ATC is using. */
  private planProcedures(side: 'departure' | 'arrival'): FlightPlan['procedures'] {
    const plan = this.deps.plan();
    const wps = plan?.waypoints ?? [];
    const ident = side === 'departure' ? wps[0]?.ident : wps[wps.length - 1]?.ident;
    const ours = side === 'departure' ? this.dep?.details.ident : this.dest?.details.ident;
    return plan && ident && ident === ours ? plan.procedures : {};
  }

  private thresholdDist(): number {
    const end = this.dest!.details.runways.flatMap((r) => r.ends).find((e) => e.ident === this.arrivalRunway());
    const t = this.t!;
    if (end?.lat == null || end.lon == null) return this.distTo(this.dest!);
    return distanceNm(t.position.lat, t.position.lon, end.lat, end.lon);
  }

  private nearDepartureThreshold(): boolean {
    const t = this.t!;
    const found = runwayEnd(runwayGeoms(this.dep!.details), this.departureRunway());
    if (!found) return false;
    const { along, lateral } = runwayFrame(found.rw, t.position.lat, t.position.lon, found.end);
    return lateral < 250 && along < 600 && along > -300 && t.speed.gs < 10;
  }

  private approachAlt(): number {
    return roundUp((this.dest!.details.elevFt ?? 0) + 2500, 500);
  }

  private descentTarget(): number {
    return Math.max(roundUp((this.dest!.details.elevFt ?? 0) + 4000, 1000), Math.min(this.cruiseFt - 2000, 10000));
  }

  /** e.g. "ILS approach runway 27" or "visual approach runway 27". */
  private approachText(): string {
    const name = this.approachName();
    const rwy = this.arrivalRunway();
    return name ? `${name} approach runway ${rwy}` : `visual approach runway ${rwy}`;
  }

  private approachShort(): string {
    const name = this.approachName();
    return `${name ?? 'visual'} runway ${this.arrivalRunway()}`;
  }

  private approachName(): string | null {
    if (this.rules === 'VFR') return null;
    const rwy = this.arrivalRunway();
    const typeOf = (name: string) => name.split(' ')[0];
    const planned = this.planProcedures('arrival').approach;
    if (planned && planned.includes(rwy)) return typeOf(planned);
    const procs = (this.dest!.details.procedures?.approaches ?? []).filter((p) => p.runways.includes(rwy)).map((p) => p.name);
    for (const re of [/^ILS/, /^(RNAV|GPS)/, /^LOC/, /./]) {
      const hit = procs.find((n) => re.test(n));
      if (hit) return typeOf(hit);
    }
    return null;
  }

  private levelReport(): string {
    const t = this.t!;
    const alt = Math.round(t.position.indicatedAltFt / 100) * 100;
    const vs = t.speed.vsFpm;
    const target = this.assignedAlt;
    if (target != null && Math.abs(target - alt) > 300 && Math.abs(vs) > 300) {
      return `passing ${fmtAlt(alt, this.usStyle)}, ${vs > 0 ? 'climbing' : 'descending'} ${fmtAlt(target, this.usStyle)}`;
    }
    return fmtAlt(alt, this.usStyle);
  }

  private currentStand(): string | null {
    const t = this.t;
    return t ? this.deps.ground.standHere(t.position.lat, t.position.lon)?.name ?? null : null;
  }

  private async standForArrival() {
    const ident = this.dest!.details.ident;
    const assigned = this.deps.ground.assignedStand;
    if (assigned?.airport === ident) return assigned.stand;
    const g = await this.deps.ground.ground(ident);
    if (!g) return null;
    const t = this.t!;
    const stand = pickStand(g, { large: t.weight.maxGrossLbs > 150_000, small: t.weight.maxGrossLbs < 12_500, seed: this.callsign });
    if (stand) this.deps.ground.assignStand(ident, stand);
    return stand;
  }

  private atisLetterPart(): string {
    const a = this.atisInfo();
    return a ? `information ${a.letter}, ` : '';
  }

  private atisInfo(): AtcState['atis'] {
    if (!this.active || !this.t) return null;
    const ap = ['preflight', 'cleared', 'pushback', 'taxi-out', 'holding'].includes(this.phase) ? this.dep : ['parked', 'taxi-in', 'landed'].includes(this.phase) ? null : this.dest;
    if (!ap) return null;
    const t = this.t;
    const d = ap.details;
    const near = this.distTo(ap) < 30;
    const zulu = Math.floor(t.sim.zuluSeconds / 3600);
    let h = 0;
    for (const ch of d.ident) h += ch.charCodeAt(0);
    const letter = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[(zulu + h) % 26];
    const rwy = ap === this.dep ? this.departureRunway() : this.arrivalRunway();
    const parts = [`${ap.label} information ${letter}, time ${String(zulu).padStart(2, '0')}00Z.`];
    if (near) parts.push(`${cap(this.windPhrase())}.`);
    parts.push(`Runway in use ${rwy}.`);
    if (near) parts.push(`Temperature ${Math.round(t.environment.oatC)}, ${fmtPressure(t.environment.seaLevelPressureMb, isUsStyle(d.ident))}.`);
    else parts.push('Weather is reported once you are within 30 nm.');
    parts.push(`Advise on initial contact you have information ${letter}.`);
    return { airport: d.ident, letter, text: parts.join(' '), mhz: ap.stations.atis?.mhz ?? null };
  }

  // ---------------------------------------------------------------- State for the UI

  state(): AtcState {
    const t = this.t;
    return {
      active: this.active,
      callsign: this.callsign,
      phase: this.phase,
      phaseLabel: this.phaseLabel(),
      rules: this.rules,
      departure: this.dep?.details.ident ?? null,
      destination: this.dest?.details.ident ?? null,
      station: this.station,
      tuned: this.isTuned(),
      busy: this.busy > 0,
      requests: t ? this.requests() : [],
      transcript: this.transcript,
      assigned: { altitudeFt: this.assignedAlt, squawk: this.squawk, runway: this.active ? (this.airborne ? this.arrRunway : this.depRunway) : null, stand: this.standName },
      hint: this.hint(),
      atis: this.atisInfo(),
    };
  }

  private phaseLabel(): string {
    const rwyOut = this.depRunway ?? '';
    switch (this.phase) {
      case 'idle': return 'ATC is off';
      case 'preflight': return this.rules === 'IFR' ? 'At the gate: get your clearance' : 'At the gate: ready to taxi';
      case 'cleared': return 'Cleared: ready for pushback or taxi';
      case 'pushback': return 'Pushing back';
      case 'taxi-out': return `Taxiing to runway ${rwyOut}`;
      case 'holding': return `Holding short of runway ${rwyOut}`;
      case 'takeoff': return `Taking off from runway ${rwyOut}`;
      case 'departure': return 'Climbing out';
      case 'enroute': return 'En route';
      case 'vfr-enroute': return 'En route (VFR)';
      case 'approach': return `Approach into ${this.dest?.details.ident ?? ''}`;
      case 'final': return `Final, runway ${this.arrRunway ?? ''}`;
      case 'landed': return 'Landed: vacate the runway';
      case 'taxi-in': return `Taxiing to ${this.standName ?? 'parking'}`;
      case 'parked': return 'Parked: flight complete';
    }
  }

  private hint(): string | null {
    if (!this.active) return null;
    const st = this.station;
    if (this.pendingReadback) return 'Read the clearance back.';
    if (st && !this.isTuned()) return `Tune ${st.name} ${fmtMhz(st.mhz)} on COM 1 or COM 2.`;
    const alt = this.assignedAlt != null ? fmtAlt(this.assignedAlt, this.usStyle) : '';
    switch (this.phase) {
      case 'preflight': return this.rules === 'IFR' && !this.cleared ? 'Request your IFR clearance.' : 'Request taxi when you are ready to go.';
      case 'cleared': return 'Request pushback if you are at a gate, otherwise request taxi.';
      case 'pushback': return 'Push back, start up, then request taxi.';
      case 'taxi-out': return `Follow the taxi route on the map and hold short of runway ${this.departureRunway()}.`;
      case 'holding': return 'Tell Tower when you are ready for departure.';
      case 'takeoff': return 'Take off. Tower hands you over once you are airborne.';
      case 'departure': return this.checkedIn ? `Climb to ${alt}.` : `Check in with ${st?.name ?? 'Departure'}.`;
      case 'enroute': return this.checkedIn ? (this.descentIssued ? `Descend to ${alt}.` : `Cruise at ${alt}. ATC starts your descent.`) : `Check in with ${st?.name ?? 'Control'}.`;
      case 'vfr-enroute': return this.distTo(this.dest!) < 40 ? `Call ${this.destTower().name} inbound.` : `Fly to ${this.dest!.details.ident}. Call the tower about 20 nm out.`;
      case 'approach': return !this.checkedIn ? `Check in with ${st?.name ?? 'Approach'}.` : this.approachCleared ? `Fly the ${this.approachText()}. Tower is next.` : `Descend to ${alt} and expect the ${this.approachText()}.`;
      case 'final': return this.landingCleared ? `Cleared to land runway ${this.arrivalRunway()}.` : 'Ask Tower for your landing clearance.';
      case 'landed': return this.vacateIssued ? 'Vacate the runway, then ask Ground for taxi to parking.' : 'Slow down and vacate the runway.';
      case 'taxi-in': return `Follow the route to ${this.standName ?? 'parking'}, then set the parking brake.`;
      case 'parked': return 'Shut down and enjoy. Stop ATC or start it again for the next flight.';
      default: return null;
    }
  }
}

/** "TT:ATCCOM.AC_MODEL_C172.0.text" → "C172". */
export function aircraftType(model: string): string {
  const m = /AC_MODEL[_ ]?([A-Z0-9]+)/i.exec(model);
  return (m ? m[1] : model.trim()) || 'aircraft';
}

const here = (t: Telemetry) => ({ lat: t.position.lat, lon: t.position.lon, headingTrue: t.attitude.hdgTrue });
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** A believable discrete squawk: avoids VFR and emergency codes. */
export function makeSquawk(): string {
  for (;;) {
    const code = [1 + Math.floor(Math.random() * 6), ...Array.from({ length: 3 }, () => Math.floor(Math.random() * 8))].join('');
    if (!['1200', '2000', '7000'].includes(code)) return code;
  }
}

