// The simulation variables SkyDeck reads, and how they map onto the Telemetry object.
import { LIGHT_NAMES, type Telemetry } from '../../shared/types.js';
import { bearingDeg, distanceNm, normalizeDeg } from '../../shared/geo.js';

export const MAX_ENGINES = 4;

const engineVars: Array<[string, string]> = [];
for (let i = 1; i <= MAX_ENGINES; i++) {
  engineVars.push(
    [`GENERAL ENG COMBUSTION:${i}`, 'bool'],
    [`GENERAL ENG RPM:${i}`, 'rpm'],
    [`TURB ENG N1:${i}`, 'percent'],
    [`ENG FUEL FLOW GPH:${i}`, 'gallons per hour'],
    [`GENERAL ENG THROTTLE LEVER POSITION:${i}`, 'percent'],
  );
}

const LIGHT_VARS: Record<(typeof LIGHT_NAMES)[number], string> = {
  nav: 'LIGHT NAV',
  beacon: 'LIGHT BEACON',
  strobe: 'LIGHT STROBE',
  landing: 'LIGHT LANDING',
  taxi: 'LIGHT TAXI',
  logo: 'LIGHT LOGO',
  wing: 'LIGHT WING',
  recognition: 'LIGHT RECOGNITION',
  panel: 'LIGHT PANEL',
  cabin: 'LIGHT CABIN',
};

