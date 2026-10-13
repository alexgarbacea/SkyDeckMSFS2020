// Types shared between the SkyDeck server and the web UI.

export type ConnectionState = 'searching' | 'connected' | 'demo';

export interface ServerStatus {
  connection: ConnectionState;
  /** Friendly, user-facing description of what is going on. */
  message: string;
  simName?: string;
  /** False when there is no aircraft to show (no sim, main menu, demo off). */
  hasAircraft: boolean;
  /** Addresses other devices on the network can use (only when LAN access is enabled). */
  lanUrls: string[];
  /** SkyDeck Link: the in-sim add-on that edits glass-cockpit flight plans directly. */
  link: { connected: boolean; avionics?: string; version?: string };
  version: string;
}

export interface FrequencyPair {
  active: number;
  standby: number;
}

export interface Telemetry {
  /** Server time the sample was taken (ms). */
  time: number;
  aircraft: { title: string; atcId: string; atcModel: string };
  position: {
    lat: number;
    lon: number;
    altFt: number;
    indicatedAltFt: number;
    aglFt: number;
    onGround: boolean;
  };
  speed: { ias: number; tas: number; gs: number; mach: number; vsFpm: number };
  attitude: { hdgMag: number; hdgTrue: number; trackTrue: number; pitch: number; bank: number; magVar: number };
  environment: { windDir: number; windKt: number; oatC: number; baroInHg: number; seaLevelPressureMb: number };
  autopilot: {
    available: boolean;
    master: boolean;
    flightDirector: boolean;
    yawDamper: boolean;
    autothrottle: boolean;
    hdgMode: boolean;
    navMode: boolean;
    aprMode: boolean;
    bcMode: boolean;
    altMode: boolean;
    vsMode: boolean;
    flcMode: boolean;
    spdMode: boolean;
    levelMode: boolean;
    glideslopeActive: boolean;
    hdg: number;
    alt: number;
    vs: number;
    spd: number;
    /** True when the GPS (rather than NAV1) drives the CDI / autopilot NAV mode. */
    gpsDrivesNav: boolean;
  };
  radios: {
    com1: FrequencyPair;
    com2: FrequencyPair;
    nav1: FrequencyPair & { obs: number; dmeNm: number | null; hasSignal: boolean };
    nav2: FrequencyPair & { obs: number; dmeNm: number | null; hasSignal: boolean };
    adfKhz: number;
    adfStandbyKhz: number;
    /** Transponder code as 4 octal digits, e.g. "7000". */
    xpdrCode: string;
    /** 0 off, 1 standby, 2 test, 3 on, 4 alt. */
    xpdrState: number;
  };
  lights: Record<LightName, boolean>;
  systems: {
    gearRetractable: boolean;
    gearDown: boolean;
    gearPct: number;
    flapsIndex: number;
    flapsPositions: number;
    flapsPct: number;
    spoilersAvailable: boolean;
    spoilersPct: number;
    spoilersArmed: boolean;
    parkingBrake: boolean;
    battery: boolean;
    avionics: boolean;
    pitotHeat: boolean;
    /** 3 = no pushback in progress. */
    pushbackState: number;
    doorPct: number;
  };
  engines: {
    count: number;
    /** 0 piston, 1 jet, 2 none, 3 helo turbine, 4 unsupported, 5 turboprop. */
    type: number;
    list: Array<{ running: boolean; rpm: number; n1: number; fuelFlowGph: number; throttlePct: number }>;
  };
  fuel: {
    totalGal: number;
    capacityGal: number;
    totalLbs: number;
    lbsPerGal: number;
  };
  weight: { totalLbs: number; maxGrossLbs: number; emptyLbs: number };
  sim: {
    paused: boolean;
    rate: number;
    slew: boolean;
    zuluSeconds: number;
    localSeconds: number;
    zuluDayOfYear: number;
    zuluYear: number;
  };
  gps: {
    hasPlan: boolean;
    isDirectTo: boolean;
    wpIndex: number;
    wpCount: number;
    nextId: string;
    nextLat: number;
    nextLon: number;
    prevId: string;
    prevLat: number;
    prevLon: number;
    distNm: number;
    eteSec: number;
    destEteSec: number;
    bearingMag: number;
    xtkNm: number;
  };
}

