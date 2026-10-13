// Packages SkyDeck as release/SkyDeck/SkyDeck.exe (a Node.js single executable) plus its web UI and data,
// and zips it as release/SkyDeck.zip. Run `npm run package`.
import { cp, mkdir, rm, writeFile, copyFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const OUT = path.resolve('release', 'SkyDeck');
const EXE = path.join(OUT, 'SkyDeck.exe');

await rm('release', { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

await writeFile('dist/sea-config.json', JSON.stringify({ main: 'dist/server.cjs', output: 'dist/sea-prep.blob', disableExperimentalSEAWarning: true }));
execFileSync(process.execPath, ['--experimental-sea-config', 'dist/sea-config.json'], { stdio: 'inherit' });

await copyFile(process.execPath, EXE);
execFileSync(
  process.execPath,
  [path.resolve('node_modules/postject/dist/cli.js'), EXE, 'NODE_SEA_BLOB', 'dist/sea-prep.blob', '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'],
  { stdio: 'inherit' },
);

await cp('dist/web', path.join(OUT, 'dist', 'web'), { recursive: true });
await cp('data/generated', path.join(OUT, 'data', 'generated'), { recursive: true });
await cp('addon', path.join(OUT, 'addon'), { recursive: true });
await copyFile('docs/README.txt', path.join(OUT, 'README.txt'));
await copyFile('LICENSE.md', path.join(OUT, 'LICENSE.md'));

execFileSync('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${OUT}' -DestinationPath '${path.resolve('release', 'SkyDeck.zip')}' -Force`], { stdio: 'inherit' });
console.log(`\nDone: ${EXE}\n      ${path.resolve('release', 'SkyDeck.zip')}`);
