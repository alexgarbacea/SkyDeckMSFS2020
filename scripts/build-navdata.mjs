// Builds compact navigation data from the public-domain OurAirports dataset
// (https://ourairports.com/data/). Output goes to data/generated/.
//
// Usage: node scripts/build-navdata.mjs [--cache <dir>]
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data', 'generated');
const cacheArg = process.argv.indexOf('--cache');
const CACHE = cacheArg > 0 ? path.resolve(process.argv[cacheArg + 1]) : path.join(ROOT, 'data', 'cache');
const BASE_URL = 'https://davidmegginson.github.io/ourairports-data/';
const FILES = ['airports', 'runways', 'navaids', 'airport-frequencies'];

/** Minimal RFC4180 CSV parser returning an array of objects keyed by header. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const [header, ...body] = rows;
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function load(name) {
  const file = path.join(CACHE, `${name}.csv`);
  if (!(await exists(file))) {
    console.log(`Downloading ${name}.csv ...`);
    const res = await fetch(`${BASE_URL}${name}.csv`);
    if (!res.ok) throw new Error(`Download of ${name}.csv failed: HTTP ${res.status}`);
    await mkdir(CACHE, { recursive: true });
    await writeFile(file, Buffer.from(await res.arrayBuffer()));
  }
  return parseCsv(await readFile(file, 'utf8'));
}

const num = (v, digits) => {
  if (v === '' || v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return digits == null ? n : Number(n.toFixed(digits));
};

const AIRPORT_TYPES = { large_airport: 'L', medium_airport: 'M', small_airport: 'S', seaplane_base: 'W' };
const NAVAID_TYPES = new Set(['VOR', 'VOR-DME', 'VORTAC', 'NDB', 'NDB-DME', 'DME', 'TACAN']);

async function main() {
  await mkdir(OUT, { recursive: true });
  const [airportsCsv, runwaysCsv, navaidsCsv, freqsCsv] = await Promise.all(FILES.map(load));

  // Airports: [ident, name, city, country, lat, lon, elevFt, typeCode, iata]
  const airports = [];
  const identByRef = new Map();
  for (const a of airportsCsv) {
    const type = AIRPORT_TYPES[a.type];
    if (!type) continue;
    // MSFS identifies airports by ICAO code where one exists, else by GPS/local code.
    const ident = (a.icao_code || a.gps_code || a.ident).toUpperCase();
    if (!ident) continue;
    identByRef.set(a.id, ident);
    airports.push([
      ident, a.name, a.municipality, a.iso_country,
      num(a.latitude_deg, 5), num(a.longitude_deg, 5), num(a.elevation_ft), type, a.iata_code,
    ]);
  }

  // Runways keyed by airport ident:
  // [leIdent, heIdent, lengthFt, widthFt, surface, leLat, leLon, leHdgT, heLat, heLon, heHdgT, leElev, heElev, lighted]
  const runways = {};
  for (const r of runwaysCsv) {
    if (r.closed === '1') continue;
    const ident = identByRef.get(r.airport_ref);
    if (!ident) continue;
    (runways[ident] ??= []).push([
      r.le_ident, r.he_ident, num(r.length_ft), num(r.width_ft), r.surface,
      num(r.le_latitude_deg, 6), num(r.le_longitude_deg, 6), num(r.le_heading_degT, 1),
      num(r.he_latitude_deg, 6), num(r.he_longitude_deg, 6), num(r.he_heading_degT, 1),
      num(r.le_elevation_ft), num(r.he_elevation_ft), r.lighted === '1' ? 1 : 0,
    ]);
  }

  // Frequencies keyed by airport ident: [type, description, mhz]
  const freqs = {};
  for (const f of freqsCsv) {
    const ident = identByRef.get(f.airport_ref);
    const mhz = num(f.frequency_mhz, 3);
    if (!ident || mhz == null) continue;
    (freqs[ident] ??= []).push([f.type.toUpperCase(), f.description, mhz]);
  }

  // Navaids: [ident, name, type, freqKhz, lat, lon, country]
  const navaids = [];
  for (const n of navaidsCsv) {
    if (!NAVAID_TYPES.has(n.type)) continue;
    navaids.push([n.ident, n.name, n.type, num(n.frequency_khz), num(n.latitude_deg, 5), num(n.longitude_deg, 5), n.iso_country]);
  }

  const meta = { source: 'OurAirports (public domain)', built: new Date().toISOString(), airports: airports.length, navaids: navaids.length };
  await Promise.all([
    writeFile(path.join(OUT, 'airports.json'), JSON.stringify(airports)),
    writeFile(path.join(OUT, 'runways.json'), JSON.stringify(runways)),
    writeFile(path.join(OUT, 'frequencies.json'), JSON.stringify(freqs)),
    writeFile(path.join(OUT, 'navaids.json'), JSON.stringify(navaids)),
    writeFile(path.join(OUT, 'meta.json'), JSON.stringify(meta, null, 2)),
  ]);
  console.log(`Nav data ready: ${airports.length} airports, ${navaids.length} navaids -> ${path.relative(ROOT, OUT)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
