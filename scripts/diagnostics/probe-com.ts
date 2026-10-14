// Diagnostic: prints COM 1 frequency and channel spacing mode. Usage: npx tsx scripts/diagnostics/probe-com.ts
import { open, Protocol, SimConnectConstants, SimConnectDataType, SimConnectPeriod } from 'node-simconnect';

const { handle } = await open('SkyDeck probe com', Protocol.KittyHawk);
const vars: Array<[string, string]> = [['COM ACTIVE FREQUENCY:1', 'MHz'], ['COM STANDBY FREQUENCY:1', 'MHz'], ['COM SPACING MODE:1', 'Enum']];
vars.forEach(([n, u]) => handle.addToDataDefinition(1, n, u, SimConnectDataType.FLOAT64));
handle.requestDataOnSimObject(1, 1, SimConnectConstants.OBJECT_ID_USER, SimConnectPeriod.ONCE);
handle.on('simObjectData', (d) => {
  console.log(Object.fromEntries(vars.map(([n]) => [n, d.data.readFloat64()])));
  process.exit(0);
});
setTimeout(() => process.exit(1), 5000);