export const LIGHT_NAMES = ['nav', 'beacon', 'strobe', 'landing', 'taxi', 'logo', 'wing', 'recognition', 'panel', 'cabin'] as const;
export type LightName = (typeof LIGHT_NAMES)[number];

export type RadioName = 'com1' | 'com2' | 'nav1' | 'nav2';

// ---------------------------------------------------------------- Flight plan

export type WaypointType = 'airport' | 'vor' | 'ndb' | 'fix' | 'user';

export interface PlanWaypoint {
  /** Stable id used by the UI for lists / drag and drop. */
  id: string;
  ident: string;
  type: WaypointType;
  lat: number;
  lon: number;
  name?: string;
  region?: string;
  airway?: string;
  /** Planned altitude at this waypoint, feet MSL. */
  altFt?: number | null;
  /** Set on fixes that belong to a SID, STAR or approach (expanded from the simulator's database). */
  procedure?: { kind: 'sid' | 'star' | 'approach'; name: string; runway?: string };
}

export interface PlanProcedures {
  departureRunway?: string;
  sid?: string;
  sidTransition?: string;
  star?: string;
  starTransition?: string;
  approach?: string;
  arrivalRunway?: string;
}

export interface FlightPlan {
  title: string;
  rules: 'IFR' | 'VFR';
  cruiseAltFt: number;
  waypoints: PlanWaypoint[];
  procedures: PlanProcedures;
  /** Where the plan came from, for display ("SimBrief", "MSFS World Map", ...). */
  source: string;
  updatedAt: number;
  /** Set when this exact plan revision was loaded into the sim. */
  sentToSimAt: number | null;
  /**
   * The full route with SID/STAR/approach fixes inserted, when the simulator could provide them.
   * This is what gets loaded into the aircraft and drawn on the map.
   */
  expanded?: PlanWaypoint[] | null;
}

// ---------------------------------------------------------------- Nav data

export interface AirportSummary {
  ident: string;
  name: string;
  city: string;
  country: string;
  lat: number;
  lon: number;
  elevFt: number | null;
  size: 'large' | 'medium' | 'small' | 'seaplane';
  iata?: string;
}

export interface RunwayEnd {
  ident: string;
  lat: number | null;
  lon: number | null;
  headingTrue: number | null;
  elevFt: number | null;
}

export interface Runway {
  ends: [RunwayEnd, RunwayEnd];
  lengthFt: number | null;
  widthFt: number | null;
  surface: string;
  lighted: boolean;
}

export interface AirportFrequency {
  type: string;
  name: string;
  mhz: number;
}

export interface Procedure {
  name: string;
  /** Runways this procedure serves ("ALL" when not runway specific). */
  runways: string[];
  transitions: string[];
}

export interface AirportDetails extends AirportSummary {
  runways: Runway[];
  frequencies: AirportFrequency[];
  /** Procedures come from the simulator's own database, so only when connected. */
  procedures: { departures: Procedure[]; arrivals: Procedure[]; approaches: Procedure[] } | null;
  /** Where frequencies/procedures came from. */
  source: 'offline' | 'sim';
}

export interface NavaidSummary {
  ident: string;
  name: string;
  type: string;
  freqKhz: number | null;
  lat: number;
  lon: number;
  country: string;
}

export type SearchResult =
  | ({ kind: 'airport' } & AirportSummary)
  | ({ kind: 'navaid' } & NavaidSummary)
  | { kind: 'fix'; ident: string; name: string; lat: number; lon: number; region?: string };

// ---------------------------------------------------------------- Settings

