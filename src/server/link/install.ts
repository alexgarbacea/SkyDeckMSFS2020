// Installs / removes the SkyDeck Link Community package.
//
// The package overrides one file of the G1000 NXi: its MFD page, generated from the user's own installed copy with
// a single extra <script> line that loads skydeck-link.js. Nothing else of the NXi is touched, and deleting the
// package folder restores the original.
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { LinkInstallStatus } from '../../shared/types.js';
import { RESOURCE_ROOT } from '../paths.js';

export const LINK_VERSION = '1.0.0';
const PACKAGE_NAME = 'skydeck-link';
const MARKER = 'skydeck-link.json';
const MFD_HTML = 'html_ui/Pages/VCockpit/Instruments/NavSystems/WTG1000/MFD/WTG1000_MFD.html';
const LINK_JS = 'html_ui/SkyDeckLink/skydeck-link.js';
const SCRIPT_TAG = '<script type="text/html" import-script="/SkyDeckLink/skydeck-link.js"></script>';

async function exists(p: string) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Where the G1000 NXi package lives (Steam or Microsoft Store layout). */
export async function findNxiPackage(packagesPath: string): Promise<string | null> {
  for (const store of ['Steam', 'OneStore']) {
    const dir = path.join(packagesPath, 'Official', store, 'workingtitle-instruments-g1000');
    if (await exists(path.join(dir, MFD_HTML))) return dir;
  }
  return null;
}

/** Adds the SkyDeck Link script after the MFD's own scripts. */
export function injectScript(html: string): string {
  if (html.includes(SCRIPT_TAG)) return html;
  const mfdScript = /(<script[^>]*import-script="[^"]*\/MFD\/MFD\.js"[^>]*><\/script>)/;
  return mfdScript.test(html) ? html.replace(mfdScript, `$1\n${SCRIPT_TAG}`) : `${html.trimEnd()}\n${SCRIPT_TAG}\n`;
}

/** Windows FILETIME (100 ns ticks since 1601), the date format MSFS layout.json files use. */
function fileTime(date: Date): number {
  return (date.getTime() + 11644473600000) * 10000;
}

interface GeneratedFiles {
  files: Record<string, string>;
  fingerprint: string;
}

async function generate(packagesPath: string, port: number): Promise<GeneratedFiles> {
  const nxi = await findNxiPackage(packagesPath);
  if (!nxi) throw new Error('The G1000 NXi was not found in your MSFS installation.');
  const html = await readFile(path.join(nxi, MFD_HTML), 'utf8');
  const script = (await readFile(path.join(RESOURCE_ROOT, 'addon', 'skydeck-link', 'skydeck-link.js'), 'utf8'))
    .replaceAll('__SKYDECK_PORT__', String(port))
    .replaceAll('__SKYDECK_LINK_VERSION__', LINK_VERSION);
  const files: Record<string, string> = { [MFD_HTML]: injectScript(html), [LINK_JS]: script };
  const fingerprint = createHash('sha1').update(files[MFD_HTML]).update(files[LINK_JS]).digest('hex');
  return { files, fingerprint };
}

function communityDir(packagesPath: string) {
  return path.join(packagesPath, 'Community');
}

export async function linkStatus(packagesPath: string | null, port: number): Promise<LinkInstallStatus> {
  if (!packagesPath) {
    return { state: 'unavailable', message: 'Set the simulator folder in Settings first.', communityPath: null };
  }
  const community = communityDir(packagesPath);
  if (!(await exists(community))) {
    return { state: 'unavailable', message: `No Community folder found at ${community}.`, communityPath: null };
  }
  if (!(await findNxiPackage(packagesPath))) {
    return { state: 'unavailable', message: 'The G1000 NXi was not found in your MSFS installation.', communityPath: community };
  }
  const markerPath = path.join(community, PACKAGE_NAME, MARKER);
  if (!(await exists(markerPath))) return { state: 'not-installed', message: 'Not installed.', communityPath: community };
  try {
    const marker = JSON.parse(await readFile(markerPath, 'utf8')) as { fingerprint: string };
    const { fingerprint } = await generate(packagesPath, port);
    return marker.fingerprint === fingerprint
      ? { state: 'installed', message: 'Installed.', communityPath: community }
      : { state: 'outdated', message: 'Installed, but an update is available (MSFS or SkyDeck changed).', communityPath: community };
  } catch {
    return { state: 'outdated', message: 'Installed, but it needs to be refreshed.', communityPath: community };
  }
}

export async function installLink(packagesPath: string, port: number): Promise<void> {
  const community = communityDir(packagesPath);
  if (!(await exists(community))) throw new Error(`No Community folder found at ${community}.`);
  const target = path.join(community, PACKAGE_NAME);
  if ((await exists(target)) && !(await exists(path.join(target, MARKER)))) {
    throw new Error(`${target} already exists and was not created by SkyDeck. Remove it first.`);
  }
  const { files, fingerprint } = await generate(packagesPath, port);
  await rm(target, { recursive: true, force: true });
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(target, rel);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content, 'utf8');
  }
  // layout.json lists every file MSFS should mount from the package.
  const content = [];
  let total = 0;
  for (const rel of Object.keys(files)) {
    const s = await stat(path.join(target, rel));
    total += s.size;
    content.push({ path: rel, size: s.size, date: fileTime(s.mtime) });
  }
  const layout = JSON.stringify({ content }, null, 2);
  const manifest = {
    dependencies: [],
    content_type: 'INSTRUMENTS',
    title: 'SkyDeck Link (G1000 NXi)',
    manufacturer: '',
    creator: 'SkyDeck',
    package_version: LINK_VERSION,
    minimum_game_version: '1.39.0',
    release_notes: { neutral: { LastUpdate: '', OlderHistory: '' } },
    total_package_size: String(total + Buffer.byteLength(layout)).padStart(20, '0'),
  };
  await writeFile(path.join(target, 'layout.json'), layout, 'utf8');
  await writeFile(path.join(target, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  await writeFile(path.join(target, MARKER), JSON.stringify({ version: LINK_VERSION, fingerprint, installedAt: new Date().toISOString() }, null, 2), 'utf8');
}

export async function uninstallLink(packagesPath: string): Promise<void> {
  const target = path.join(communityDir(packagesPath), PACKAGE_NAME);
  if (!(await exists(target))) return;
  if (!(await exists(path.join(target, MARKER)))) throw new Error(`${target} was not created by SkyDeck, so SkyDeck will not delete it.`);
  await rm(target, { recursive: true, force: true });
}
