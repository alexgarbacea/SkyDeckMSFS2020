// Parses what the user types in the command bar ("hdg 270", "com1 121.5", "direct LGAV") into actions.
// Pure and UI-free so it can be unit tested.
import type { Command, LightName, RadioName } from '../../shared/types';
import { parseAltitude, parseFrequency } from './format';

export type ParsedAction =
  | { kind: 'command'; command: Command; label: string }
  | { kind: 'apMode'; mode: 'master' | 'hdg' | 'nav' | 'apr' | 'alt' | 'vs' | 'flc' | 'flightDirector' | 'yawDamper'; on?: boolean; label: string }
  | { kind: 'lights'; lights: LightName[]; on: boolean; label: string }
  | { kind: 'localTime'; hour: number; minute: number; label: string }
  | { kind: 'direct'; ident: string; label: string }
  | { kind: 'reposition'; ident: string; runway?: string; finalNm: number; label: string }
  | { kind: 'route'; route: string; label: string }
  | { kind: 'sendPlan'; label: string }
  | { kind: 'simbrief'; label: string }
  | { kind: 'panel'; id: string; label: string };

export interface ParseResult {
  action: ParsedAction | null;
  /** Shown while typing when the input is recognised but incomplete or invalid. */
  hint?: string;
}

const LIGHTS: Record<string, LightName[]> = {
  lights: ['nav', 'beacon', 'strobe', 'landing', 'taxi', 'logo'],
  nav: ['nav'],
  beacon: ['beacon'],
  strobe: ['strobe'],
  strobes: ['strobe'],
  landing: ['landing'],
  taxi: ['taxi'],
  logo: ['logo'],
  wing: ['wing'],
  panel: ['panel'],
  cabin: ['cabin'],
  recognition: ['recognition'],
};

const PANEL_WORDS: Record<string, string> = {
  map: 'map',
  plan: 'plan',
  'flight plan': 'plan',
  autopilot: 'autopilot',
  radios: 'radios',
  radio: 'radios',
  'flight data': 'flight',
  instruments: 'flight',
  aircraft: 'aircraft',
  simulator: 'sim',
  sim: 'sim',
  atc: 'atc',
  'air traffic control': 'atc',
  ground: 'ground',
  stands: 'ground',
};

const RADIO_ALIASES: Record<string, RadioName> = { com1: 'com1', c1: 'com1', com: 'com1', com2: 'com2', c2: 'com2', nav1: 'nav1', n1: 'nav1', nav2: 'nav2', n2: 'nav2' };

const onOff = (w: string | undefined): boolean | undefined => (w === 'on' ? true : w === 'off' ? false : undefined);