/** Numeric variables, all requested as FLOAT64 in this order. */
export const NUMERIC_VARS: Array<[name: string, unit: string]> = [
  ['PLANE LATITUDE', 'degrees'],
  ['PLANE LONGITUDE', 'degrees'],
  ['PLANE ALTITUDE', 'feet'],
  ['INDICATED ALTITUDE', 'feet'],
  ['PLANE ALT ABOVE GROUND', 'feet'],
  ['SIM ON GROUND', 'bool'],
  ['AIRSPEED INDICATED', 'knots'],
  ['AIRSPEED TRUE', 'knots'],
  ['GROUND VELOCITY', 'knots'],
  ['AIRSPEED MACH', 'mach'],
  ['VERTICAL SPEED', 'feet per minute'],
  ['PLANE HEADING DEGREES MAGNETIC', 'degrees'],
  ['PLANE HEADING DEGREES TRUE', 'degrees'],
  ['GPS GROUND TRUE TRACK', 'degrees'],
  ['PLANE PITCH DEGREES', 'degrees'],
  ['PLANE BANK DEGREES', 'degrees'],
  ['MAGVAR', 'degrees'],
  ['AMBIENT WIND DIRECTION', 'degrees'],
  ['AMBIENT WIND VELOCITY', 'knots'],
  ['AMBIENT TEMPERATURE', 'celsius'],
  ['KOHLSMAN SETTING HG:1', 'inHg'],
  ['SEA LEVEL PRESSURE', 'millibars'],
  // Autopilot
  ['AUTOPILOT AVAILABLE', 'bool'],
  ['AUTOPILOT MASTER', 'bool'],
  ['AUTOPILOT FLIGHT DIRECTOR ACTIVE', 'bool'],
  ['AUTOPILOT YAW DAMPER', 'bool'],
  ['AUTOPILOT THROTTLE ARM', 'bool'],
  ['AUTOPILOT HEADING LOCK', 'bool'],
  ['AUTOPILOT NAV1 LOCK', 'bool'],
  ['AUTOPILOT APPROACH HOLD', 'bool'],
  ['AUTOPILOT BACKCOURSE HOLD', 'bool'],
  ['AUTOPILOT ALTITUDE LOCK', 'bool'],
  ['AUTOPILOT VERTICAL HOLD', 'bool'],
  ['AUTOPILOT FLIGHT LEVEL CHANGE', 'bool'],
  ['AUTOPILOT AIRSPEED HOLD', 'bool'],
  ['AUTOPILOT WING LEVELER', 'bool'],
  ['AUTOPILOT GLIDESLOPE ACTIVE', 'bool'],
  ['AUTOPILOT HEADING LOCK DIR', 'degrees'],
  ['AUTOPILOT ALTITUDE LOCK VAR', 'feet'],
  ['AUTOPILOT VERTICAL HOLD VAR', 'feet per minute'],
  ['AUTOPILOT AIRSPEED HOLD VAR', 'knots'],
  ['GPS DRIVES NAV1', 'bool'],
  // Radios
  ['COM ACTIVE FREQUENCY:1', 'MHz'],
  ['COM STANDBY FREQUENCY:1', 'MHz'],
  ['COM ACTIVE FREQUENCY:2', 'MHz'],
  ['COM STANDBY FREQUENCY:2', 'MHz'],
  ['NAV ACTIVE FREQUENCY:1', 'MHz'],
  ['NAV STANDBY FREQUENCY:1', 'MHz'],
  ['NAV ACTIVE FREQUENCY:2', 'MHz'],
  ['NAV STANDBY FREQUENCY:2', 'MHz'],
  ['NAV OBS:1', 'degrees'],
  ['NAV OBS:2', 'degrees'],
  ['NAV HAS DME:1', 'bool'],
  ['NAV HAS DME:2', 'bool'],
  ['NAV DME:1', 'nautical miles'],
  ['NAV DME:2', 'nautical miles'],
  ['NAV HAS NAV:1', 'bool'],
  ['NAV HAS NAV:2', 'bool'],
  ['ADF ACTIVE FREQUENCY:1', 'KHz'],
  ['ADF STANDBY FREQUENCY:1', 'KHz'],
  ['TRANSPONDER CODE:1', 'Bco16'],
  ['TRANSPONDER STATE:1', 'enum'],
  // Lights
  ...Object.values(LIGHT_VARS).map((n): [string, string] => [n, 'bool']),
  // Systems
  ['IS GEAR RETRACTABLE', 'bool'],
  ['GEAR HANDLE POSITION', 'bool'],
  ['GEAR TOTAL PCT EXTENDED', 'percent'],
  ['FLAPS HANDLE INDEX', 'number'],
  ['FLAPS NUM HANDLE POSITIONS', 'number'],
  ['FLAPS HANDLE PERCENT', 'percent'],
  ['SPOILER AVAILABLE', 'bool'],
  ['SPOILERS HANDLE POSITION', 'percent'],
  ['SPOILERS ARMED', 'bool'],
  ['BRAKE PARKING POSITION', 'bool'],
  ['ELECTRICAL MASTER BATTERY', 'bool'],
  ['AVIONICS MASTER SWITCH', 'bool'],
  ['PITOT HEAT', 'bool'],
  ['PUSHBACK STATE', 'enum'],
  ['EXIT OPEN:0', 'percent'],
  // Engines
  ['NUMBER OF ENGINES', 'number'],
  ['ENGINE TYPE', 'enum'],
  ...engineVars,
  // Fuel & weight
  ['FUEL TOTAL QUANTITY', 'gallons'],
  ['FUEL TOTAL CAPACITY', 'gallons'],
  ['FUEL TOTAL QUANTITY WEIGHT', 'pounds'],
  ['FUEL WEIGHT PER GALLON', 'pounds'],
  ['TOTAL WEIGHT', 'pounds'],
  ['MAX GROSS WEIGHT', 'pounds'],
  ['EMPTY WEIGHT', 'pounds'],
  // Simulation
  ['SIMULATION RATE', 'number'],
  ['IS SLEW ACTIVE', 'bool'],
  ['ZULU TIME', 'seconds'],
  ['LOCAL TIME', 'seconds'],
  ['ZULU DAY OF YEAR', 'number'],
  ['ZULU YEAR', 'number'],
  // GPS
  ['GPS IS ACTIVE FLIGHT PLAN', 'bool'],
  ['GPS IS DIRECTTO FLIGHTPLAN', 'bool'],
  ['GPS FLIGHT PLAN WP INDEX', 'number'],
  ['GPS FLIGHT PLAN WP COUNT', 'number'],
  ['GPS WP NEXT LAT', 'degrees'],
  ['GPS WP NEXT LON', 'degrees'],
  ['GPS WP PREV LAT', 'degrees'],
  ['GPS WP PREV LON', 'degrees'],
  ['GPS WP DISTANCE', 'nautical miles'],
  ['GPS WP ETE', 'seconds'],
  ['GPS ETE', 'seconds'],
  ['GPS WP BEARING', 'degrees'],
  ['GPS WP CROSS TRK', 'nautical miles'],
];

