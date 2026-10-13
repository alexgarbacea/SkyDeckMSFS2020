// Diagnostic: connects to MSFS, prints a few live values and the procedures of one airport.
// Read-only. Usage: npx tsx scripts/diagnostics/probe-sim.ts [ICAO]
import { open, Protocol, SimConnectConstants, SimConnectDataType, SimConnectPeriod, FacilityDataType } from 'node-simconnect';

const icao = (process.argv[2] ?? 'LZIB').toUpperCase();

const { recvOpen, handle } = await open('SkyDeck probe', Protocol.KittyHawk);
console.log('Connected to', recvOpen.applicationName, `${recvOpen.applicationVersionMajor}.${recvOpen.applicationVersionMinor}`);
handle.on('exception', (e) => console.log('EXCEPTION', e.exceptionName, 'sendId', e.sendId, 'index', e.index));

const vars: Array<[string, string]> = [
  ['PLANE LATITUDE', 'degrees'],
  ['PLANE LONGITUDE', 'degrees'],
  ['PLANE ALTITUDE', 'feet'],
  ['AIRSPEED INDICATED', 'knots'],
  ['SIM ON GROUND', 'bool'],
  ['AUTOPILOT AVAILABLE', 'bool'],
  ['GPS IS ACTIVE FLIGHT PLAN', 'bool'],
  ['GPS FLIGHT PLAN WP COUNT', 'number'],
  ['TRANSPONDER CODE:1', 'Bco16'],
  ['SIMULATION RATE', 'number'],
];
vars.forEach(([n, u]) => handle.addToDataDefinition(1, n, u, SimConnectDataType.FLOAT64));
handle.addToDataDefinition(2, 'TITLE', null, SimConnectDataType.STRING256);
handle.requestDataOnSimObject(1, 1, SimConnectConstants.OBJECT_ID_USER, SimConnectPeriod.ONCE);
handle.requestDataOnSimObject(2, 2, SimConnectConstants.OBJECT_ID_USER, SimConnectPeriod.ONCE);
handle.on('simObjectData', (d) => {
  if (d.requestID === 1) console.log(Object.fromEntries(vars.map(([n]) => [n, d.data.readFloat64()])));
  if (d.requestID === 2) console.log('TITLE', d.data.readString256());
});

const F = 10;
const fields = [
  'OPEN AIRPORT', 'LATITUDE', 'LONGITUDE', 'NAME', 'N_RUNWAYS', 'N_FREQUENCIES', 'N_APPROACHES', 'N_DEPARTURES', 'N_ARRIVALS',
  'OPEN RUNWAY', 'PRIMARY_NUMBER', 'PRIMARY_DESIGNATOR', 'SECONDARY_NUMBER', 'SECONDARY_DESIGNATOR', 'CLOSE RUNWAY',
  'OPEN FREQUENCY', 'TYPE', 'FREQUENCY', 'NAME', 'CLOSE FREQUENCY',
  'OPEN APPROACH', 'TYPE', 'SUFFIX', 'RUNWAY_NUMBER', 'RUNWAY_DESIGNATOR',
  'OPEN APPROACH_TRANSITION', 'IAF_ICAO', 'CLOSE APPROACH_TRANSITION', 'CLOSE APPROACH',
  'OPEN DEPARTURE', 'NAME',
  'OPEN RUNWAY_TRANSITION', 'RUNWAY_NUMBER', 'RUNWAY_DESIGNATOR', 'CLOSE RUNWAY_TRANSITION',
  'OPEN ENROUTE_TRANSITION', 'NAME', 'CLOSE ENROUTE_TRANSITION', 'CLOSE DEPARTURE',
  'OPEN ARRIVAL', 'NAME',
  'OPEN RUNWAY_TRANSITION', 'RUNWAY_NUMBER', 'RUNWAY_DESIGNATOR', 'CLOSE RUNWAY_TRANSITION',
  'OPEN ENROUTE_TRANSITION', 'NAME', 'CLOSE ENROUTE_TRANSITION', 'CLOSE ARRIVAL',
  'CLOSE AIRPORT',
];
fields.forEach((f) => handle.addToFacilityDefinition(F, f));
handle.requestFacilityData(F, 99, icao);
const counts: Record<string, number> = {};
handle.on('facilityData', (r) => {
  const t = FacilityDataType[r.type];
  counts[t] = (counts[t] ?? 0) + 1;
  const b = r.data;
  switch (r.type) {
    case FacilityDataType.AIRPORT:
      console.log('AIRPORT', { lat: b.readFloat64(), lon: b.readFloat64(), name: b.readString32(), runways: b.readInt32(), freqs: b.readInt32(), apps: b.readInt32(), deps: b.readInt32(), arrs: b.readInt32() });
      break;
    case FacilityDataType.RUNWAY:
      if (counts[t] <= 3) console.log('RUNWAY', b.readInt32(), b.readInt32(), b.readInt32(), b.readInt32());
      break;
    case FacilityDataType.FREQUENCY:
      if (counts[t] <= 3) console.log('FREQ', b.readInt32(), b.readInt32(), b.readString64());
      break;
    case FacilityDataType.APPROACH:
      if (counts[t] <= 4) console.log('APPROACH', { type: b.readInt32(), suffix: b.readInt32(), rwy: b.readInt32(), des: b.readInt32(), uid: r.uniqueRequestId });
      break;
    case FacilityDataType.APPROACH_TRANSITION:
      if (counts[t] <= 2) console.log('APP TRANS', b.readString8(), 'parent', r.parentUniqueRequestId);
      break;
    case FacilityDataType.DEPARTURE:
    case FacilityDataType.ARRIVAL:
      if (counts[t] <= 3) console.log(t, b.readString8(), 'uid', r.uniqueRequestId);
      break;
    case FacilityDataType.RUNWAY_TRANSITION:
      if (counts[t] <= 3) console.log('RWY TRANS', b.readInt32(), b.readInt32(), 'parent', r.parentUniqueRequestId);
      break;
    case FacilityDataType.ENROUTE_TRANSITION:
      if (counts[t] <= 3) console.log('ENR TRANS', b.readString8(), 'parent', r.parentUniqueRequestId);
      break;
  }
});
handle.on('facilityDataEnd', () => {
  console.log('facility counts', counts);
  setTimeout(() => { handle.close(); process.exit(0); }, 300);
});
setTimeout(() => { console.log('timeout; counts', counts); process.exit(1); }, 8000);
