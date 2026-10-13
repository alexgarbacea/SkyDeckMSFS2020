// Diagnostic: prints the legs of one departure/arrival/approach from the sim database.
// Usage: npx tsx scripts/diagnostics/probe-legs.ts ICAO
import { open, Protocol, FacilityDataType } from 'node-simconnect';
const icao = (process.argv[2] ?? 'LTBA').toUpperCase();
const { handle } = await open('SkyDeck probe legs', Protocol.KittyHawk);
handle.on('exception', (e) => console.log('EXC', e.exceptionName, e.index));
const leg = ['OPEN APPROACH_LEG', 'TYPE', 'FIX_ICAO', 'FIX_REGION', 'FIX_TYPE', 'FIX_LATITUDE', 'FIX_LONGITUDE', 'CLOSE APPROACH_LEG'];
const f = [
  'OPEN AIRPORT',
  'OPEN DEPARTURE', 'NAME',
  'OPEN RUNWAY_TRANSITION', 'RUNWAY_NUMBER', 'RUNWAY_DESIGNATOR', ...leg, 'CLOSE RUNWAY_TRANSITION',
  ...leg,
  'CLOSE DEPARTURE',
  'CLOSE AIRPORT',
];
f.forEach((x) => handle.addToFacilityDefinition(1, x));
handle.requestFacilityData(1, 5, icao);
let n = 0;
handle.on('facilityData', (r) => {
  const b = r.data;
  if (n++ > 40) return;
  if (r.type === FacilityDataType.DEPARTURE) console.log('DEP', b.readString8(), r.uniqueRequestId);
  else if (r.type === FacilityDataType.RUNWAY_TRANSITION) console.log(' RWY', b.readInt32(), b.readInt32(), 'parent', r.parentUniqueRequestId, 'uid', r.uniqueRequestId);
  else if (r.type === FacilityDataType.APPROACH_LEG) { const len = (b as unknown as { buffer: Buffer }).buffer?.length; console.log('  LEG', { type: b.readInt32(), fix: b.readString8(), region: b.readString8(), fixType: b.readInt32(), lat: b.readFloat64(), lon: b.readFloat64() }, 'parent', r.parentUniqueRequestId, len); }
  else console.log(FacilityDataType[r.type]);
});
handle.on('facilityDataEnd', () => process.exit(0));
setTimeout(() => process.exit(1), 6000);
