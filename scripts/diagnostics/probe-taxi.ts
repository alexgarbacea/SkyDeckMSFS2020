// Diagnostic: prints the taxiway, hold-short and parking data of one airport from the sim database.
// Read-only. Usage: npx tsx scripts/diagnostics/probe-taxi.ts ICAO
import { open, Protocol, FacilityDataType } from 'node-simconnect';

const icao = (process.argv[2] ?? 'LFPG').toUpperCase();
const { handle } = await open('SkyDeck probe taxi', Protocol.KittyHawk);
handle.on('exception', (e) => console.log('EXCEPTION', e.exceptionName, 'index', e.index));
[
  'OPEN AIRPORT', 'LATITUDE', 'LONGITUDE', 'N_TAXI_POINTS', 'N_TAXI_PARKINGS', 'N_TAXI_PATHS', 'N_TAXI_NAMES',
  'OPEN TAXI_POINT', 'TYPE', 'BIAS_X', 'BIAS_Z', 'CLOSE TAXI_POINT',
  'OPEN TAXI_PARKING', 'TYPE', 'NAME', 'NUMBER', 'HEADING', 'RADIUS', 'BIAS_X', 'BIAS_Z', 'CLOSE TAXI_PARKING',
  'OPEN TAXI_PATH', 'TYPE', 'START', 'END', 'NAME_INDEX', 'CLOSE TAXI_PATH',
  'OPEN TAXI_NAME', 'NAME', 'CLOSE TAXI_NAME',
  'CLOSE AIRPORT',
].forEach((f) => handle.addToFacilityDefinition(1, f));
handle.requestFacilityData(1, 7, icao);
const counts: Record<string, number> = {};
const started = Date.now();
handle.on('facilityData', (r) => {
  const t = FacilityDataType[r.type];
  const n = (counts[t] = (counts[t] ?? 0) + 1);
  const b = r.data;
  const show = n <= 4;
  const tail = () => `(${b.remaining()} bytes left, item ${r.itemIndex}/${r.listSize})`;
  switch (r.type) {
    case FacilityDataType.AIRPORT:
      console.log('AIRPORT', { lat: b.readFloat64(), lon: b.readFloat64(), points: b.readInt32(), parkings: b.readInt32(), paths: b.readInt32(), names: b.readInt32() }, tail());
      break;
    case FacilityDataType.TAXI_POINT:
      if (show) console.log('POINT', { type: b.readInt32(), x: b.readFloat32(), z: b.readFloat32() }, tail());
      break;
    case FacilityDataType.TAXI_PARKING:
      if (show) console.log('PARKING', { type: b.readInt32(), name: b.readInt32(), number: b.readInt32(), heading: b.readFloat32(), radius: b.readFloat32(), x: b.readFloat32(), z: b.readFloat32() }, tail());
      break;
    case FacilityDataType.TAXI_PATH:
      if (show) console.log('PATH', { type: b.readInt32(), start: b.readInt32(), end: b.readInt32(), name: b.readInt32() }, tail());
      break;
    case FacilityDataType.TAXI_NAME:
      if (show) console.log('NAME', b.readString32(), tail());
      break;
  }
});
handle.on('facilityDataEnd', () => {
  console.log('counts', counts, `${Date.now() - started} ms`);
  setTimeout(() => process.exit(0), 200);
});
setTimeout(() => {
  console.log('timeout; counts', counts);
  process.exit(1);
}, 15000);
