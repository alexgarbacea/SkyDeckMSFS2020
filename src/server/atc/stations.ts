// Which controllers an airport has (from its published frequencies), and how ATC phrases numbers.
import type { AirportDetails, AtcRole, AtcStation, RunwayEnd } from '../../shared/types.js';
import { normalizeDeg } from '../../shared/geo.js';

const ROLE_PATTERNS: Array<[Exclude<AtcRole, 'center'>, RegExp]> = [
  ['atis', /^(D-?ATIS|ATIS|AWOS|ASOS)\b/],
  ['delivery', /^(CLD|CLR|CLNC|DEL|CD|CLEARANCE|DELIVERY|PRE ?TAXI)\b/],
  ['ground', /^(GND|GRD|GROUND|APRON|RAMP)\b/],
  ['tower', /^(TWR|TOWER)\b/],
  ['departure', /^(DEP|DEPARTURE|APP\/DEP|A\/D)\b/],
  ['approach', /^(APP|ARR|APPROACH|ARRIVAL|APP\/DEP|A\/D|RADAR|DIRECTOR)\b/],
  ['unicom', /^(CTAF|UNIC|UNICOM|MULTICOM|AFIS|A\/G|RDO|INFO|ADVISORY)\b/],
];

const SUFFIX: Record<Exclude<AtcRole, 'center'>, string> = {
  atis: 'Information',
  delivery: 'Delivery',
  ground: 'Ground',
  tower: 'Tower',
  departure: 'Departure',
  approach: 'Approach',
  unicom: 'Traffic',
};

/** Short spoken name for an airport, e.g. "Heraklion" rather than "Heraklion International Nikos Kazantzakis Airport". */
export function airportLabel(a: Pick<AirportDetails, 'ident' | 'name' | 'city'>): string {
  const city = a.city?.split(/[,(/]/)[0].trim();
  if (city) return city;
  const name = a.name.replace(/\b(International|Intl|Regional|Municipal|Airport|Airfield|Aerodrome|Field)\b/gi, '').replace(/\s+/g, ' ').trim();
  return name || a.ident;
}

export type AirportStations = Partial<Record<Exclude<AtcRole, 'center'>, AtcStation>>;

/** The controllers an airport publishes a frequency for. */
export function airportStations(a: AirportDetails): AirportStations {
  const out: AirportStations = {};
  const label = airportLabel(a);
  for (const f of a.frequencies) {
    if (!(f.mhz >= 118 && f.mhz < 137)) continue;
    for (const field of [f.type, f.name]) {
      const text = (field ?? '').toUpperCase().trim();
      for (const [role, re] of ROLE_PATTERNS) {
        if (out[role] || !re.test(text)) continue;
        out[role] = { role, name: `${label} ${SUFFIX[role]}`, mhz: f.mhz, airport: a.ident };
      }
    }
  }
  return out;
}

export function unicomStation(a: AirportDetails, stations: AirportStations): AtcStation {
  return stations.unicom ?? { role: 'unicom', name: `${airportLabel(a)} Traffic`, mhz: 122.8, airport: a.ident };
}

const CENTER_FREQS = [118.925, 120.775, 123.875, 124.35, 125.075, 126.525, 127.725, 128.25, 129.35, 131.075, 132.6, 133.525, 134.125, 135.475];

/** Area controller for a 3° grid square: named after the biggest city nearby, with a stable made-up frequency. */
export function centerStation(sector: string, city: string | null, usStyle: boolean): AtcStation {
  let h = 0;
  for (const ch of sector) h = (h * 33 + ch.charCodeAt(0)) >>> 0;
  return { role: 'center', name: `${city ?? 'Area'} ${usStyle ? 'Center' : 'Control'}`, mhz: CENTER_FREQS[h % CENTER_FREQS.length], airport: undefined };
}

export const sectorOf = (lat: number, lon: number) => `${Math.floor(lat / 3)}:${Math.floor(lon / 3)}`;
export const sectorCentre = (sector: string) => {
  const [a, b] = sector.split(':').map(Number);
  return { lat: a * 3 + 1.5, lon: b * 3 + 1.5 };
};

// ---------------------------------------------------------------- Phrasing

/** US, Canada and the Pacific use inches of mercury and an 18,000 ft transition altitude. */
export const isUsStyle = (ident: string | null | undefined) => /^[KCP]/.test(ident ?? '');

export function fmtAlt(ft: number, usStyle: boolean): string {
  const transition = usStyle ? 18000 : 6000;
  if (ft >= transition) return `FL${String(Math.round(ft / 100)).padStart(3, '0')}`;
  return `${Math.round(ft).toLocaleString('en-US')} ft`;
}

export function fmtMhz(mhz: number): string {
  return mhz.toFixed(3).replace(/0{1,2}$/, '');
}

export const fmtHdg = (deg: number) => String(Math.round(normalizeDeg(deg)) || 360).padStart(3, '0');

export function fmtWind(dirMag: number, kt: number): string {
  if (kt < 3) return 'wind calm';
  return `wind ${fmtHdg(Math.round(dirMag / 10) * 10)} degrees ${Math.round(kt)} knots`;
}

export function fmtPressure(mb: number, usStyle: boolean): string {
  return usStyle ? `altimeter ${((mb / 33.8639) * 100).toFixed(0).padStart(4, '0')}` : `QNH ${Math.round(mb)}`;
}

export const roundUp = (v: number, step: number) => Math.ceil(v / step) * step;

export interface RunwayChoice {
  ident: string;
  end: RunwayEnd;
}

/** Runway in use: the one most into the wind, keeping the preferred one while the tailwind is light. */
export function chooseRunway(a: AirportDetails, windFromTrue: number, windKt: number, preferred?: string | null): RunwayChoice | null {
  const ends: Array<RunwayChoice & { length: number }> = [];
  for (const r of a.runways) {
    for (const end of r.ends) {
      if (end.ident && end.headingTrue != null && end.lat != null) ends.push({ ident: end.ident, end, length: r.lengthFt ?? 0 });
    }
  }
  if (!ends.length) return null;
  const headwind = (e: RunwayChoice) => Math.cos(((e.end.headingTrue! - windFromTrue) * Math.PI) / 180) * windKt;
  const pref = preferred ? ends.find((e) => e.ident.toUpperCase() === preferred.toUpperCase()) : undefined;
  if (pref && headwind(pref) > -5) return pref;
  if (windKt < 3) return pref ?? [...ends].sort((x, y) => y.length - x.length)[0];
  return [...ends].sort((x, y) => headwind(y) - headwind(x) || y.length - x.length)[0];
}
