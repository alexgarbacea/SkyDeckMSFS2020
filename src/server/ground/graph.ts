// An airport's taxiway network as a graph: building it from the simulator's facility data, planning taxi routes
// to a runway holding point or a stand, and describing them the way ATC would ("via A, B, cross runway 09").
import type { AirportDetails, GroundLayout, Stand, StandKind, TaxiRoute, TaxiStep } from '../../shared/types.js';
import { angleDiff } from '../../shared/geo.js';
import { courseOf, frameAt, fromLocal, metresBetween, runwayEnd, runwayFrame, runwayGeoms, toLocal, type RunwayGeom } from './geometry.js';

/** Taxi data as the simulator reports it: positions are metres east/north (x/z) of the airport reference point. */
export interface RawGround {
  refLat: number;
  refLon: number;
  points: Array<{ type: number; x: number; z: number }>;
  parkings: Array<{ type: number; name: number; number: number; heading: number; radius: number; x: number; z: number }>;
  paths: Array<{ type: number; start: number; end: number; nameIndex: number }>;
  names: string[];
}

export interface GroundNode {
  lat: number;
  lon: number;
  hold: boolean;
  /** Set when the node is a stand. */
  stand?: number;
}

export interface GroundEdge {
  a: number;
  b: number;
  kind: 'taxi' | 'runway' | 'stand';
  name: string;
  lengthM: number;
}

export interface AirportGround {
  ident: string;
  source: 'sim' | 'generated';
  nodes: GroundNode[];
  edges: GroundEdge[];
  /** Edge indices touching each node. */
  adj: number[][];
  stands: Stand[];
  standNode: number[];
  runways: RunwayGeom[];
  /** Runway index each node sits on, or -1. */
  nodeRunway: number[];
}

// MSFS TAXI_PATH types: 1 taxi, 2 runway, 3 parking, 4 path. Closed paths, vehicle roads and painted lines are skipped.
const PATH_TAXI = 1;
const PATH_RUNWAY = 2;
const PATH_PARKING = 3;
const PATH_PATH = 4;
// MSFS TAXI_POINT types above 1 are the hold-short variants (normal, ILS, not drawn).
const POINT_NORMAL = 1;
// TAXI_PARKING types.
const PARKING_KIND: Record<number, StandKind | null> = {
  1: 'ramp', 2: 'ramp', 3: 'ramp', 4: 'ramp', 5: 'cargo', 6: 'military', 7: 'military',
  8: 'gate', 9: 'gate', 10: 'gate', 11: 'other', 12: 'other', 13: null, 14: 'ramp', 15: 'gate',
};
const PARKING_NAMES = ['Parking', 'Parking', 'N Parking', 'NE Parking', 'E Parking', 'SE Parking', 'S Parking', 'SW Parking', 'W Parking', 'NW Parking', 'Gate', 'Dock'];

export function standName(nameCode: number, number: number): string {
  if (nameCode >= 12 && nameCode <= 37) return `Gate ${String.fromCharCode(65 + nameCode - 12)}${number}`;
  return `${PARKING_NAMES[nameCode] ?? 'Parking'} ${number}`;
}

const standSize = (radiusM: number): Stand['size'] => (radiusM <= 12 ? 'small' : radiusM <= 24 ? 'medium' : 'large');

/** Ways the simulator's x/z offsets could map onto east/north. The first one is what the SDK documents. */
const ORIENTATIONS: Array<[number, number, number, number]> = [
  [1, 0, 0, 1], [1, 0, 0, -1], [-1, 0, 0, 1], [-1, 0, 0, -1],
  [0, 1, 1, 0], [0, 1, -1, 0], [0, -1, 1, 0], [0, -1, -1, 0],
];

/**
 * Picks the x/z orientation under which the runway taxi paths line up with the runways. This guards against
 * a different axis convention in the facility data than documented, which would otherwise scramble the map.
 */
