// Diagnostic against a running flight. Read-only. Usage: npx tsx scripts/diagnostics/live-check.ts
import { SimConnectBridge } from '../../src/server/bridge/simconnect.js';
import { loadNavData, regionsNear } from '../../src/server/navdata.js';
import type { Telemetry } from '../../src/shared/types.js';

await loadNavData();
const b = new SimConnectBridge();
let latest: Telemetry | null = null;
b.on('telemetry', (t: Telemetry) => (latest = t));
b.start();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 50 && !latest; i++) await sleep(200);
await sleep(1500);
const t = latest as Telemetry | null;
if (!t) { console.log('no telemetry; inFlight=', b.inFlight); process.exit(1); }
console.log('inFlight', b.inFlight);
console.log(JSON.stringify({ aircraft: t.aircraft, position: t.position, attitude: t.attitude, ap: t.autopilot, radios: t.radios, lights: t.lights, systems: t.systems, engines: t.engines, fuel: t.fuel, sim: t.sim, gps: t.gps, env: t.environment }, null, 1));
const regions = regionsNear(t.position.lat, t.position.lon);
console.log('regions', regions);
process.exit(0);
