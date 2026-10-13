// Logging to the console window (user-facing) and to %APPDATA%\SkyDeck\skydeck.log (for troubleshooting).
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const LOG_DIR = path.join(process.env.APPDATA ?? path.join(os.homedir(), '.config'), 'SkyDeck');
export const LOG_FILE = path.join(LOG_DIR, 'skydeck.log');
const stamp = () => new Date().toLocaleTimeString();

function toFile(level: string, args: unknown[]) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    try {
      if (statSync(LOG_FILE).size > 2_000_000) renameSync(LOG_FILE, `${LOG_FILE}.old`);
    } catch {
      /* no log yet */
    }
    const text = args.map((a) => (a instanceof Error ? a.stack ?? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${level} ${text}\n`);
  } catch {
    /* logging must never break the app */
  }
}

export const log = {
  info: (...args: unknown[]) => (console.log(`[${stamp()}]`, ...args), toFile('INFO', args)),
  warn: (...args: unknown[]) => (console.warn(`[${stamp()}] ⚠`, ...args), toFile('WARN', args)),
  error: (...args: unknown[]) => (console.error(`[${stamp()}] ✖`, ...args), toFile('ERROR', args)),
  /** File only, for detail the console window does not need. */
  debug: (...args: unknown[]) => toFile('DEBUG', args),
};
