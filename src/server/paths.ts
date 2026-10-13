// Where SkyDeck's bundled resources live. In development that is the repository root; in the packaged
// app it is the folder that contains SkyDeck.exe (both use the same relative layout).
import path from 'node:path';

/** True when running as the packaged SkyDeck.exe rather than through node. */
const packaged = !/^node(\.exe)?$/i.test(path.basename(process.execPath));

export const RESOURCE_ROOT = process.env.SKYDECK_ROOT ?? (packaged ? path.dirname(process.execPath) : process.cwd());
export const NAVDATA_DIR = path.join(RESOURCE_ROOT, 'data', 'generated');
export const WEB_DIR = path.join(RESOURCE_ROOT, 'dist', 'web');
