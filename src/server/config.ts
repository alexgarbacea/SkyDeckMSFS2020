// User settings, stored in %APPDATA%\SkyDeck so they survive updates of the app itself.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { Settings } from '../shared/types.js';

export const APP_DIR = path.join(process.env.APPDATA ?? path.join(os.homedir(), '.config'), 'SkyDeck');
export const PLANS_DIR = path.join(APP_DIR, 'flightplans');
const SETTINGS_FILE = path.join(APP_DIR, 'settings.json');

export const DEFAULT_SETTINGS: Settings = {
  setupComplete: false,
  msfsDataPath: null,
  msfsPackagesPath: null,
  allowLan: false,
  port: 4500,
  openBrowserOnStart: true,
  units: { pressure: 'inHg', weight: 'lbs' },
  simbriefUser: '',
  layouts: {},
  activeLayout: 'Cruise',
  mapStyle: 'dark',
};

let current: Settings = structuredClone(DEFAULT_SETTINGS);

export async function loadSettings(): Promise<Settings> {
  try {
    const raw = JSON.parse(await readFile(SETTINGS_FILE, 'utf8')) as Partial<Settings>;
    current = { ...structuredClone(DEFAULT_SETTINGS), ...raw, units: { ...DEFAULT_SETTINGS.units, ...raw.units } };
  } catch {
    current = structuredClone(DEFAULT_SETTINGS);
  }
  return current;
}

export function getSettings(): Settings {
  return current;
}

const ALLOWED_KEYS = new Set<keyof Settings>(Object.keys(DEFAULT_SETTINGS) as Array<keyof Settings>);

/** Merges a partial update, ignoring unknown keys, and writes the file atomically. */
export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (!ALLOWED_KEYS.has(key as keyof Settings) || value === undefined) continue;
    (next as Record<string, unknown>)[key] = value;
  }
  if (patch.units) next.units = { ...current.units, ...patch.units };
  if (!Number.isInteger(next.port) || next.port < 1024 || next.port > 65535) next.port = current.port;
  current = next;
  await mkdir(APP_DIR, { recursive: true });
  const tmp = `${SETTINGS_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(current, null, 2));
  await rename(tmp, SETTINGS_FILE);
  return current;
}