export function calibrate(raw: RawGround, runways: RunwayGeom[]): { orientation: number; fitM: number } {
  const samples: Array<{ x: number; z: number }> = [];
  for (const p of raw.paths) {
    if (p.type !== PATH_RUNWAY) continue;
    for (const i of [p.start, p.end]) if (raw.points[i]) samples.push(raw.points[i]);
    if (samples.length > 300) break;
  }
  if (!samples.length || !runways.length) return { orientation: 0, fitM: NaN };
  const f = frameAt(raw.refLat, raw.refLon);
  const fit = (o: number) => {
    const [a, b, c, d] = ORIENTATIONS[o];
    let sum = 0;
    for (const s of samples) {
      const { lat, lon } = fromLocal(f, a * s.x + b * s.z, c * s.x + d * s.z);
      let best = 500;
      for (const rw of runways) {
        const { along, lateral } = runwayFrame(rw, lat, lon);
        if (along > -200 && along < rw.lengthM + 200) best = Math.min(best, lateral);
      }
      sum += best;
    }
    return sum / samples.length;
  };
  const scores = ORIENTATIONS.map((_, i) => fit(i));
  let best = 0;
  scores.forEach((s, i) => (s < scores[best] ? (best = i) : undefined));
  // Only leave the documented orientation when it clearly does not fit and another one clearly does.
  if (best !== 0 && !(scores[0] > 30 && scores[best] < scores[0] * 0.5)) best = 0;
  return { orientation: best, fitM: scores[best] };
}

export function buildGround(ident: string, raw: RawGround, airport: Pick<AirportDetails, 'runways'>, orientation = 0): AirportGround {
  const runways = runwayGeoms(airport);
  const f = frameAt(raw.refLat, raw.refLon);
  const [a, b, c, d] = ORIENTATIONS[orientation] ?? ORIENTATIONS[0];
  const place = (x: number, z: number) => fromLocal(f, a * x + b * z, c * x + d * z);

  const nodes: GroundNode[] = raw.points.map((p) => ({ ...place(p.x, p.z), hold: p.type > POINT_NORMAL }));
  const stands: Stand[] = [];
  const standNode: number[] = [];
  const parkingNode = new Map<number, number>();
  raw.parkings.forEach((p, i) => {
    const kind = PARKING_KIND[p.type] ?? 'other';
    if (PARKING_KIND[p.type] === null) return;
    const pos = place(p.x, p.z);
    const stand: Stand = {
      index: stands.length,
      name: standName(p.name, p.number),
      kind,
      size: standSize(p.radius),
      lat: pos.lat,
      lon: pos.lon,
      headingTrue: ((p.heading % 360) + 360) % 360,
      radiusM: p.radius,
    };
    parkingNode.set(i, nodes.length);
    standNode.push(nodes.length);
    nodes.push({ lat: pos.lat, lon: pos.lon, hold: false, stand: stand.index });
    stands.push(stand);
  });

  const edges: GroundEdge[] = [];
  const addEdge = (ia: number, ib: number, kind: GroundEdge['kind'], name: string) => {
    const na = nodes[ia];
    const nb = nodes[ib];
    if (!na || !nb || ia === ib) return;
    edges.push({ a: ia, b: ib, kind, name, lengthM: metresBetween(na.lat, na.lon, nb.lat, nb.lon) });
  };
  for (const p of raw.paths) {
    if (p.type === PATH_PARKING) {
      const sn = parkingNode.get(p.end);
      if (sn != null && p.start < raw.points.length) addEdge(p.start, sn, 'stand', '');
    } else if (p.type === PATH_TAXI || p.type === PATH_PATH || p.type === PATH_RUNWAY) {
      if (p.start >= raw.points.length || p.end >= raw.points.length) continue;
      addEdge(p.start, p.end, p.type === PATH_RUNWAY ? 'runway' : 'taxi', p.type === PATH_RUNWAY ? '' : (raw.names[p.nameIndex] ?? '').trim());
    }
  }
  return finish(ident, 'sim', nodes, edges, stands, standNode, runways);
}

function finish(ident: string, source: AirportGround['source'], nodes: GroundNode[], edges: GroundEdge[], stands: Stand[], standNode: number[], runways: RunwayGeom[]): AirportGround {
  const adj: number[][] = nodes.map(() => []);
  edges.forEach((e, i) => {
    adj[e.a].push(i);
    adj[e.b].push(i);
  });
  // Stands without a lead-in line: connect them to the nearest taxi point so they can still be reached.
  for (const n of standNode) {
    if (adj[n].length) continue;
    let best = -1;
    let bestD = 150;
    nodes.forEach((m, i) => {
      if (m.stand != null || !adj[i].length) return;
      const dist = metresBetween(nodes[n].lat, nodes[n].lon, m.lat, m.lon);
      if (dist < bestD) {
        bestD = dist;
        best = i;
      }
    });
    if (best >= 0) {
      edges.push({ a: best, b: n, kind: 'stand', name: '', lengthM: bestD });
      adj[best].push(edges.length - 1);
      adj[n].push(edges.length - 1);
    }
  }
  const nodeRunway = nodes.map((n) => {
    if (n.stand != null) return -1;
    return runways.findIndex((rw) => {
      const { along, lateral } = runwayFrame(rw, n.lat, n.lon);
      return along >= -5 && along <= rw.lengthM + 5 && lateral <= rw.halfWidthM + 3;
    });
  });
  return { ident, source, nodes, edges, adj, stands, standNode, runways, nodeRunway };
}