export interface Settings {
  setupComplete: boolean;
  /** Folder with UserCfg.opt and MISSIONS, e.g. %APPDATA%\Microsoft Flight Simulator. */
  msfsDataPath: string | null;
  /** Folder with Community / Official packages. */
  msfsPackagesPath: string | null;
  allowLan: boolean;
  port: number;
  openBrowserOnStart: boolean;
  units: { pressure: 'inHg' | 'hPa'; weight: 'lbs' | 'kg' };
  simbriefUser: string;
  /** Saved dock layouts by name. */
  layouts: Record<string, unknown>;
  activeLayout: string;
  mapStyle: string;
}

export interface MsfsInstallCandidate {
  label: string;
  dataPath: string;
  packagesPath: string | null;
  hasFlightPlan: boolean;
}

// ---------------------------------------------------------------- Socket protocol

/** The flight plan as the aircraft's avionics currently hold it (reported by SkyDeck Link). */
export interface AvionicsPlanState {
  ready: boolean;
  origin?: string | null;
  destination?: string | null;
  departure?: string | null;
  arrival?: string | null;
  approach?: string | null;
  activeLeg?: number;
  legs?: Array<{ ident: string; lat: number | null; lon: number | null }>;
}

export type LinkInstallState = 'unavailable' | 'not-installed' | 'installed' | 'outdated';

export interface LinkInstallStatus {
  state: LinkInstallState;
  /** Human readable explanation, e.g. why it is unavailable. */
  message: string;
  communityPath: string | null;
}

export type ServerMessage =
  | { type: 'avionics'; state: AvionicsPlanState | null }
  | { type: 'status'; status: ServerStatus }
  | { type: 'telemetry'; data: Telemetry }
  | { type: 'plan'; plan: FlightPlan | null }
  | { type: 'settings'; settings: Settings }
  | { type: 'result'; id: number; ok: boolean; message?: string }
  | { type: 'notice'; level: 'info' | 'success' | 'warning' | 'error'; message: string };

export type ClientMessage = { type: 'command'; id: number; command: Command };

// ---------------------------------------------------------------- Commands

export type ApToggle = 'master' | 'flightDirector' | 'yawDamper' | 'autothrottle' | 'hdg' | 'nav' | 'apr' | 'bc' | 'alt' | 'vs' | 'flc' | 'spd' | 'level' | 'cdiSource';
export type ApValue = 'hdg' | 'alt' | 'vs' | 'spd';

export type Command =
  | { type: 'ap.toggle'; mode: ApToggle }
  | { type: 'ap.set'; key: ApValue; value: number }
  | { type: 'radio.set'; radio: RadioName; slot: 'active' | 'standby'; mhz: number }
  | { type: 'radio.swap'; radio: RadioName }
  | { type: 'obs.set'; nav: 1 | 2; deg: number }
  | { type: 'adf.set'; khz: number }
  | { type: 'xpdr.set'; code: string }
  | { type: 'xpdr.ident' }
  | { type: 'baro.set'; inHg: number }
  | { type: 'baro.std' }
  | { type: 'light.set'; light: LightName; on: boolean }
  | { type: 'gear.set'; down: boolean }
  | { type: 'flaps.step'; dir: 1 | -1 }
  | { type: 'spoilers.arm' }
  | { type: 'spoilers.toggle' }
  | { type: 'parkingBrake.toggle' }
  | { type: 'battery.toggle' }
  | { type: 'avionics.toggle' }
  | { type: 'pitotHeat.toggle' }
  | { type: 'door.toggle' }
  | { type: 'pushback.toggle' }
  | { type: 'engines.autostart' }
  | { type: 'engines.shutdown' }
  | { type: 'sim.pause'; paused: boolean }
  | { type: 'sim.rate'; rate: number }
  | { type: 'sim.slew'; on: boolean }
  | { type: 'sim.time'; zuluHour: number; zuluMinute: number }
  | { type: 'fuel.set'; pct: number }
  | { type: 'teleport'; lat: number; lon: number; altFt: number; headingTrue: number; kts: number; onGround: boolean }
  | { type: 'demo.start' }
  | { type: 'demo.stop' };
