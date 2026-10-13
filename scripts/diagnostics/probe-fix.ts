// Diagnostic: looks up a fix in the sim database. Usage: npx tsx scripts/diagnostics/probe-fix.ts IDENT [REGION]
import { open, Protocol, FacilityDataType } from 'node-simconnect';
const ident = (process.argv[2] ?? 'ASTON').toUpperCase();
const region = process.argv[3] ?? '';
const { handle } = await open('SkyDeck probe', Protocol.KittyHawk);
handle.on('exception', (e) => console.log('EXCEPTION', e.exceptionName, e.sendId, e.index));
['OPEN WAYPOINT', 'LATITUDE', 'LONGITUDE', 'ICAO', 'REGION', 'CLOSE WAYPOINT'].forEach((f) => console.log(f, handle.addToFacilityDefinition(1, f)));
console.log('req', handle.requestFacilityData(1, 7, ident, region, 'W'));
handle.on('facilityData', (r) => {
  const b = r.data;
  console.log(FacilityDataType[r.type], b.readFloat64(), b.readFloat64(), b.readString8(), b.readString8());
});
handle.on('facilityDataEnd', (r) => { console.log('end', r.userRequestId); process.exit(0); });
setTimeout(() => { console.log('timeout'); process.exit(1); }, 5000);
