// A simulated aircraft so SkyDeck can be explored without the simulator running.
// The flight model is intentionally simple: enough for the map, autopilot and radios to behave believably.
import { EventEmitter } from 'node:events';
import type { Command, FlightPlan, LightName, Telemetry } from '../../shared/types.js';
import { angleDiff, bearingDeg, destinationPoint, distanceNm, normalizeDeg } from '../../shared/geo.js';
import { eventsForCommand, isValidSquawk, simRateSteps, validRadioMhz } from './events.js';
import { CommandError, type SimBridge } from './types.js';

const TICK_MS = 66;
const MAG_VAR = 4; // degrees east, roughly right for the eastern Mediterranean

function initialState(): Telemetry {
  return {
    time: Date.now(),
    aircraft: { title: 'SkyDeck demo aircraft (Cessna 172, simulated)', atcId: 'SKY-DEMO', atcModel: 'C172' },
    // Start south-west of Heraklion (LGIR), Crete.
    position: { lat: 35.25, lon: 25.0, altFt: 4500, indicatedAltFt: 4500, aglFt: 4500, onGround: false },
    speed: { ias: 115, tas: 123, gs: 120, mach: 0.18, vsFpm: 0 },
    attitude: { hdgMag: 50, hdgTrue: 54, trackTrue: 54, pitch: 1.5, bank: 0, magVar: MAG_VAR },
    environment: { windDir: 320, windKt: 12, oatC: 16, baroInHg: 29.92, seaLevelPressureMb: 1013.2 },
    autopilot: {
      available: true, master: true, flightDirector: true, yawDamper: false, autothrottle: false,
      hdgMode: true, navMode: false, aprMode: false, bcMode: false, altMode: true, vsMode: false, flcMode: false,
      spdMode: false, levelMode: false, glideslopeActive: false, hdg: 50, alt: 4500, vs: 500, spd: 115, gpsDrivesNav: true,
    },
    radios: {
      com1: { active: 118.3, standby: 121.5 },
      com2: { active: 124.85, standby: 122.8 },
      nav1: { active: 110.3, standby: 114.5, obs: 270, dmeNm: null, hasSignal: false },
      nav2: { active: 113.1, standby: 116.7, obs: 90, dmeNm: null, hasSignal: false },
      adfKhz: 350, adfStandbyKhz: 410, xpdrCode: '7000', xpdrState: 4,
    },
    lights: { nav: true, beacon: true, strobe: true, landing: false, taxi: false, logo: false, wing: false, recognition: false, panel: false, cabin: false },
    systems: {
      gearRetractable: false, gearDown: true, gearPct: 100, flapsIndex: 0, flapsPositions: 3, flapsPct: 0,
      spoilersAvailable: false, spoilersPct: 0, spoilersArmed: false, parkingBrake: false, battery: true, avionics: true,
      pitotHeat: false, pushbackState: 3, doorPct: 0,
    },
    engines: { count: 1, type: 0, list: [{ running: true, rpm: 2350, n1: 0, fuelFlowGph: 8.4, throttlePct: 72 }] },
    fuel: { totalGal: 40, capacityGal: 53, totalLbs: 240, lbsPerGal: 6 },
    weight: { totalLbs: 2300, maxGrossLbs: 2550, emptyLbs: 1680 },
    sim: { paused: false, rate: 1, slew: false, zuluSeconds: 10 * 3600, localSeconds: 13 * 3600, zuluDayOfYear: 180, zuluYear: 2026 },
    gps: {
      hasPlan: false, isDirectTo: false, wpIndex: 0, wpCount: 0, nextId: '', nextLat: 0, nextLon: 0, prevId: '', prevLat: 0, prevLon: 0,
      distNm: 0, eteSec: 0, destEteSec: 0, bearingMag: 0, xtkNm: 0,
    },
  };
}

export class DemoBridge extends EventEmitter implements SimBridge {
  readonly kind = 'demo' as const;
  readonly connected = true;
  readonly inFlight = true;
  readonly simName = 'Demo aircraft';
  private s = initialState();
  private timer: NodeJS.Timeout | null = null;
  private last = Date.now();
  private route: Array<{ ident: string; lat: number; lon: number }> = [];

