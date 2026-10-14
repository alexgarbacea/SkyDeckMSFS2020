import { describe, expect, it } from 'vitest';
import { AtcEngine, aircraftType } from '../src/server/atc/engine';
import { airportStations, fmtAlt, fmtMhz } from '../src/server/atc/stations';
import { GroundService } from '../src/server/ground/service';
import { distanceNm, destinationPoint } from '../src/shared/geo';
import type { AirportDetails, FlightPlan, Telemetry } from '../src/shared/types';
import type { SimBridge } from '../src/server/bridge/types';
import { airport } from './ground.test';

function telemetry(lat: number, lon: number, patch: Partial<{ onGround: boolean; alt: number; gs: number; hdg: number; vs: number }> = {}): Telemetry {
  const onGround = patch.onGround ?? true;
  const alt = patch.alt ?? 100;
  return {
    time: Date.now(),
    aircraft: { title: 'Test', atcId: 'N123AB', atcModel: 'TT:ATCCOM.AC_MODEL_C172.0.text' },
    position: { lat, lon, altFt: alt, indicatedAltFt: alt, aglFt: onGround ? 0 : alt - 100, onGround },
    speed: { ias: patch.gs ?? 0, tas: patch.gs ?? 0, gs: patch.gs ?? 0, mach: 0, vsFpm: patch.vs ?? 0 },
    attitude: { hdgMag: patch.hdg ?? 0, hdgTrue: patch.hdg ?? 0, trackTrue: patch.hdg ?? 0, pitch: 0, bank: 0, magVar: 0 },
    environment: { windDir: 270, windKt: 10, oatC: 15, baroInHg: 29.92, seaLevelPressureMb: 1013 },
    autopilot: {
      available: true, master: false, flightDirector: false, yawDamper: false, autothrottle: false, hdgMode: false, navMode: false,
      aprMode: false, bcMode: false, altMode: false, vsMode: false, flcMode: false, spdMode: false, levelMode: false,
      glideslopeActive: false, hdg: 0, alt: 0, vs: 0, spd: 0, gpsDrivesNav: true,
    },
    radios: {
      com1: { active: 122.8, standby: 121.5 }, com2: { active: 122.8, standby: 121.5 },
      nav1: { active: 110, standby: 110, obs: 0, dmeNm: null, hasSignal: false },
      nav2: { active: 110, standby: 110, obs: 0, dmeNm: null, hasSignal: false },
      adfKhz: 350, adfStandbyKhz: 350, xpdrCode: '7000', xpdrState: 4,
    },
    lights: { nav: true, beacon: true, strobe: true, landing: true, taxi: true, logo: false, wing: false, recognition: false, panel: false, cabin: false },
    systems: {
      gearRetractable: false, gearDown: true, gearPct: 100, flapsIndex: 0, flapsPositions: 3, flapsPct: 0, spoilersAvailable: false,
      spoilersPct: 0, spoilersArmed: false, parkingBrake: false, battery: true, avionics: true, pitotHeat: false, pushbackState: 3, doorPct: 0,
    },
    engines: { count: 1, type: 0, list: [{ running: true, rpm: 2300, n1: 0, fuelFlowGph: 8, throttlePct: 70 }] },
    fuel: { totalGal: 40, capacityGal: 53, totalLbs: 240, lbsPerGal: 6 },
    weight: { totalLbs: 2300, maxGrossLbs: 2550, emptyLbs: 1680 },
    sim: { paused: false, rate: 1, slew: false, zuluSeconds: 36000, localSeconds: 39600, zuluDayOfYear: 1, zuluYear: 2026 },
    gps: { hasPlan: false, isDirectTo: false, wpIndex: 0, wpCount: 0, nextId: '', nextLat: 0, nextLon: 0, prevId: '', prevLat: 0, prevLon: 0, distNm: 0, eteSec: 0, destEteSec: 0, bearingMag: 0, xtkNm: 0 },
  };
}

const withFreqs = (a: AirportDetails, f: Array<[string, number]>): AirportDetails => ({ ...a, frequencies: f.map(([type, mhz]) => ({ type, name: '', mhz })) });

// Departure and destination about 85 nm apart.
const DEP = withFreqs(airport('AAAA', 35, 25), [['ATIS', 127.2], ['DEL', 121.8], ['GND', 121.7], ['TWR', 118.7], ['DEP', 119.1]]);
const DEST = withFreqs(airport('BBBB', 36, 26), [['GND', 121.9], ['TWR', 118.3], ['APP', 120.4]]);