// ---------------------------------------------------------------- Stand-in layout for the demo aircraft

/**
 * A simple, believable taxiway layout built from the runways alone: a parallel taxiway with three connectors
 * per runway and a small apron. Only used for the demo aircraft, which has no scenery to read.
 */
export function syntheticGround(ident: string, airport: Pick<AirportDetails, 'runways'>): AirportGround | null {
  const runways = runwayGeoms(airport).slice(0, 3);
  if (!runways.length) return null;
  const nodes: GroundNode[] = [];
  const edges: GroundEdge[] = [];
  const stands: Stand[] = [];
  const standNode: number[] = [];
  const add = (lat: number, lon: number, hold = false) => nodes.push({ lat, lon, hold }) - 1;
  const link = (a: number, b: number, kind: GroundEdge['kind'], name: string) =>
    edges.push({ a, b, kind, name, lengthM: metresBetween(nodes[a].lat, nodes[a].lon, nodes[b].lat, nodes[b].lon) });

  runways.forEach((rw, k) => {
    const letter = 'ABC'[k];
    const f = frameAt(rw.ends[0].lat, rw.ends[0].lon);
    const e = toLocal(f, rw.ends[1].lat, rw.ends[1].lon);
    const len = Math.hypot(e.x, e.y);
    const u = { x: e.x / len, y: e.y / len };
    const right = { x: u.y, y: -u.x };
    const at = (along: number, offset: number) => fromLocal(f, u.x * along + right.x * offset, u.y * along + right.y * offset);
    const stations = [0, len / 2, len];
    const rwyNodes = stations.map((s) => {
      const p = at(s, 0);
      return add(p.lat, p.lon);
    });
    const parallel = stations.map((s) => {
      const p = at(s, 160);
      return add(p.lat, p.lon);
    });
    stations.forEach((s, i) => {
      const h = at(s, 75);
      const hold = add(h.lat, h.lon, true);
      link(parallel[i], hold, 'taxi', `${letter}${i + 1}`);
      link(hold, rwyNodes[i], 'taxi', `${letter}${i + 1}`);
      if (i > 0) {
        link(parallel[i - 1], parallel[i], 'taxi', letter);
        link(rwyNodes[i - 1], rwyNodes[i], 'runway', '');
      }
    });
    if (k > 0) return;
    // Apron next to the middle of the first runway.
    const apronNodes = [-60, -20, 20, 60].map((d) => {
      const p = at(len / 2 + d, 240);
      return add(p.lat, p.lon);
    });
    const entry = at(len / 2, 240);
    const apronEntry = add(entry.lat, entry.lon);
    link(parallel[1], apronEntry, 'taxi', 'P');
    link(apronNodes[1], apronEntry, 'taxi', 'P');
    link(apronEntry, apronNodes[2], 'taxi', 'P');
    link(apronNodes[0], apronNodes[1], 'taxi', 'P');
    link(apronNodes[2], apronNodes[3], 'taxi', 'P');
    const heading = courseOf(right.x, right.y);
    apronNodes.forEach((an, i) => {
      const p = at(len / 2 + [-60, -20, 20, 60][i], 280);
      const stand: Stand = { index: i, name: `Parking ${i + 1}`, kind: 'ramp', size: 'medium', lat: p.lat, lon: p.lon, headingTrue: heading, radiusM: 18 };
      const sn = nodes.push({ lat: p.lat, lon: p.lon, hold: false, stand: i }) - 1;
      stands.push(stand);
      standNode.push(sn);
      link(an, sn, 'stand', '');
    });
  });
  return finish(ident, 'generated', nodes, edges, stands, standNode, runways);
}

// ---------------------------------------------------------------- Map layout

