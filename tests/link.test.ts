import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toLinkPlan, normalizeRunway } from '../src/server/link/payload';
import { injectScript, installLink, linkStatus, uninstallLink } from '../src/server/link/install';
import type { FlightPlan } from '../src/shared/types';

// The plan the user sent in their test: World Map LTBA -> LTFJ, runway 23, ILS 06L X.
const userPlan: FlightPlan = {
  title: 'LTBA to LTFJ',
  rules: 'IFR',
  cruiseAltFt: 2200,
  waypoints: [
    { id: 'a', ident: 'LTBA', type: 'airport', lat: 40.976, lon: 28.814, altFt: 91 },
    { id: 'b', ident: 'BKZ', type: 'vor', lat: 41.1269, lon: 29.1428 },
    { id: 'u', ident: 'USR01', type: 'user', lat: 41.0, lon: 29.2 },
    { id: 'p', ident: 'SMORE', type: 'fix', lat: 40.82, lon: 29.1, region: 'LT', procedure: { kind: 'approach', name: 'ILS 06L X' } },
    { id: 'c', ident: 'LTFJ', type: 'airport', lat: 40.8986, lon: 29.3092, altFt: 312 },
  ],
  procedures: { departureRunway: '23', sid: 'BARP1B', approach: 'ILS 06L X', arrivalRunway: '06L', star: 'NAMA1G' },
  source: 'MSFS World Map',
  updatedAt: 1,
  sentToSimAt: null,
};