/** String variables, requested less often. [name, byte length]. */
export const STRING_VARS: Array<[name: string, size: 32 | 64 | 256]> = [
  ['TITLE', 256],
  ['ATC ID', 32],
  ['ATC MODEL', 64],
  ['GPS WP NEXT ID', 32],
  ['GPS WP PREV ID', 32],
];

/** Fuel tanks that can be written to set a fuel load. */
export const FUEL_TANKS = [
  'CENTER', 'CENTER2', 'CENTER3', 'LEFT MAIN', 'LEFT AUX', 'LEFT TIP', 'RIGHT MAIN', 'RIGHT AUX', 'RIGHT TIP', 'EXTERNAL1', 'EXTERNAL2',
];

type Values = Record<string, number>;
type Strings = Record<string, string>;

/** Decodes a BCD16 transponder value (0x7000) into "7000". */
export function decodeBcd16(value: number): string {
  return Math.round(value).toString(16).padStart(4, '0').slice(-4);
}

const round = (v: number, digits = 0) => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};
const bool = (v: number | undefined) => (v ?? 0) > 0.5;

/**
 * Avionics with their own flight management (e.g. the G1000 NXi) fill in the next waypoint but leave the legacy
 * GPS distance/bearing/time variables at zero. Derive them from the aircraft position in that case.
 */
function fillGpsGaps(t: Telemetry) {
  const g = t.gps;
  if (!g.hasPlan || (!g.nextLat && !g.nextLon) || g.distNm > 0) return;
  const { lat, lon } = t.position;
  g.distNm = round(distanceNm(lat, lon, g.nextLat, g.nextLon), 1);
  g.bearingMag = round(normalizeDeg(bearingDeg(lat, lon, g.nextLat, g.nextLon) - t.attitude.magVar));
  if (t.speed.gs > 30) g.eteSec = Math.round((g.distNm / t.speed.gs) * 3600);
}

export function buildTelemetry(v: Values, s: Strings): Telemetry {
  const t = rawTelemetry(v, s);
  fillGpsGaps(t);
  return t;
}