function setup(rules: 'IFR' | 'VFR' = 'IFR', planFrom = 'AAAA', procedures: FlightPlan['procedures'] = {}) {
  const demo = { kind: 'demo', airportGround: async () => null } as unknown as SimBridge;
  const airports: Record<string, AirportDetails> = { AAAA: DEP, BBBB: DEST };
  const ground = new GroundService({ bridge: () => demo, airport: async (i) => airports[i] ?? null });
  const plan: FlightPlan = {
    title: '', rules, cruiseAltFt: 9000, procedures, source: 'test', updatedAt: 0, sentToSimAt: null,
    waypoints: [
      { id: '1', ident: planFrom, type: 'airport', lat: 35, lon: 25 },
      { id: '2', ident: 'BBBB', type: 'airport', lat: 36, lon: 26 },
    ],
  };
  const atc = new AtcEngine({
    airport: async (i) => airports[i] ?? null,
    ground,
    plan: () => plan,
    nearest: (lat, lon) =>
      Object.values(airports)
        .map((a) => ({ ...a, distNm: distanceNm(lat, lon, a.lat, a.lon) }))
        .sort((a, b) => a.distNm - b.distNm),
    callsign: () => '',
    replyDelayMs: 0,
  });
  let t: Telemetry;
  const fly = async (next: Telemetry) => {
    t = next;
    t.radios.xpdrCode = atc.state().assigned.squawk ?? t.radios.xpdrCode;
    for (let pass = 0; pass < 2; pass++) {
      // Keep COM 1 on whoever we are talking to, like a diligent pilot.
      const st = atc.state().station;
      if (st) t.radios.com1.active = st.mhz;
      ground.update(t);
      atc.update(t);
      await atc.idle();
    }
    const st = atc.state().station;
    if (st) t.radios.com1.active = st.mhz;
    atc.update(t);
    return atc.state();
  };
  const say = async (id: string) => {
    await atc.request(id);
    await atc.idle();
    return atc.state();
  };
  const lastAtc = () => [...atc.state().transcript].reverse().find((m) => m.from === 'atc')?.text ?? '';
  return { atc, ground, fly, say, lastAtc, get t() { return t; } };
}

describe('ATC phrasing', () => {
  it('formats altitudes, frequencies and aircraft types', () => {
    expect(fmtAlt(9000, false)).toBe('FL090');
    expect(fmtAlt(5000, false)).toBe('5,000 ft');
    expect(fmtAlt(9000, true)).toBe('9,000 ft');
    expect(fmtMhz(118.7)).toBe('118.7');
    expect(fmtMhz(121.725)).toBe('121.725');
    expect(aircraftType('TT:ATCCOM.AC_MODEL_C172.0.text')).toBe('C172');
  });

  it('finds the controllers an airport publishes', () => {
    const s = airportStations(DEP);
    expect(s.delivery?.name).toBe('City AAAA Delivery');
    expect(s.ground?.mhz).toBe(121.7);
    expect(s.approach).toBeUndefined();
    expect(airportStations(withFreqs(DEP, [['APP/DEP', 124.5]])).departure?.mhz).toBe(124.5);
  });
});

