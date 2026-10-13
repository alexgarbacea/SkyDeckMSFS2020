// SkyDeck entry point: starts the local web server and the simulator connection, then opens the browser.
import { spawn } from 'node:child_process';
import { loadSettings } from './config.js';
import { loadNavData } from './navdata.js';
import { SkyDeckServer, VERSION } from './app.js';
import { log } from './log.js';
import { installLink, linkStatus } from './link/install.js';

const dev = process.argv.includes('--dev');
const noBrowser = process.argv.includes('--no-browser');

function openBrowser(url: string) {
  if (process.platform !== 'win32') return;
  spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
}

async function main() {
  process.title = 'SkyDeck';
  console.log(`\n  SkyDeck ${VERSION} — browser control centre for Microsoft Flight Simulator\n`);
  const settings = await loadSettings();
  try {
    const counts = await loadNavData();
    log.info(`Navigation data loaded (${counts.airports.toLocaleString()} airports, ${counts.navaids.toLocaleString()} navaids).`);
  } catch {
    log.warn('Navigation data is missing, so airport search will not work. Run "npm run navdata" to create it.');
  }

  const server = new SkyDeckServer(dev);
  await server.plans.load();
  const port = await server.listen(dev ? 4500 : settings.port, settings.allowLan);
  server.bridges.start();
  void refreshLink(settings.msfsPackagesPath, settings.port);

  const url = `http://localhost:${port}`;
  console.log('');
  log.info(`SkyDeck is running. Open ${dev ? 'http://localhost:5173 (dev UI)' : url} in your browser.`);
  for (const lan of server.status().lanUrls) log.info(`Other devices on your network can use ${lan}`);
  log.info('Keep this window open while you fly. Close it to stop SkyDeck.\n');
  if (!dev && !noBrowser && settings.openBrowserOnStart) openBrowser(url);
}

/** Keeps an installed SkyDeck Link in step with MSFS / NXi updates. Only touches it if the user installed it. */
async function refreshLink(packagesPath: string | null, port: number) {
  try {
    const status = await linkStatus(packagesPath, port);
    if (status.state === 'outdated' && packagesPath) {
      await installLink(packagesPath, port);
      log.info('SkyDeck Link was refreshed for your current MSFS version. Restart MSFS if it is running.');
    }
  } catch (err) {
    log.warn('Could not refresh SkyDeck Link:', (err as Error).message);
  }
}

main().catch((err) => {
  log.error('SkyDeck could not start:', err instanceof Error ? err.message : err);
  if (!dev) setTimeout(() => process.exit(1), 15000); // leave time to read the message in the console window
  else process.exit(1);
});
