// Finding the user's Microsoft Flight Simulator installation and the files SkyDeck reads from it.
import { access, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { MsfsInstallCandidate } from '../shared/types.js';

const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');

const KNOWN_LOCATIONS: Array<{ label: string; dataPath: string }> = [
  { label: 'MSFS 2020 - Steam', dataPath: path.join(appData, 'Microsoft Flight Simulator') },
  { label: 'MSFS 2020 - Microsoft Store / Xbox app', dataPath: path.join(localAppData, 'Packages', 'Microsoft.FlightSimulator_8wekyb3d8bbwe', 'LocalCache') },
];

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** The "World Map" flight plan MSFS writes for the current/last flight. */
export function customFlightPlanPath(dataPath: string): string {
  return path.join(dataPath, 'MISSIONS', 'Custom', 'CustomFlight', 'CUSTOMFLIGHT.PLN');
}

/** Reads InstalledPackagesPath from UserCfg.opt. */
export async function readPackagesPath(dataPath: string): Promise<string | null> {
  try {
    const cfg = await readFile(path.join(dataPath, 'UserCfg.opt'), 'utf8');
    const m = /InstalledPackagesPath\s+"([^"]+)"/i.exec(cfg);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export async function inspectInstall(dataPath: string, label = 'Custom location'): Promise<MsfsInstallCandidate | null> {
  if (!(await exists(path.join(dataPath, 'UserCfg.opt'))) && !(await exists(path.join(dataPath, 'MISSIONS')))) return null;
  return {
    label,
    dataPath,
    packagesPath: await readPackagesPath(dataPath),
    hasFlightPlan: await exists(customFlightPlanPath(dataPath)),
  };
}

export async function detectInstalls(): Promise<MsfsInstallCandidate[]> {
  const found = await Promise.all(KNOWN_LOCATIONS.map((l) => inspectInstall(l.dataPath, l.label)));
  return found.filter((c): c is MsfsInstallCandidate => c != null);
}

export interface FolderListing {
  path: string;
  parent: string | null;
  folders: string[];
  /** True if this folder looks like an MSFS data folder. */
  isMsfs: boolean;
}

/** Lists sub-folders for the in-app folder picker. With no path, lists drive roots. */
export async function listFolders(dir: string | null): Promise<FolderListing> {
  if (!dir) {
    const drives: string[] = [];
    for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
      if (await exists(`${letter}:\\`)) drives.push(`${letter}:\\`);
    }
    return { path: '', parent: null, folders: drives, isMsfs: false };
  }
  const resolved = path.resolve(dir);
  const entries = await readdir(resolved, { withFileTypes: true });
  const folders = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('$'))
    .map((e) => path.join(resolved, e.name))
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  const parent = path.dirname(resolved);
  return {
    path: resolved,
    parent: parent === resolved ? '' : parent,
    folders,
    isMsfs: (await inspectInstall(resolved)) != null,
  };
}

export async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}