function rawTelemetry(v: Values, s: Strings): Telemetry {
  const engineCount = Math.max(0, Math.min(MAX_ENGINES, Math.round(v['NUMBER OF ENGINES'] ?? 0)));
  const engines = [];
  for (let i = 1; i <= engineCount; i++) {
    engines.push({
      running: bool(v[`GENERAL ENG COMBUSTION:${i}`]),
      rpm: round(v[`GENERAL ENG RPM:${i}`]),
      n1: round(v[`TURB ENG N1:${i}`], 1),
      fuelFlowGph: round(v[`ENG FUEL FLOW GPH:${i}`], 1),
      throttlePct: round(v[`GENERAL ENG THROTTLE LEVER POSITION:${i}`]),
    });
  }
  const hasDme = (n: 1 | 2) => bool(v[`NAV HAS DME:${n}`]);
  const lights = Object.fromEntries(
    Object.entries(LIGHT_VARS).map(([k, name]) => [k, bool(v[name])]),
  ) as Telemetry['lights'];

  return {
    time: Date.now(),
    aircraft: { title: s['TITLE'] ?? '', atcId: s['ATC ID'] ?? '', atcModel: s['ATC MODEL'] ?? '' },
    position: {
      lat: v['PLANE LATITUDE'],
      lon: v['PLANE LONGITUDE'],
      altFt: round(v['PLANE ALTITUDE']),
      indicatedAltFt: round(v['INDICATED ALTITUDE']),
      aglFt: round(v['PLANE ALT ABOVE GROUND']),
      onGround: bool(v['SIM ON GROUND']),
    },
    speed: {
      ias: round(v['AIRSPEED INDICATED']),
      tas: round(v['AIRSPEED TRUE']),
      gs: round(v['GROUND VELOCITY']),
      mach: round(v['AIRSPEED MACH'], 3),
      vsFpm: round(v['VERTICAL SPEED']),
    },
    attitude: {
      hdgMag: round(v['PLANE HEADING DEGREES MAGNETIC'], 1),
      hdgTrue: round(v['PLANE HEADING DEGREES TRUE'], 1),
      trackTrue: round(v['GPS GROUND TRUE TRACK'], 1),
      // MSFS reports pitch positive nose-down and bank positive left-wing-down; flip to the usual convention.
      pitch: round(-v['PLANE PITCH DEGREES'], 1),
      bank: round(-v['PLANE BANK DEGREES'], 1),
      magVar: round(v['MAGVAR'], 1),
    },
    environment: {
      windDir: round(v['AMBIENT WIND DIRECTION']),
      windKt: round(v['AMBIENT WIND VELOCITY']),
      oatC: round(v['AMBIENT TEMPERATURE'], 1),
      baroInHg: round(v['KOHLSMAN SETTING HG:1'], 2),
      seaLevelPressureMb: round(v['SEA LEVEL PRESSURE'], 1),
    },
    autopilot: {
      available: bool(v['AUTOPILOT AVAILABLE']),
      master: bool(v['AUTOPILOT MASTER']),
      flightDirector: bool(v['AUTOPILOT FLIGHT DIRECTOR ACTIVE']),
      yawDamper: bool(v['AUTOPILOT YAW DAMPER']),
      autothrottle: bool(v['AUTOPILOT THROTTLE ARM']),
      hdgMode: bool(v['AUTOPILOT HEADING LOCK']),
      navMode: bool(v['AUTOPILOT NAV1 LOCK']),
      aprMode: bool(v['AUTOPILOT APPROACH HOLD']),
      bcMode: bool(v['AUTOPILOT BACKCOURSE HOLD']),
      altMode: bool(v['AUTOPILOT ALTITUDE LOCK']),
      vsMode: bool(v['AUTOPILOT VERTICAL HOLD']),
      flcMode: bool(v['AUTOPILOT FLIGHT LEVEL CHANGE']),
      spdMode: bool(v['AUTOPILOT AIRSPEED HOLD']),
      levelMode: bool(v['AUTOPILOT WING LEVELER']),
      glideslopeActive: bool(v['AUTOPILOT GLIDESLOPE ACTIVE']),
      hdg: round(v['AUTOPILOT HEADING LOCK DIR']),
      alt: round(v['AUTOPILOT ALTITUDE LOCK VAR']),
      vs: round(v['AUTOPILOT VERTICAL HOLD VAR']),
      spd: round(v['AUTOPILOT AIRSPEED HOLD VAR']),
      gpsDrivesNav: bool(v['GPS DRIVES NAV1']),
    },
    radios: {
      com1: { active: round(v['COM ACTIVE FREQUENCY:1'], 3), standby: round(v['COM STANDBY FREQUENCY:1'], 3) },
      com2: { active: round(v['COM ACTIVE FREQUENCY:2'], 3), standby: round(v['COM STANDBY FREQUENCY:2'], 3) },
      nav1: {
        active: round(v['NAV ACTIVE FREQUENCY:1'], 2),
        standby: round(v['NAV STANDBY FREQUENCY:1'], 2),
        obs: round(v['NAV OBS:1']),
        dmeNm: hasDme(1) ? round(v['NAV DME:1'], 1) : null,
        hasSignal: bool(v['NAV HAS NAV:1']),
      },
      nav2: {
        active: round(v['NAV ACTIVE FREQUENCY:2'], 2),
        standby: round(v['NAV STANDBY FREQUENCY:2'], 2),
        obs: round(v['NAV OBS:2']),
        dmeNm: hasDme(2) ? round(v['NAV DME:2'], 1) : null,
        hasSignal: bool(v['NAV HAS NAV:2']),
      },
      adfKhz: round(v['ADF ACTIVE FREQUENCY:1'], 1),
      adfStandbyKhz: round(v['ADF STANDBY FREQUENCY:1'], 1),
      xpdrCode: decodeBcd16(v['TRANSPONDER CODE:1']),
      xpdrState: Math.round(v['TRANSPONDER STATE:1']),
    },
    lights,
    systems: {
      gearRetractable: bool(v['IS GEAR RETRACTABLE']),
      gearDown: bool(v['GEAR HANDLE POSITION']),
      gearPct: round(v['GEAR TOTAL PCT EXTENDED']),
      flapsIndex: Math.round(v['FLAPS HANDLE INDEX']),
      flapsPositions: Math.round(v['FLAPS NUM HANDLE POSITIONS']),
      flapsPct: round(v['FLAPS HANDLE PERCENT']),
      spoilersAvailable: bool(v['SPOILER AVAILABLE']),
      spoilersPct: round(v['SPOILERS HANDLE POSITION']),
      spoilersArmed: bool(v['SPOILERS ARMED']),
      parkingBrake: bool(v['BRAKE PARKING POSITION']),
      battery: bool(v['ELECTRICAL MASTER BATTERY']),
      avionics: bool(v['AVIONICS MASTER SWITCH']),
      pitotHeat: bool(v['PITOT HEAT']),
      pushbackState: Math.round(v['PUSHBACK STATE']),
      doorPct: round(v['EXIT OPEN:0']),
    },
    engines: { count: engineCount, type: Math.round(v['ENGINE TYPE']), list: engines },
    fuel: {
      totalGal: round(v['FUEL TOTAL QUANTITY'], 1),
      capacityGal: round(v['FUEL TOTAL CAPACITY'], 1),
      totalLbs: round(v['FUEL TOTAL QUANTITY WEIGHT']),
      lbsPerGal: round(v['FUEL WEIGHT PER GALLON'], 2),
    },
    weight: { totalLbs: round(v['TOTAL WEIGHT']), maxGrossLbs: round(v['MAX GROSS WEIGHT']), emptyLbs: round(v['EMPTY WEIGHT']) },
    sim: {
      paused: false, // filled in from system events
      rate: v['SIMULATION RATE'],
      slew: bool(v['IS SLEW ACTIVE']),
      zuluSeconds: Math.round(v['ZULU TIME']),
      localSeconds: Math.round(v['LOCAL TIME']),
      zuluDayOfYear: Math.round(v['ZULU DAY OF YEAR']),
      zuluYear: Math.round(v['ZULU YEAR']),
    },
    gps: {
      hasPlan: bool(v['GPS IS ACTIVE FLIGHT PLAN']),
      isDirectTo: bool(v['GPS IS DIRECTTO FLIGHTPLAN']),
      wpIndex: Math.round(v['GPS FLIGHT PLAN WP INDEX']),
      wpCount: Math.round(v['GPS FLIGHT PLAN WP COUNT']),
      nextId: s['GPS WP NEXT ID'] ?? '',
      nextLat: v['GPS WP NEXT LAT'],
      nextLon: v['GPS WP NEXT LON'],
      prevId: s['GPS WP PREV ID'] ?? '',
      prevLat: v['GPS WP PREV LAT'],
      prevLon: v['GPS WP PREV LON'],
      distNm: round(v['GPS WP DISTANCE'], 1),
      eteSec: Math.round(v['GPS WP ETE']),
      destEteSec: Math.round(v['GPS ETE']),
      bearingMag: round(v['GPS WP BEARING']),
      xtkNm: round(v['GPS WP CROSS TRK'], 2),
    },
  };
}