describe('IFR flight from stand to stand', () => {
  it('walks through the whole controller chain', async () => {
    const s = setup();
    const g = (await s.ground.ground('AAAA'))!;
    const stand = g.stands[0];
    await s.atc.start(telemetry(stand.lat, stand.lon, { hdg: stand.headingTrue }));
    let st = await s.fly(telemetry(stand.lat, stand.lon, { hdg: stand.headingTrue }));
    expect(st.phase).toBe('preflight');
    expect(st.station?.name).toBe('City AAAA Delivery');
    expect(st.tuned).toBe(true);
    expect(st.requests[0]).toMatchObject({ id: 'clearance', primary: true });
    expect(st.requests[0].text).toMatch(/^City AAAA Delivery, N123AB, information [A-Z], request IFR clearance to BBBB\.$/);

    // Clearance and readback, then over to Ground.
    st = await s.say('clearance');
    expect(s.lastAtc()).toMatch(/^N123AB, cleared to BBBB via flight planned route, departure runway 27, climb 5,000 ft, expect FL090 ten minutes after departure, departure frequency 119\.1, squawk [1-6][0-7]{3}\.$/);
    expect(st.requests[0].id).toBe('readback');
    st = await s.say('readback');
    expect(s.lastAtc()).toBe('N123AB, readback correct. Contact City AAAA Ground 121.7 for pushback and taxi.');
    expect(st.phase).toBe('cleared');
    expect(st.station?.name).toBe('City AAAA Ground');
    expect(st.tuned).toBe(false);
    await expect(s.atc.request('taxi')).rejects.toThrow(/Tune City AAAA Ground/);

    // Taxi to the holding point of runway 27 along the generated taxiways.
    st = await s.fly(telemetry(stand.lat, stand.lon));
    st = await s.say('taxi');
    expect(s.lastAtc()).toBe('N123AB, taxi to holding point runway 27 via P, A, A3, hold short of runway 27.');
    expect(st.phase).toBe('taxi-out');
    expect(s.ground.state.route?.to).toEqual({ kind: 'runway', runway: '27' });
    st = await s.say('readback');
    const route = s.ground.state.route!;
    const [hlon, hlat] = route.points[route.points.length - 1];
    st = await s.fly(telemetry(hlat, hlon, { gs: 2 }));
    expect(s.lastAtc()).toBe('N123AB, hold short of runway 27, contact City AAAA Tower 118.7.');
    expect(st.phase).toBe('holding');

    st = await s.fly(telemetry(hlat, hlon));
    st = await s.say('ready');
    expect(s.lastAtc()).toBe('N123AB, wind 270 degrees 10 knots, runway 27, cleared for takeoff.');
    expect(st.phase).toBe('takeoff');

    // Airborne: Tower hands over to Departure.
    st = await s.fly(telemetry(35, 24.98, { onGround: false, alt: 900, gs: 90, hdg: 270, vs: 700 }));
    expect(s.lastAtc()).toBe('N123AB, contact City AAAA Departure 119.1, good day.');
    expect(st.phase).toBe('departure');
    st = await s.say('checkin');
    expect(st.transcript.at(-2)?.text).toBe('City AAAA Departure, N123AB, passing 900 ft, climbing 5,000 ft.');
    expect(s.lastAtc()).toBe('N123AB, City AAAA Departure, radar contact. Climb FL090.');
    await s.say('readback');

    // Far from the departure airport: area control.
    st = await s.fly(telemetry(35.3, 25.4, { onGround: false, alt: 9000, gs: 110, hdg: 45 }));
    expect(st.phase).toBe('enroute');
    expect(st.station?.role).toBe('center');
    st = await s.say('checkin');
    expect(s.lastAtc()).toMatch(/identified\.$/);

    // 35 nm out: Approach.
    const p35 = destinationPoint(36, 26, 225, 35);
    st = await s.fly(telemetry(p35.lat, p35.lon, { onGround: false, alt: 9000, gs: 110, hdg: 45 }));
    expect(st.phase).toBe('approach');
    expect(st.station?.name).toBe('City BBBB Approach');
    st = await s.say('checkin');
    expect(s.lastAtc()).toBe('N123AB, City BBBB Approach, radar contact. Expect visual approach runway 27, descend 3,000 ft, QNH 1013.');
    await s.say('readback');

    // Inside 18 nm: approach clearance. Inside 10 nm: Tower.
    const thr27 = DEST.runways[0].ends[1];
    const p15 = destinationPoint(thr27.lat!, thr27.lon!, 90, 15);
    st = await s.fly(telemetry(p15.lat, p15.lon, { onGround: false, alt: 3000, gs: 100, hdg: 270 }));
    expect(s.lastAtc()).toBe('N123AB, cleared visual approach runway 27.');
    await s.say('readback');
    const p8 = destinationPoint(thr27.lat!, thr27.lon!, 90, 8);
    st = await s.fly(telemetry(p8.lat, p8.lon, { onGround: false, alt: 2500, gs: 90, hdg: 270 }));
    expect(st.phase).toBe('final');
    expect(st.station?.name).toBe('City BBBB Tower');
    st = await s.say('landing');
    expect(s.lastAtc()).toBe('N123AB, wind 270 degrees 10 knots, runway 27, cleared to land.');
    await s.say('readback');

    // Touchdown and roll-out, then Ground.
    st = await s.fly(telemetry(36, 26.005, { gs: 30, hdg: 270 }));
    expect(st.phase).toBe('landed');
    expect(s.lastAtc()).toBe('N123AB, vacate runway when able, contact City BBBB Ground 121.9 when vacated.');
    const destGround = (await s.ground.ground('BBBB'))!;
    const exit = destGround.nodes.find((n) => n.hold)!;
    st = await s.fly(telemetry(exit.lat, exit.lon, { gs: 5 }));
    st = await s.say('taxi-in');
    expect(s.lastAtc()).toMatch(/^N123AB, taxi to parking \d via [A-Z0-9, ]+\.$/);
    expect(st.phase).toBe('taxi-in');
    const dest = s.ground.state.route!.to;
    expect(dest.kind).toBe('stand');
    if (dest.kind !== 'stand') return;

    // Roll onto the stand.
    st = await s.fly(telemetry(dest.stand.lat, dest.stand.lon, { hdg: dest.stand.headingTrue }));
    expect(st.phase).toBe('parked');
    expect(st.transcript.at(-1)?.text).toMatch(/^Parked at Parking \d\. Welcome to City BBBB! Flight complete\.$/);
    expect(st.transcript.filter((m) => m.level === 'warning')).toEqual([]);
  });
});