export function groundLayout(g: AirportGround): GroundLayout {
  return {
    ident: g.ident,
    source: g.source,
    taxiways: g.edges.map((e) => ({
      coords: [
        [round6(g.nodes[e.a].lon), round6(g.nodes[e.a].lat)],
        [round6(g.nodes[e.b].lon), round6(g.nodes[e.b].lat)],
      ],
      name: e.name,
      kind: e.kind,
    })),
    holdShorts: g.nodes
      .filter((n) => n.hold)
      .map((n) => ({ lat: round6(n.lat), lon: round6(n.lon), runway: nearestRunway(g.runways, n.lat, n.lon)?.name ?? '' })),
    stands: g.stands,
  };
}

const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

function nearestRunway(runways: RunwayGeom[], lat: number, lon: number, maxLateral = 250): RunwayGeom | null {
  let best: RunwayGeom | null = null;
  let bestD = maxLateral;
  for (const rw of runways) {
    const { along, lateral } = runwayFrame(rw, lat, lon);
    if (along < -250 || along > rw.lengthM + 250) continue;
    if (lateral < bestD) {
      bestD = lateral;
      best = rw;
    }
  }
  return best;
}

// ---------------------------------------------------------------- Routing

export type TaxiTarget = { kind: 'runway'; runway: string } | { kind: 'stand'; index: number };

export interface TaxiFrom {
  lat: number;
  lon: number;
  headingTrue?: number;
}

/** Cost multiplier for rolling along a runway: used to cross one or when there is no other way. */
const RUNWAY_COST = 6;

