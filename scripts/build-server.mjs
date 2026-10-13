// Bundles the server into a single CommonJS file (dist/server.cjs), ready for Node's single-executable packaging.
import { build } from 'esbuild';
import { access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

try {
  await access('data/generated/airports.json');
} catch {
  console.log('Navigation data missing, building it first...');
  execFileSync(process.execPath, ['scripts/build-navdata.mjs'], { stdio: 'inherit' });
}

await build({
  entryPoints: ['src/server/main.ts'],
  outfile: 'dist/server.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  minify: false,
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
});