describe('flight plan procedures', () => {
  it('uses the SID of a plan that starts here, and its runway unless the wind is against it', async () => {
    const s = setup('IFR', 'AAAA', { sid: 'ALPHA1A', departureRunway: '09' });
    await s.atc.start(telemetry(35.002, 25));
    await s.fly(telemetry(35.002, 25));
    await s.say('clearance');
    // 10 kt of tailwind on 09, so 27 it is.
    expect(s.lastAtc()).toMatch(/via the ALPHA1A departure, then flight planned route, departure runway 27,/);
  });

  it("ignores them when the aircraft is at another airport than the plan's departure", async () => {
    const s = setup('IFR', 'ZZZZ', { sid: 'ALPHA1A', departureRunway: '09' });
    await s.atc.start(telemetry(35.002, 25));
    await s.fly(telemetry(35.002, 25));
    expect(s.atc.state().departure).toBe('AAAA');
    await s.say('clearance');
    expect(s.lastAtc()).toMatch(/via flight planned route, departure runway 27,/);
  });
});

describe('compliance', () => {
  it('warns about taxiing without clearance and taking off without clearance', async () => {
    const s = setup();
    await s.atc.start(telemetry(35.002, 25));
    await s.fly(telemetry(35.002, 25.0001, { gs: 12 }));
    await s.fly(telemetry(35, 24.99, { onGround: false, alt: 600, gs: 80 }));
    const warnings = s.atc.state().transcript.filter((m) => m.level === 'warning').map((m) => m.text);
    expect(warnings).toEqual(['You are taxiing without a taxi clearance. Ask Ground for taxi first.', 'You took off without a takeoff clearance.']);
  });

  it('flags an altitude bust', async () => {
    const s = setup();
    await s.atc.start(telemetry(35.3, 25.4, { onGround: false, alt: 9000 }));
    await s.fly(telemetry(35.3, 25.4, { onGround: false, alt: 10000 }));
    expect(s.atc.state().transcript.at(-1)?.text).toBe('Check your altitude: you are cleared to FL090.');
  });
});

describe('VFR', () => {
  it('gets a VFR squawk with taxi and calls the tower inbound', async () => {
    const s = setup('VFR');
    const g = (await s.ground.ground('AAAA'))!;
    const stand = g.stands[1];
    await s.atc.start(telemetry(stand.lat, stand.lon));
    let st = await s.fly(telemetry(stand.lat, stand.lon));
    expect(st.station?.name).toBe('City AAAA Ground');
    expect(st.requests[0].text).toMatch(/^City AAAA Ground, N123AB, C172 VFR to BBBB, information [A-Z], request taxi\.$/);
    st = await s.say('taxi');
    expect(s.lastAtc()).toBe('N123AB, taxi to holding point runway 27 via P, A, A3, hold short of runway 27, QNH 1013, squawk 7000.');

    const p30 = destinationPoint(36, 26, 225, 30);
    st = await s.fly(telemetry(p30.lat, p30.lon, { onGround: false, alt: 4500, gs: 110 }));
    expect(st.phase).toBe('vfr-enroute');
    expect(st.station?.name).toBe('City BBBB Tower');
    st = await s.fly(telemetry(p30.lat, p30.lon, { onGround: false, alt: 4500, gs: 110 }));
    st = await s.say('inbound');
    expect(st.transcript.at(-2)?.text).toMatch(/^City BBBB Tower, N123AB, 30 miles south-west of the field, 4,500 ft, inbound for landing, information [A-Z]\.$/);
    expect(s.lastAtc()).toBe('N123AB, City BBBB Tower, runway 27, QNH 1013, join final runway 27, report final.');
    expect(st.phase).toBe('final');
  });
});