  start(): void {
    if (this.timer) return;
    this.last = Date.now();
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private tick() {
    const now = Date.now();
    const s = this.s;
    const dt = s.sim.paused ? 0 : ((now - this.last) / 1000) * s.sim.rate;
    this.last = now;
    if (dt > 0 && !s.sim.slew) this.fly(dt);
    s.time = now;
    this.emit('telemetry', structuredClone(s));
  }

  private fly(dt: number) {
    const s = this.s;
    const ap = s.autopilot;
    const onGround = s.position.onGround;

    // --- Lateral: pick a target heading, bank towards it.
    let targetHdg: number | null = null;
    if (ap.master && ap.navMode && s.gps.hasPlan) targetHdg = normalizeDeg(s.gps.bearingMag);
    else if (ap.master && ap.hdgMode) targetHdg = ap.hdg;
    else if (ap.master && ap.levelMode) targetHdg = null;
    let targetBank = 0;
    if (targetHdg != null) targetBank = Math.max(-25, Math.min(25, angleDiff(targetHdg, s.attitude.hdgMag) * 1.5));
    if (onGround) targetBank = 0;
    s.attitude.bank += Math.max(-5 * dt, Math.min(5 * dt, targetBank - s.attitude.bank));
    const tas = Math.max(s.speed.tas, 40);
    const turnRate = (1091 * Math.tan((s.attitude.bank * Math.PI) / 180)) / tas;
    s.attitude.hdgMag = normalizeDeg(s.attitude.hdgMag + turnRate * dt);
    s.attitude.hdgTrue = normalizeDeg(s.attitude.hdgMag + MAG_VAR);

    // --- Speed.
    const throttle = s.engines.list[0]?.running ? s.engines.list[0].throttlePct : 0;
    let targetIas = onGround ? 0 : 60 + throttle * 0.8 - s.systems.flapsIndex * 6;
    if (ap.master && (ap.spdMode || ap.autothrottle || ap.flcMode)) targetIas = ap.spd;
    s.speed.ias += Math.max(-3 * dt, Math.min(3 * dt, targetIas - s.speed.ias));

    // --- Vertical.
    let targetVs = 0;
    if (ap.master) {
      const toAlt = ap.alt - s.position.altFt;
      if (ap.altMode && !ap.vsMode && !ap.flcMode) targetVs = Math.max(-1000, Math.min(1000, toAlt * 3));
      else if (ap.vsMode) targetVs = ap.vs;
      else if (ap.flcMode) targetVs = toAlt > 0 ? 700 : -900;
      // Capture the selected altitude from VS / FLC.
      if ((ap.vsMode || ap.flcMode) && Math.abs(toAlt) < Math.abs(targetVs) / 10 + 50) {
        ap.vsMode = false;
        ap.flcMode = false;
        ap.altMode = true;
      }
    }
    if (onGround) targetVs = 0;
    s.speed.vsFpm += Math.max(-600 * dt, Math.min(600 * dt, targetVs - s.speed.vsFpm));
    s.position.altFt = Math.max(0, s.position.altFt + (s.speed.vsFpm / 60) * dt);
    s.attitude.pitch = 1.5 + s.speed.vsFpm / 250;

    // --- Ground track with wind.
    s.speed.tas = s.speed.ias * (1 + s.position.altFt / 1000 * 0.02);
    const windFrom = s.environment.windDir;
    const vx = s.speed.tas * Math.sin((s.attitude.hdgTrue * Math.PI) / 180) - s.environment.windKt * Math.sin((windFrom * Math.PI) / 180);
    const vy = s.speed.tas * Math.cos((s.attitude.hdgTrue * Math.PI) / 180) - s.environment.windKt * Math.cos((windFrom * Math.PI) / 180);
    s.speed.gs = Math.hypot(vx, vy);
    s.attitude.trackTrue = normalizeDeg((Math.atan2(vx, vy) * 180) / Math.PI);
    const p = destinationPoint(s.position.lat, s.position.lon, s.attitude.trackTrue, (s.speed.gs * dt) / 3600);
    s.position.lat = p.lat;
    s.position.lon = p.lon;
    s.position.indicatedAltFt = s.position.altFt + (s.environment.baroInHg - 29.92) * 1000;
    s.position.aglFt = s.position.altFt;
    s.speed.mach = s.speed.tas / 661;

    // --- Fuel, time.
    const ff = s.engines.list.reduce((a, e) => a + (e.running ? e.fuelFlowGph : 0), 0);
    s.fuel.totalGal = Math.max(0, s.fuel.totalGal - (ff / 3600) * dt);
    s.fuel.totalLbs = s.fuel.totalGal * s.fuel.lbsPerGal;
    s.sim.zuluSeconds = (s.sim.zuluSeconds + dt) % 86400;
    s.sim.localSeconds = (s.sim.localSeconds + dt) % 86400;

    // --- Radios: pretend a DME station sits at LGIR.
    s.radios.nav1.dmeNm = Math.round(distanceNm(s.position.lat, s.position.lon, 35.3397, 25.1803) * 10) / 10;
    s.radios.nav1.hasSignal = s.radios.nav1.dmeNm < 60;

    this.updateGps();
  }

  private updateGps() {
    const s = this.s;
    const g = s.gps;
    if (!g.hasPlan || !this.route.length) return;
    let next = this.route[g.wpIndex];
    let dist = distanceNm(s.position.lat, s.position.lon, next.lat, next.lon);
    if (dist < 0.6 && g.wpIndex < this.route.length - 1) {
      g.wpIndex += 1;
      next = this.route[g.wpIndex];
      dist = distanceNm(s.position.lat, s.position.lon, next.lat, next.lon);
    }
    const prev = this.route[Math.max(0, g.wpIndex - 1)];
    const gs = Math.max(s.speed.gs, 30);
    let remaining = dist;
    for (let i = g.wpIndex; i < this.route.length - 1; i++) {
      remaining += distanceNm(this.route[i].lat, this.route[i].lon, this.route[i + 1].lat, this.route[i + 1].lon);
    }
    Object.assign(g, {
      nextId: next.ident, nextLat: next.lat, nextLon: next.lon,
      prevId: prev.ident, prevLat: prev.lat, prevLon: prev.lon,
      distNm: Math.round(dist * 10) / 10,
      eteSec: Math.round((dist / gs) * 3600),
      destEteSec: Math.round((remaining / gs) * 3600),
      bearingMag: normalizeDeg(bearingDeg(s.position.lat, s.position.lon, next.lat, next.lon) - MAG_VAR),
    });
  }

  async command(cmd: Command): Promise<void> {
    const s = this.s;
    const ap = s.autopilot;
    // Validate exactly like the real simulator path would.
    eventsForCommand(cmd, s);
    switch (cmd.type) {
      case 'ap.toggle': {
        const map = { master: 'master', flightDirector: 'flightDirector', yawDamper: 'yawDamper', autothrottle: 'autothrottle', hdg: 'hdgMode', nav: 'navMode', apr: 'aprMode', bc: 'bcMode', alt: 'altMode', vs: 'vsMode', flc: 'flcMode', spd: 'spdMode', level: 'levelMode', cdiSource: 'gpsDrivesNav' } as const;
        const key = map[cmd.mode];
        ap[key] = !ap[key];
        // Lateral and vertical modes are mutually exclusive within their axis.
        if (ap[key]) {
          if (cmd.mode === 'hdg') ap.navMode = ap.levelMode = false;
          if (cmd.mode === 'nav') ap.hdgMode = ap.levelMode = false;
          if (cmd.mode === 'level') ap.hdgMode = ap.navMode = false;
          if (cmd.mode === 'vs') ap.flcMode = false;
          if (cmd.mode === 'flc') { ap.vsMode = false; ap.spd = Math.round(s.speed.ias); }
          if (cmd.mode === 'vs') ap.vs = Math.round(s.speed.vsFpm / 100) * 100 || ap.vs;
          if (cmd.mode === 'master') { ap.flightDirector = true; if (!ap.hdgMode && !ap.navMode) ap.levelMode = true; }
        }
        if (cmd.mode === 'alt' && ap.altMode) { ap.alt = Math.round(s.position.altFt / 100) * 100; ap.vsMode = ap.flcMode = false; }
        break;
      }
      case 'ap.set':
        if (cmd.key === 'hdg') ap.hdg = normalizeDeg(Math.round(cmd.value));
        else ap[cmd.key] = Math.round(cmd.value);
        if (cmd.key === 'alt' && ap.master && !ap.vsMode && !ap.flcMode) {
          ap.vsMode = true;
          ap.altMode = true;
          ap.vs = ap.alt > s.position.altFt ? 700 : -700;
        }
        break;
      case 'radio.set':
        if (!validRadioMhz(cmd.radio, cmd.mhz)) throw new CommandError('Frequency out of range.');
        s.radios[cmd.radio][cmd.slot] = cmd.mhz;
        break;
      case 'radio.swap': {
        const r = s.radios[cmd.radio];
        [r.active, r.standby] = [r.standby, r.active];
        break;
      }
      case 'obs.set':
        s.radios[cmd.nav === 1 ? 'nav1' : 'nav2'].obs = normalizeDeg(Math.round(cmd.deg));
        break;
      case 'adf.set':
        s.radios.adfKhz = cmd.khz;
        break;
      case 'xpdr.set':
        if (!isValidSquawk(cmd.code)) throw new CommandError('Invalid squawk.');
        s.radios.xpdrCode = cmd.code;
        break;
      case 'xpdr.ident':
        break;
      case 'baro.set':
        s.environment.baroInHg = Math.round(cmd.inHg * 100) / 100;
        break;
      case 'baro.std':
        s.environment.baroInHg = 29.92;
        break;
      case 'light.set':
        s.lights[cmd.light as LightName] = cmd.on;
        break;
      case 'gear.set':
        if (!s.systems.gearRetractable) throw new CommandError('This aircraft has fixed landing gear.');
        break;
      case 'flaps.step':
        s.systems.flapsIndex = Math.max(0, Math.min(s.systems.flapsPositions, s.systems.flapsIndex + cmd.dir));
        s.systems.flapsPct = Math.round((s.systems.flapsIndex / s.systems.flapsPositions) * 100);
        break;
      case 'parkingBrake.toggle':
        s.systems.parkingBrake = !s.systems.parkingBrake;
        break;
      case 'battery.toggle':
        s.systems.battery = !s.systems.battery;
        break;
      case 'avionics.toggle':
        s.systems.avionics = !s.systems.avionics;
        break;
      case 'pitotHeat.toggle':
        s.systems.pitotHeat = !s.systems.pitotHeat;
        break;
      case 'door.toggle':
        s.systems.doorPct = s.systems.doorPct > 0 ? 0 : 100;
        break;
      case 'pushback.toggle':
        if (!s.position.onGround) throw new CommandError('Pushback is only possible on the ground.');
        break;
      case 'spoilers.arm':
      case 'spoilers.toggle':
        throw new CommandError('This aircraft has no spoilers.');
      case 'engines.autostart':
        s.engines.list.forEach((e) => { e.running = true; e.rpm = 2350; e.fuelFlowGph = 8.4; });
        break;
      case 'engines.shutdown':
        s.engines.list.forEach((e) => { e.running = false; e.rpm = 0; e.fuelFlowGph = 0; });
        break;
      case 'sim.pause':
        s.sim.paused = cmd.paused;
        break;
      case 'sim.rate': {
        const rates = [0.25, 0.5, 1, 2, 4, 8, 16];
        const idx = rates.indexOf(s.sim.rate) + simRateSteps(s.sim.rate, cmd.rate);
        s.sim.rate = rates[Math.max(0, Math.min(rates.length - 1, idx))];
        break;
      }
      case 'sim.slew':
        s.sim.slew = cmd.on;
        break;
      case 'sim.time': {
        const offset = s.sim.localSeconds - s.sim.zuluSeconds;
        s.sim.zuluSeconds = cmd.zuluHour * 3600 + cmd.zuluMinute * 60;
        s.sim.localSeconds = (s.sim.zuluSeconds + offset + 86400) % 86400;
        break;
      }
      case 'fuel.set':
        s.fuel.totalGal = (s.fuel.capacityGal * Math.max(0, Math.min(100, cmd.pct))) / 100;
        s.fuel.totalLbs = s.fuel.totalGal * s.fuel.lbsPerGal;
        break;
      case 'teleport':
        Object.assign(s.position, { lat: cmd.lat, lon: cmd.lon, altFt: cmd.altFt, onGround: cmd.onGround });
        s.attitude.hdgTrue = normalizeDeg(cmd.headingTrue);
        s.attitude.hdgMag = normalizeDeg(cmd.headingTrue - MAG_VAR);
        s.speed.ias = cmd.onGround ? 0 : cmd.kts;
        s.speed.vsFpm = 0;
        s.attitude.bank = 0;
        if (!cmd.onGround) Object.assign(ap, { alt: Math.round(cmd.altFt / 100) * 100, altMode: true, vsMode: false, flcMode: false, hdg: Math.round(s.attitude.hdgMag) });
        break;
      default:
        break;
    }
  }

  async loadFlightPlan(plan: FlightPlan): Promise<void> {
    this.route = (plan.expanded ?? plan.waypoints).map((w) => ({ ident: w.ident, lat: w.lat, lon: w.lon }));
    const s = this.s;
    // Start guidance at the first waypoint ahead of the aircraft rather than the departure airport.
    let best = 1;
    let bestDist = Infinity;
    this.route.forEach((w, i) => {
      if (i === 0) return;
      const d = distanceNm(s.position.lat, s.position.lon, w.lat, w.lon);
      if (d < bestDist) { bestDist = d; best = i; }
    });
    Object.assign(s.gps, { hasPlan: true, isDirectTo: false, wpIndex: Math.min(best, this.route.length - 1), wpCount: this.route.length });
    this.updateGps();
  }

  async airportFromSim() {
    return null;
  }

  async findFix() {
    return null;
  }

  async procedureLegs() {
    return null;
  }

  async airportGround() {
    return null;
  }
}