class MinHeap {
  private items: Array<[number, number]> = [];
  get size() {
    return this.items.length;
  }
  push(cost: number, node: number) {
    const a = this.items;
    a.push([cost, node]);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): [number, number] {
    const a = this.items;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

/** The stand the aircraft is parked on, if any. */
export function standAt(g: AirportGround, lat: number, lon: number): Stand | null {
  let best: Stand | null = null;
  let bestD = Infinity;
  for (const s of g.stands) {
    const dist = metresBetween(lat, lon, s.lat, s.lon);
    if (dist < Math.max(10, s.radiusM * 0.8) + 8 && dist < bestD) {
      best = s;
      bestD = dist;
    }
  }
  return best;
}

function startCosts(g: AirportGround, from: TaxiFrom): Map<number, number> {
  const out = new Map<number, number>();
  const stand = standAt(g, from.lat, from.lon);
  if (stand) {
    out.set(g.standNode[stand.index], 0);
    return out;
  }
  const near = g.nodes
    .map((n, i) => ({ i, d: n.stand == null && g.adj[i].length ? metresBetween(from.lat, from.lon, n.lat, n.lon) : Infinity }))
    .filter((x) => x.d < 600)
    .sort((a, b) => a.d - b.d)
    .slice(0, 6);
  for (const { i, d } of near) {
    let cost = d;
    if (from.headingTrue != null && d > 15) {
      const f = frameAt(from.lat, from.lon);
      const p = toLocal(f, g.nodes[i].lat, g.nodes[i].lon);
      // Turning around costs more than rolling ahead.
      if (Math.abs(angleDiff(courseOf(p.x, p.y), from.headingTrue)) > 100) cost += 120;
    }
    out.set(i, cost);
  }
  return out;
}

function dijkstra(g: AirportGround, starts: Map<number, number>, target: TaxiTarget): { dist: Float64Array; prev: Int32Array } {
  const dist = new Float64Array(g.nodes.length).fill(Infinity);
  const prev = new Int32Array(g.nodes.length).fill(-1);
  const heap = new MinHeap();
  for (const [n, c] of starts) {
    dist[n] = c;
    heap.push(c, n);
  }
  const targetStandNode = target.kind === 'stand' ? g.standNode[target.index] : -1;
  while (heap.size) {
    const [c, n] = heap.pop();
    if (c > dist[n]) continue;
    if (n === targetStandNode) break;
    for (const ei of g.adj[n]) {
      const e = g.edges[ei];
      const m = e.a === n ? e.b : e.a;
      // Never route through someone else's stand.
      if (g.nodes[m].stand != null && m !== targetStandNode) continue;
      const onRunway = e.kind === 'runway' || (g.nodeRunway[e.a] >= 0 && g.nodeRunway[e.a] === g.nodeRunway[e.b]);
      const nc = c + e.lengthM * (onRunway ? RUNWAY_COST : 1);
      if (nc < dist[m]) {
        dist[m] = nc;
        prev[m] = ei;
        heap.push(nc, m);
      }
    }
  }
  return { dist, prev };
}

/** Nodes where an aircraft can wait for a runway: its hold-short points, or else the last node before it. */
function runwayHoldNodes(g: AirportGround, rwIndex: number): number[] {
  const rw = g.runways[rwIndex];
  const holds: number[] = [];
  g.nodes.forEach((n, i) => {
    if (!n.hold) return;
    const { along, lateral } = runwayFrame(rw, n.lat, n.lon);
    if (along < -150 || along > rw.lengthM + 150 || lateral > 200) return;
    if (nearestRunway(g.runways, n.lat, n.lon) === rw) holds.push(i);
  });
  if (holds.length) return holds;
  const entries = new Set<number>();
  g.edges.forEach((e) => {
    const ra = g.nodeRunway[e.a];
    const rb = g.nodeRunway[e.b];
    if (ra === rwIndex && rb !== rwIndex && g.nodes[e.b].stand == null) entries.add(e.b);
    if (rb === rwIndex && ra !== rwIndex && g.nodes[e.a].stand == null) entries.add(e.a);
  });
  return [...entries];
}

export function findRoute(g: AirportGround, from: TaxiFrom, target: TaxiTarget): TaxiRoute | null {
  const starts = startCosts(g, from);
  if (!starts.size) return null;
  const { dist, prev } = dijkstra(g, starts, target);

  let endNode = -1;
  let runwayIdent = '';
  if (target.kind === 'stand') {
    endNode = g.standNode[target.index] ?? -1;
    if (endNode < 0 || !Number.isFinite(dist[endNode])) return null;
  } else {
    const found = runwayEnd(g.runways, target.runway);
    if (!found) return null;
    runwayIdent = found.rw.idents[found.end];
    const rwIndex = g.runways.indexOf(found.rw);
    let best = Infinity;
    for (const n of runwayHoldNodes(g, rwIndex)) {
      if (!Number.isFinite(dist[n])) continue;
      const { along } = runwayFrame(found.rw, g.nodes[n].lat, g.nodes[n].lon, found.end);
      // Prefer holding points near the threshold so the whole runway is available for take-off.
      const score = dist[n] + 1.5 * Math.max(0, along);
      if (score < best) {
        best = score;
        endNode = n;
      }
    }
    if (endNode < 0) return null;
  }

  const path: number[] = [endNode];
  const pathEdges: number[] = [];
  for (let n = endNode; prev[n] >= 0; ) {
    const e = g.edges[prev[n]];
    pathEdges.unshift(prev[n]);
    n = e.a === n ? e.b : e.a;
    path.unshift(n);
    if (path.length > g.nodes.length) return null;
  }
  return describeRoute(g, from, path, pathEdges, target.kind === 'stand' ? { kind: 'stand', stand: g.stands[target.index] } : { kind: 'runway', runway: runwayIdent });
}

function describeRoute(g: AirportGround, from: TaxiFrom, path: number[], pathEdges: number[], to: TaxiRoute['to']): TaxiRoute {
  const points: Array<[number, number]> = [[from.lon, from.lat], ...path.map((n) => [g.nodes[n].lon, g.nodes[n].lat] as [number, number])];
  const cum = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + metresBetween(points[i - 1][1], points[i - 1][0], points[i][1], points[i][0]));
  const lengthM = cum[cum.length - 1];
  const pointAt = (m: number) => pointAlong(points, cum, m);

  // Runs of consecutive edges with the same taxiway name. Edge j joins points j+1 and j+2.
  type Run = { name: string; startM: number; lengthM: number };
  const runs: Run[] = [];
  pathEdges.forEach((ei, j) => {
    const e = g.edges[ei];
    const name = e.kind === 'taxi' ? e.name : '';
    const startM = cum[j + 1];
    const len = cum[j + 2] - cum[j + 1];
    const last = runs[runs.length - 1];
    if (last && last.name === name) last.lengthM += len;
    else runs.push({ name, startM, lengthM: len });
  });
  // Drop unnamed bits and tiny connector stubs, then merge what becomes adjacent.
  const named: Run[] = [];
  for (const r of runs) {
    if (!r.name || (r.lengthM < 25 && runs.length > 1)) continue;
    const last = named[named.length - 1];
    if (last && last.name === r.name) last.lengthM = r.startM + r.lengthM - last.startM;
    else named.push({ ...r });
  }
  // "K, K7, K" with a short K7 is just "K": fold short links between two stretches of the same taxiway.
  for (let i = 1; i < named.length - 1; i++) {
    const [a, b, c] = [named[i - 1], named[i], named[i + 1]];
    if (a.name === c.name && b.lengthM < 150) {
      a.lengthM = c.startM + c.lengthM - a.startM;
      named.splice(i, 2);
      i--;
    }
  }

  const steps: TaxiStep[] = [];
  named.forEach((r, i) => {
    // The first taxiway is the "via" of the clearance itself.
    if (i === 0) return;
    // Junctions are curved fillets, so measure the heading change over a longer stretch either side.
    const before = pointAt(r.startM - 60);
    const at = pointAt(r.startM);
    const after = pointAt(r.startM + 60);
    const f = frameAt(at.lat, at.lon);
    const pb = toLocal(f, before.lat, before.lon);
    const pa = toLocal(f, after.lat, after.lon);
    const turn = angleDiff(courseOf(pa.x, pa.y), courseOf(-pb.x, -pb.y));
    const verb = Math.abs(turn) < 25 ? 'Continue onto' : turn > 0 ? 'Turn right onto' : 'Turn left onto';
    steps.push({ atM: Math.round(r.startM), kind: 'turn', text: `${verb} ${r.name}` });
  });

  // Runways entered on the way. The runway an arriving aircraft starts on is the one it is leaving.
  const crossings: string[] = [];
  const startRunway = g.runways.findIndex((rw) => {
    const { along, lateral } = runwayFrame(rw, from.lat, from.lon);
    return along >= 0 && along <= rw.lengthM && lateral <= rw.halfWidthM + 5;
  });
  let current = startRunway;
  let enteredAt = 0;
  path.forEach((n, k) => {
    const r = g.nodeRunway[n];
    if (r === current) return;
    if (current >= 0 && current !== startRunway) {
      const along = cum[k + 1] - enteredAt;
      const step = steps.find((s) => s.kind === 'cross' && s.atM === Math.round(Math.max(0, enteredAt - 50)));
      if (step && along > 150) step.text = `Taxi along runway ${g.runways[current].idents[0]}`;
    }
    current = r;
    if (r >= 0 && r !== startRunway) {
      enteredAt = cum[k + 1];
      const ident = g.runways[r].idents[0];
      crossings.push(ident);
      steps.push({ atM: Math.round(Math.max(0, enteredAt - 50)), kind: 'cross', text: `Cross runway ${ident}` });
    }
  });

  steps.push(
    to.kind === 'runway'
      ? { atM: Math.round(lengthM), kind: 'hold', text: `Hold short of runway ${to.runway}` }
      : { atM: Math.round(lengthM), kind: 'stand', text: `Arrive at ${to.stand.name}` },
  );
  steps.sort((a, b) => a.atM - b.atM);

  return { airport: g.ident, to, points, via: named.map((r) => r.name), crossings, steps, lengthM: Math.round(lengthM) };
}

export function pointAlong(points: Array<[number, number]>, cum: number[], m: number): { lat: number; lon: number } {
  if (m <= 0) return { lat: points[0][1], lon: points[0][0] };
  for (let i = 1; i < points.length; i++) {
    if (cum[i] >= m) {
      const t = (m - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
      return { lat: points[i - 1][1] + (points[i][1] - points[i - 1][1]) * t, lon: points[i - 1][0] + (points[i][0] - points[i - 1][0]) * t };
    }
  }
  const last = points[points.length - 1];
  return { lat: last[1], lon: last[0] };
}

/** A stand suited to the aircraft: the right kind and size, picked consistently for the same callsign. */
export function pickStand(g: AirportGround, opts: { large: boolean; small: boolean; seed: string }): Stand | null {
  const wanted = g.stands.filter((s) => s.kind === 'gate' || s.kind === 'ramp');
  const pool = wanted.filter((s) => (opts.large ? s.size === 'large' : opts.small ? s.kind === 'ramp' && s.size !== 'large' : s.size !== 'small'));
  const list = pool.length ? pool : wanted.length ? wanted : g.stands;
  if (!list.length) return null;
  let h = 0;
  for (const ch of opts.seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return list[h % list.length];
}