export function parseCommand(input: string): ParseResult {
  const text = input.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!text) return { action: null };
  const [word, ...rest] = text.split(' ');
  const arg = rest.join(' ');
  const num = Number(arg.replace(/[+,]/g, ''));

  // --- Autopilot targets
  if (['hdg', 'heading', 'h'].includes(word)) {
    if (!arg) return { action: { kind: 'apMode', mode: 'hdg', label: 'Toggle heading mode' } };
    if (!Number.isFinite(num) || num < 0 || num > 360) return { action: null, hint: 'Heading is 0 to 360, e.g. "hdg 270"' };
    const v = Math.round(num) % 360;
    return { action: { kind: 'command', command: { type: 'ap.set', key: 'hdg', value: v }, label: `Set heading bug to ${String(v || 360).padStart(3, '0')}°` } };
  }
  if (['alt', 'altitude', 'a'].includes(word)) {
    if (!arg) return { action: { kind: 'apMode', mode: 'alt', label: 'Toggle altitude hold' } };
    const v = parseAltitude(arg);
    if (v == null || v < 0 || v > 60000) return { action: null, hint: 'e.g. "alt 8000" or "alt FL120"' };
    return { action: { kind: 'command', command: { type: 'ap.set', key: 'alt', value: v }, label: `Set altitude to ${v.toLocaleString('en-US')} ft` } };
  }
  if (['vs', 'v/s'].includes(word)) {
    if (!arg) return { action: { kind: 'apMode', mode: 'vs', label: 'Toggle vertical speed mode' } };
    if (!Number.isFinite(num) || Math.abs(num) > 6000) return { action: null, hint: 'e.g. "vs 700" or "vs -500"' };
    const v = Math.round(num / 50) * 50;
    return { action: { kind: 'command', command: { type: 'ap.set', key: 'vs', value: v }, label: `Set vertical speed to ${v > 0 ? '+' : ''}${v} fpm` } };
  }
  if (['spd', 'speed', 'ias'].includes(word)) {
    if (!Number.isFinite(num) || num <= 0 || num > 999 || !arg) return { action: null, hint: 'e.g. "spd 120"' };
    return { action: { kind: 'command', command: { type: 'ap.set', key: 'spd', value: Math.round(num) }, label: `Set speed to ${Math.round(num)} kt` } };
  }
  if (word === 'ap' || word === 'autopilot') {
    if (!arg) return { action: { kind: 'panel', id: 'autopilot', label: 'Show the autopilot panel' } };
    const on = onOff(arg);
    if (on === undefined) return { action: null, hint: '"ap on" or "ap off"' };
    return { action: { kind: 'apMode', mode: 'master', on, label: `Autopilot ${on ? 'on' : 'off'}` } };
  }
  if (word === 'fd') return { action: { kind: 'apMode', mode: 'flightDirector', on: onOff(arg), label: 'Flight director' + (arg ? ` ${arg}` : '') } };
  if (word === 'yd') return { action: { kind: 'apMode', mode: 'yawDamper', on: onOff(arg), label: 'Yaw damper' + (arg ? ` ${arg}` : '') } };
  if (word === 'nav' && !arg) return { action: { kind: 'apMode', mode: 'nav', label: 'Toggle NAV mode' } };
  if (word === 'apr' || word === 'app' || word === 'approach') return { action: { kind: 'apMode', mode: 'apr', label: 'Toggle approach mode' } };
  if (word === 'flc') return { action: { kind: 'apMode', mode: 'flc', label: 'Toggle flight level change' } };

  // --- Radios
  const radio = RADIO_ALIASES[word] ?? RADIO_ALIASES[word.replace(/s$/, '')];
  if (radio) {
    const standby = /s$/.test(word) && !RADIO_ALIASES[word] ? true : /^(sb|stby|standby) /.test(arg);
    const freqText = arg.replace(/^(sb|stby|standby) /, '');
    if (freqText === 'swap' || freqText === 'flip') {
      return { action: { kind: 'command', command: { type: 'radio.swap', radio }, label: `Swap ${radio.toUpperCase()} frequencies` } };
    }
    const mhz = parseFrequency(radio, freqText);
    if (mhz == null) return { action: null, hint: radio.startsWith('com') ? 'e.g. "com1 121.5", "com1 stby 118.3" or "com1 swap"' : 'e.g. "nav1 110.3"' };
    const slot = standby ? 'standby' : 'active';
    return {
      action: { kind: 'command', command: { type: 'radio.set', radio, slot, mhz }, label: `Set ${radio.toUpperCase()} ${slot} to ${mhz.toFixed(radio.startsWith('com') ? 3 : 2)}` },
    };
  }
  if (['obs', 'obs1', 'crs', 'crs1', 'obs2', 'crs2'].includes(word)) {
    if (!Number.isFinite(num) || num < 0 || num > 360 || !arg) return { action: null, hint: 'e.g. "obs 270"' };
    const nav = word.endsWith('2') ? 2 : 1;
    return { action: { kind: 'command', command: { type: 'obs.set', nav, deg: Math.round(num) }, label: `Set NAV ${nav} course to ${Math.round(num)}°` } };
  }
  if (word === 'adf') {
    if (!Number.isFinite(num) || num < 190 || num > 1799) return { action: null, hint: 'e.g. "adf 350"' };
    return { action: { kind: 'command', command: { type: 'adf.set', khz: num }, label: `Set ADF to ${num} kHz` } };
  }
  if (['sq', 'squawk', 'xpdr', 'transponder', 'sqk'].includes(word)) {
    if (!/^[0-7]{4}$/.test(arg)) return { action: null, hint: 'Four digits from 0 to 7, e.g. "squawk 7000"' };
    return { action: { kind: 'command', command: { type: 'xpdr.set', code: arg }, label: `Squawk ${arg}` } };
  }
  if (word === 'ident') return { action: { kind: 'command', command: { type: 'xpdr.ident' }, label: 'Transponder ident' } };
  if (['baro', 'qnh', 'altimeter'].includes(word)) {
    if (arg === 'std') return { action: { kind: 'command', command: { type: 'baro.std' }, label: 'Altimeter to standard' } };
    if (!Number.isFinite(num) || !arg) return { action: null, hint: 'e.g. "baro 29.92", "qnh 1013" or "baro std"' };
    const inHg = num > 800 ? num / 33.8639 : num;
    if (inHg < 26 || inHg > 33) return { action: null, hint: 'That is not a realistic altimeter setting' };
    return { action: { kind: 'command', command: { type: 'baro.set', inHg }, label: num > 800 ? `Set altimeter to ${Math.round(num)} hPa` : `Set altimeter to ${num.toFixed(2)} inHg` } };
  }
  if (word === 'std') return { action: { kind: 'command', command: { type: 'baro.std' }, label: 'Altimeter to standard' } };

  // --- Aircraft
  if (word === 'gear') {
    if (arg !== 'up' && arg !== 'down') return { action: null, hint: '"gear up" or "gear down"' };
    return { action: { kind: 'command', command: { type: 'gear.set', down: arg === 'down' }, label: `Gear ${arg}` } };
  }
  if (word === 'flaps') {
    if (['up', '-', 'retract'].includes(arg)) return { action: { kind: 'command', command: { type: 'flaps.step', dir: -1 }, label: 'Flaps up one step' } };
    if (['down', '+', 'extend'].includes(arg)) return { action: { kind: 'command', command: { type: 'flaps.step', dir: 1 }, label: 'Flaps down one step' } };
    return { action: null, hint: '"flaps down" or "flaps up" (one step at a time)' };
  }
  if (LIGHTS[word]) {
    const on = onOff(rest[rest.length - 1]) ?? onOff(arg);
    if (on === undefined) return { action: null, hint: `"${word} on" or "${word} off"` };
    return { action: { kind: 'lights', lights: LIGHTS[word], on, label: `${word === 'lights' ? 'Exterior lights' : `${word[0].toUpperCase()}${word.slice(1)} light`} ${on ? 'on' : 'off'}` } };
  }
  if (word === 'brake' || word === 'brakes' || text === 'parking brake') {
    return { action: { kind: 'command', command: { type: 'parkingBrake.toggle' }, label: 'Toggle parking brake' } };
  }
  if (word === 'autostart' || text === 'start engines' || text === 'engines start') {
    return { action: { kind: 'command', command: { type: 'engines.autostart' }, label: 'Auto-start the engines' } };
  }
  if (text === 'shutdown' || text === 'engines off' || text === 'stop engines') {
    return { action: { kind: 'command', command: { type: 'engines.shutdown' }, label: 'Shut the engines down' } };
  }
  if (word === 'fuel') {
    const pct = Number(arg.replace('%', ''));
    if (!arg || !Number.isFinite(pct) || pct < 0 || pct > 100) return { action: null, hint: 'e.g. "fuel 50%"' };
    return { action: { kind: 'command', command: { type: 'fuel.set', pct }, label: `Set fuel to ${pct}%` } };
  }
  if (word === 'pushback' || word === 'push') return { action: { kind: 'command', command: { type: 'pushback.toggle' }, label: 'Start or stop pushback' } };

  // --- Simulator
  if (word === 'pause') return { action: { kind: 'command', command: { type: 'sim.pause', paused: true }, label: 'Pause the simulator' } };
  if (['resume', 'unpause', 'play'].includes(word)) return { action: { kind: 'command', command: { type: 'sim.pause', paused: false }, label: 'Resume the simulator' } };
  if (word === 'rate' || word === 'simrate') {
    const r = Number(arg.replace(/x$/, ''));
    if (![0.25, 0.5, 1, 2, 4, 8, 16].includes(r)) return { action: null, hint: 'One of 0.25, 0.5, 1, 2, 4, 8, 16' };
    return { action: { kind: 'command', command: { type: 'sim.rate', rate: r }, label: `Simulation rate ${r}×` } };
  }
  if (word === 'slew') {
    const on = onOff(arg);
    if (on === undefined) return { action: null, hint: '"slew on" or "slew off"' };
    return { action: { kind: 'command', command: { type: 'sim.slew', on }, label: `Slew mode ${on ? 'on' : 'off'}` } };
  }
  if (word === 'time') {
    const m = /^(\d{1,2})[:.h]?(\d{2})?$/.exec(arg);
    if (!m || Number(m[1]) > 23 || Number(m[2] ?? 0) > 59) return { action: null, hint: 'Local time, e.g. "time 14:30"' };
    const hour = Number(m[1]);
    const minute = Number(m[2] ?? 0);
    return { action: { kind: 'localTime', hour, minute, label: `Set local time to ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}` } };
  }
  if (word === 'demo') return { action: { kind: 'command', command: { type: arg === 'off' || arg === 'stop' ? 'demo.stop' : 'demo.start' }, label: arg === 'off' || arg === 'stop' ? 'Stop the demo aircraft' : 'Start the demo aircraft' } };

  // --- Navigation
  if (['direct', 'dct', 'd', 'dto'].includes(word)) {
    if (!/^[a-z0-9]{2,5}$/.test(arg)) return { action: null, hint: 'e.g. "direct LGAV" or "direct SIT"' };
    return { action: { kind: 'direct', ident: arg.toUpperCase(), label: `Fly direct to ${arg.toUpperCase()}` } };
  }
  if (['goto', 'move', 'teleport', 'final'].includes(word)) {
    const m = /^([a-z0-9]{3,4})(?:\s+(?:rwy\s*)?(\d{1,2}[lrc]?))?(?:\s+(\d{1,2})\s*nm)?$/.exec(arg);
    if (!m) return { action: null, hint: word === 'final' ? 'e.g. "final LGIR 27" or "final LGIR 27 10nm"' : 'e.g. "goto LGIR" or "goto LGIR 27"' };
    const finalNm = word === 'final' ? Number(m[3] ?? 5) : 0;
    const ident = m[1].toUpperCase();
    const runway = m[2]?.toUpperCase().padStart(m[2].match(/[lrc]$/) ? 3 : 2, '0');
    return {
      action: { kind: 'reposition', ident, runway, finalNm, label: finalNm ? `Move aircraft to a ${finalNm} nm final${runway ? ` for runway ${runway}` : ''} at ${ident}` : `Move aircraft to ${ident}${runway ? ` runway ${runway}` : ''}` },
    };
  }
  if (word === 'route' || word === 'plan') {
    if (rest.length < 2) return word === 'plan' && !arg ? { action: { kind: 'panel', id: 'plan', label: 'Show the flight plan' } } : { action: null, hint: 'e.g. "route LGIR SIT LGAV"' };
    return { action: { kind: 'route', route: arg.toUpperCase(), label: `Create flight plan ${arg.toUpperCase()}` } };
  }
  if (text === 'send' || text === 'send plan') return { action: { kind: 'sendPlan', label: 'Send the flight plan to MSFS' } };
  if (word === 'simbrief') return { action: { kind: 'simbrief', label: 'Import the latest SimBrief flight plan' } };

  const panel = PANEL_WORDS[text] ?? PANEL_WORDS[arg && word === 'show' ? arg : ''];
  if (panel) return { action: { kind: 'panel', id: panel, label: `Show the ${text.replace(/^show /, '')} panel` } };

  return { action: null };
}

export const EXAMPLES: Array<{ text: string; does: string }> = [
  { text: 'hdg 270', does: 'Heading bug' },
  { text: 'alt 8000', does: 'Selected altitude (or FL120)' },
  { text: 'vs -500', does: 'Vertical speed' },
  { text: 'ap on', does: 'Autopilot on or off' },
  { text: 'com1 121.5', does: 'Tune a radio (com1 stby 118.3, com1 swap)' },
  { text: 'squawk 7000', does: 'Transponder code' },
  { text: 'baro 1013', does: 'Altimeter (std for standard)' },
  { text: 'direct LGAV', does: 'Fly direct to a waypoint' },
  { text: 'final LGIR 27', does: 'Move to a 5 nm final (add 10nm for further out)' },
  { text: 'goto LGIR', does: 'Move to an airport runway' },
  { text: 'route LGIR SIT LGAV', does: 'Create a flight plan' },
  { text: 'lights on', does: 'Exterior lights (landing on, strobe off...)' },
  { text: 'pause', does: 'Pause or resume' },
  { text: 'rate 4', does: 'Simulation rate' },
  { text: 'time 18:30', does: 'Local time of day' },
  { text: 'fuel 50%', does: 'Fuel load' },
];
