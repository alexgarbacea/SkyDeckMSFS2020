// Diagnostic: builds the taxi graph of the airport the aircraft is at and plans a route to each runway.
// Read-only. Usage: npx tsx scripts/diagnostics/check-ground.ts ICAO [RUNWAY]
import { SimConnectBridge } from '../../src/server/bridge/simconnect.js';
import { buildGround, calibrate, findRoute, standAt } from '../../src/server/ground/graph.js';
import { runwayGeoms } from '../../src/server/ground/geometry.js';
import type { Telemetry } from '../../src/shared/types.js';

const icao = (process.argv[2] ?? 'LFPG').toUpperCase();
const bridge = new SimConnectBridge();
bridge.start();
const t = await new Promise<Telemetry>((resolve) => bridge.once('telemetry', resolve));
const details = await bridge.airportFromSim(icao);
const raw = await bridge.airportGround(icao);
if (!details?.runways || !raw) {
  console.log('No data for', icao);
  process.exit(1);
}
const cal = calibrate(raw, runwayGeoms({ runways: details.runways }));
console.log('calibration', cal);
const g = buildGround(icao, raw, { runways: details.runways }, cal.orientation);
console.log({ nodes: g.nodes.length, edges: g.edges.length, stands: g.stands.length, holds: g.nodes.filter((n) => n.hold).length, runways: g.runways.map((r) => r.name) });
const here = { lat: t.position.lat, lon: t.position.lon, headingTrue: t.attitude.hdgTrue };
console.log('aircraft', here, 'stand', standAt(g, here.lat, here.lon)?.name ?? 'none');
const kinds: Record<string, number> = {};
g.stands.forEach((s) => (kinds[`${s.kind}/${s.size}`] = (kinds[`${s.kind}/${s.size}`] ?? 0) + 1));
console.log('stand kinds', kinds, 'sample names', g.stands.slice(0, 8).map((s) => s.name));
const runways = process.argv[3] ? [process.argv[3]] : g.runways.flatMap((r) => r.idents);
for (const rwy of runways) {
  const started = Date.now();
  const r = findRoute(g, here, { kind: 'runway', runway: rwy });
  if (!r) {
    console.log(rwy, 'no route');
    continue;
  }
  console.log(`RWY ${rwy}: ${r.lengthM} m via ${r.via.join(' ')} crossings [${r.crossings.join(', ')}] (${Date.now() - started} ms)`);
  for (const s of r.steps) console.log(`   ${String(s.atM).padStart(5)} m  ${s.text}`);
}
bridge.stop();
process.exit(0);