describe('toLinkPlan', () => {
  it('describes origin, procedures and enroute waypoints for the avionics', () => {
    const p = toLinkPlan(userPlan);
    expect(p.origin).toEqual({ ident: 'LTBA', runway: '23' });
    expect(p.departure).toEqual({ name: 'BARP1B', runway: '23', transition: undefined });
    expect(p.destination).toEqual({ ident: 'LTFJ', runway: '06L' });
    expect(p.arrival).toMatchObject({ name: 'NAMA1G', runway: '06L' });
    expect(p.approach).toEqual({ name: 'ILS 06L X', type: 4, runwayNumber: 6, runwayDesignator: 1, suffix: 'X' });
    // Procedure fixes are left to the avionics; only real enroute waypoints are sent.
    expect(p.enroute.map((w) => w.ident)).toEqual(['BKZ', 'USR01']);
  });

  it('pads runways the way the avionics name them', () => {
    expect(normalizeRunway('6L')).toBe('06L');
    expect(normalizeRunway('23')).toBe('23');
    expect(normalizeRunway(undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------- Installer

const MFD = 'html_ui/Pages/VCockpit/Instruments/NavSystems/WTG1000/MFD/WTG1000_MFD.html';
const ORIGINAL_MFD = `<link rel="stylesheet" href="MFD.css" />
<script type="text/html"
  import-script="/Pages/VCockpit/Instruments/NavSystems/WTG1000/Libraries/garminsdk.js"></script>
<script type="text/html" import-script="/Pages/VCockpit/Instruments/NavSystems/WTG1000/MFD/MFD.js"></script>`;

describe('SkyDeck Link installer', () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'skydeck-link-'));
    await mkdir(path.join(root, 'Community'));
    const mfdPath = path.join(root, 'Official', 'Steam', 'workingtitle-instruments-g1000', MFD);
    await mkdir(path.dirname(mfdPath), { recursive: true });
    await writeFile(mfdPath, ORIGINAL_MFD);
  });
  afterAll(() => rm(root, { recursive: true, force: true }));

  it('adds the script right after the MFD script', () => {
    const out = injectScript(ORIGINAL_MFD);
    expect(out.indexOf('skydeck-link.js')).toBeGreaterThan(out.indexOf('MFD/MFD.js'));
    expect(injectScript(out)).toBe(out);
  });

  it('installs, detects changes and uninstalls', async () => {
    expect((await linkStatus(root, 4500)).state).toBe('not-installed');
    await installLink(root, 4500);
    const pkg = path.join(root, 'Community', 'skydeck-link');
    const html = await readFile(path.join(pkg, MFD), 'utf8');
    expect(html).toContain('/SkyDeckLink/skydeck-link.js');
    const js = await readFile(path.join(pkg, 'html_ui/SkyDeckLink/skydeck-link.js'), 'utf8');
    expect(js).not.toContain('__SKYDECK_PORT__');
    const layout = JSON.parse(await readFile(path.join(pkg, 'layout.json'), 'utf8'));
    expect(layout.content.map((c: { path: string }) => c.path).sort()).toEqual([MFD, 'html_ui/SkyDeckLink/skydeck-link.js'].sort());
    expect(layout.content[0].size).toBeGreaterThan(0);
    expect((await linkStatus(root, 4500)).state).toBe('installed');

    // An NXi update changes the original page: the link must be regenerated.
    await writeFile(path.join(root, 'Official', 'Steam', 'workingtitle-instruments-g1000', MFD), ORIGINAL_MFD + '\n<!-- updated -->');
    expect((await linkStatus(root, 4500)).state).toBe('outdated');

    await uninstallLink(root);
    await expect(access(pkg)).rejects.toThrow();
  });

  it('never deletes a folder it did not create', async () => {
    const foreign = path.join(root, 'Community', 'skydeck-link');
    await mkdir(foreign, { recursive: true });
    await expect(uninstallLink(root)).rejects.toThrow(/not created by SkyDeck/);
    await expect(installLink(root, 4500)).rejects.toThrow(/not created by SkyDeck/);
    await rm(foreign, { recursive: true });
  });

  it('reports when the NXi is missing', async () => {
    const empty = await mkdtemp(path.join(os.tmpdir(), 'skydeck-empty-'));
    await mkdir(path.join(empty, 'Community'));
    expect((await linkStatus(empty, 4500)).state).toBe('unavailable');
    await rm(empty, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------- The in-sim script against a mock NXi

const DESIGNATORS = ['', 'L', 'R', 'C', 'W', 'A', 'B'];

function mockNxi() {
  const calls: string[] = [];
  const segments = [
    { segmentType: 0, legs: [] as Array<{ leg: { fixIcao: string }; name: string; calculated?: { endLat: number; endLon: number } }> },
    { segmentType: 1, legs: [] as Array<{ leg: { fixIcao: string }; name: string }> },
    { segmentType: 2, legs: [] as Array<{ leg: { fixIcao: string }; name: string }> },
  ];
  const plan = {
    segmentCount: 3,
    length: 0,
    activeLateralLeg: 0,
    originAirport: undefined as string | undefined,
    destinationAirport: undefined as string | undefined,
    procedureDetails: { departureIndex: -1, arrivalIndex: -1, approachIndex: -1 },
    getSegment: (i: number) => segments[i],
    calculate: () => Promise.resolve(),
    setLateralLeg: (i: number) => calls.push(`setLateralLeg ${i}`),
  };
  const airports: Record<string, unknown> = {
    'A      LTBA ': {
      icao: 'A      LTBA ', lat: 40.97, lon: 28.81,
      departures: [{ name: 'BARP1A', runwayTransitions: [{ runwayNumber: 5, runwayDesignation: 0 }], enRouteTransitions: [] },
        { name: 'BARP1B', runwayTransitions: [{ runwayNumber: 23, runwayDesignation: 0 }], enRouteTransitions: [] }],
      arrivals: [], approaches: [],
    },
    'A      LTFJ ': {
      icao: 'A      LTFJ ', lat: 40.9, lon: 29.3, departures: [],
      arrivals: [{ name: 'NAMA1G', runwayTransitions: [{ runwayNumber: 6, runwayDesignation: 1 }], enRouteTransitions: [] }],
      approaches: [
        { approachType: 4, runwayNumber: 24, runwayDesignator: 2, approachSuffix: 'Z', transitions: [] },
        { approachType: 4, runwayNumber: 6, runwayDesignator: 1, approachSuffix: 'X', transitions: [] },
      ],
    },
    'VLT    BKZ  ': { icao: 'VLT    BKZ  ', lat: 41.1269, lon: 29.1428 },
    'VXX    BKZ  ': { icao: 'VXX    BKZ  ', lat: 10, lon: 10 },
  };
  const fms = {
    facLoader: {
      getFacility: (_type: string, icao: string) => (airports[icao] ? Promise.resolve(airports[icao]) : Promise.reject(new Error('nope'))),
      searchByIdent: (_t: number, ident: string) => Promise.resolve(Object.keys(airports).filter((k) => k.endsWith(ident.padEnd(5)))),
    },
    emptyPrimaryFlightPlan: () => (calls.push('empty'), Promise.resolve()),
    getPrimaryFlightPlan: () => plan,
    insertDeparture: (fac: { icao: string }, i: number, r: number, t: number, rw: { designation: string }) => calls.push(`departure ${fac.icao.trim()} ${i} ${r} ${t} ${rw?.designation}`),
    setOrigin: (fac: { icao: string }) => calls.push(`origin ${fac.icao.trim()}`),
    insertArrival: (fac: { icao: string }, i: number, r: number) => calls.push(`arrival ${fac.icao.trim()} ${i} ${r}`),
    insertApproach: (fac: { icao: string }, i: number, t: number) => (calls.push(`approach ${fac.icao.trim()} ${i} ${t}`), Promise.resolve(true)),
    setDestination: (fac: { icao: string }) => calls.push(`destination ${fac.icao.trim()}`),
    insertWaypoint: (seg: number, fac: { icao: string }) => calls.push(`waypoint ${seg} ${fac.icao.trim()}`),
    addUserFacility: (f: { icao: string }) => calls.push(`user ${f.icao.trim()}`),
    activateNearestLeg: () => calls.push('activateNearestLeg'),
    createDirectToExisting: (s: number, l: number) => calls.push(`dto existing ${s} ${l}`),
    createDirectToRandom: (f: { icao: string }) => calls.push(`dto random ${f.icao.trim()}`),
  };
  const sdk = {
    ICAO: { getFacilityType: (icao: string) => icao[0], getIdent: (icao: string) => icao.substr(7).trim() },
    RunwayUtils: {
      getRunwayNameString: (n: number, d: number) => String(n).padStart(2, '0') + DESIGNATORS[d],
      matchOneWayRunwayFromDesignation: (_f: unknown, designation: string) => ({ designation }),
    },
    UserFacilityUtils: { createFromLatLon: (icao: string, lat: number, lon: number) => ({ icao, lat, lon }) },
    FlightPlanSegmentType: { Departure: 0, Enroute: 1, Destination: 2 },
  };
  return { calls, fms, sdk, segments };
}

describe('SkyDeck Link script (inside the NXi)', () => {
  it('connects, loads a full plan the way the NXi expects, and flies direct-to', async () => {
    const nxi = mockNxi();
    const sent: Array<Record<string, unknown>> = [];
    let socket: { onopen?: () => void; onmessage?: (e: { data: string }) => void; readyState: number; send: (s: string) => void } | null = null;
    class FakeWebSocket {
      readyState = 1;
      onopen?: () => void;
      onmessage?: (e: { data: string }) => void;
      onclose?: () => void;
      constructor(public url: string) {
        socket = this;
        setTimeout(() => this.onopen?.(), 5);
      }
      send(s: string) {
        sent.push(JSON.parse(s));
      }
    }
    const timers: NodeJS.Timeout[] = [];
    const context = vm.createContext({
      window: { msfssdk: nxi.sdk, garminsdk: { FmsUtils: { getApproachNameAsString: () => 'ILS 06L X' } } },
      document: { querySelector: (sel: string) => (sel === 'wtg1000-mfd' ? { fms: nxi.fms } : null) },
      WebSocket: FakeWebSocket,
      Simplane: { getIsGrounded: () => false },
      console: { log: () => undefined },
      setTimeout: (fn: () => void, ms: number) => {
        const t = setTimeout(fn, Math.min(ms, 20));
        timers.push(t);
        return t;
      },
      setInterval: (fn: () => void, ms: number) => {
        const t = setInterval(fn, Math.min(ms, 20));
        timers.push(t);
        return t;
      },
      clearInterval,
      Promise,
      JSON,
      Math,
      Date,
      String,
      Number,
      Array,
    });
    const source = readFileSync(path.join(__dirname, '..', 'addon', 'skydeck-link', 'skydeck-link.js'), 'utf8');
    vm.runInContext(source, context);
    const waitFor = async (pred: () => boolean) => {
      for (let i = 0; i < 200 && !pred(); i++) await new Promise((r) => setTimeout(r, 10));
      expect(pred()).toBe(true);
    };

    await waitFor(() => sent.some((m) => m.type === 'hello'));
    expect(sent.find((m) => m.type === 'hello')).toMatchObject({ avionics: 'G1000 NXi' });

    socket!.onmessage!({ data: JSON.stringify({ type: 'loadPlan', id: 7, plan: toLinkPlan(userPlan) }) });
    await waitFor(() => sent.some((m) => m.type === 'result' && m.id === 7));
    expect(sent.find((m) => m.id === 7)).toMatchObject({ ok: true, result: { warnings: [] } });
    expect(nxi.calls).toEqual([
      'empty',
      'departure A      LTBA 1 0 -1 23',
      'arrival A      LTFJ 0 0',
      'approach A      LTFJ 1 -1',
      'waypoint 1 VLT    BKZ', // nearest BKZ wins over the one in region XX
      'user U      USR01',
      'waypoint 1 U      USR01',
      'activateNearestLeg',
    ]);

    // Direct-to a fix that is already in the plan uses the existing leg.
    nxi.segments[1].legs.push({ leg: { fixIcao: 'VLT    BKZ  ' }, name: 'BKZ' });
    socket!.onmessage!({ data: JSON.stringify({ type: 'directTo', id: 8, target: { ident: 'BKZ', type: 'vor', lat: 41.1, lon: 29.1 } }) });
    await waitFor(() => sent.some((m) => m.id === 8));
    expect(nxi.calls).toContain('dto existing 1 0');

    timers.forEach((t) => clearTimeout(t));
  });
});
