// Translates SkyDeck commands into MSFS key events. Kept free of SimConnect so it can be unit tested.
import type { ApToggle, Command, LightName, RadioName, Telemetry } from '../../shared/types.js';
import { CommandError } from './types.js';

export type SimEvent = { name: string; value?: number };

const AP_TOGGLES: Record<ApToggle, string> = {
  master: 'AP_MASTER',
  flightDirector: 'TOGGLE_FLIGHT_DIRECTOR',
  yawDamper: 'YAW_DAMPER_TOGGLE',
  autothrottle: 'AUTO_THROTTLE_ARM',
  hdg: 'AP_PANEL_HEADING_HOLD',
  nav: 'AP_NAV1_HOLD',
  apr: 'AP_APR_HOLD',
  bc: 'AP_BC_HOLD',
  alt: 'AP_PANEL_ALTITUDE_HOLD',
  vs: 'AP_PANEL_VS_HOLD',
  flc: 'FLIGHT_LEVEL_CHANGE',
  spd: 'AP_PANEL_SPEED_HOLD',
  level: 'AP_WING_LEVELER',
  cdiSource: 'TOGGLE_GPS_DRIVES_NAV1',
};

const LIGHT_TOGGLES: Record<LightName, string> = {
  nav: 'TOGGLE_NAV_LIGHTS',
  beacon: 'TOGGLE_BEACON_LIGHTS',
  strobe: 'STROBES_TOGGLE',
  landing: 'LANDING_LIGHTS_TOGGLE',
  taxi: 'TOGGLE_TAXI_LIGHTS',
  logo: 'TOGGLE_LOGO_LIGHTS',
  wing: 'TOGGLE_WING_LIGHTS',
  recognition: 'TOGGLE_RECOGNITION_LIGHTS',
  panel: 'PANEL_LIGHTS_TOGGLE',
  cabin: 'TOGGLE_CABIN_LIGHTS',
};

const RADIO_SET: Record<RadioName, { active: string; standby: string; swap: string }> = {
  com1: { active: 'COM_RADIO_SET_HZ', standby: 'COM_STBY_RADIO_SET_HZ', swap: 'COM_STBY_RADIO_SWAP' },
  com2: { active: 'COM2_RADIO_SET_HZ', standby: 'COM2_STBY_RADIO_SET_HZ', swap: 'COM2_RADIO_SWAP' },
  nav1: { active: 'NAV1_RADIO_SET_HZ', standby: 'NAV1_STBY_SET_HZ', swap: 'NAV1_RADIO_SWAP' },
  nav2: { active: 'NAV2_RADIO_SET_HZ', standby: 'NAV2_STBY_SET_HZ', swap: 'NAV2_RADIO_SWAP' },
};

const SIMPLE: Partial<Record<Command['type'], string>> = {
  'xpdr.ident': 'XPNDR_IDENT_ON',
  'baro.std': 'BAROMETRIC_STD_PRESSURE',
  'spoilers.arm': 'SPOILERS_ARM_TOGGLE',
  'spoilers.toggle': 'SPOILERS_TOGGLE',
  'parkingBrake.toggle': 'PARKING_BRAKES',
  'battery.toggle': 'TOGGLE_MASTER_BATTERY',
  'avionics.toggle': 'TOGGLE_AVIONICS_MASTER',
  'pitotHeat.toggle': 'PITOT_HEAT_TOGGLE',
  'door.toggle': 'TOGGLE_AIRCRAFT_EXIT',
  'pushback.toggle': 'TOGGLE_PUSHBACK',
  'engines.autostart': 'ENGINE_AUTO_START',
  'engines.shutdown': 'ENGINE_AUTO_SHUTDOWN',
};

/** Encodes a decimal number's digits as BCD, e.g. 7000 -> 0x7000. */
export function encodeBcd(value: number): number {
  return parseInt(String(Math.round(value)), 16);
}

export function isValidSquawk(code: string): boolean {
  return /^[0-7]{4}$/.test(code);
}

export function validRadioMhz(radio: RadioName, mhz: number): boolean {
  return radio.startsWith('com') ? mhz >= 118 && mhz < 137 : mhz >= 108 && mhz < 118;
}

const SIM_RATES = [0.25, 0.5, 1, 2, 4, 8, 16, 32, 64, 128];

/** Number of SIM_RATE_INCR (positive) or SIM_RATE_DECR (negative) presses to reach a rate. */
export function simRateSteps(current: number, target: number): number {
  const idx = (r: number) => SIM_RATES.reduce((best, v, i) => (Math.abs(v - r) < Math.abs(SIM_RATES[best] - r) ? i : best), 0);
  return idx(target) - idx(current);
}

/**
 * Returns the key events for a command. Commands that are not plain key events
 * (fuel, teleport, demo control) are handled by the bridge itself and return null.
 */
export function eventsForCommand(cmd: Command, t: Telemetry | null): SimEvent[] | null {
  const simple = SIMPLE[cmd.type];
  if (simple) return [{ name: simple }];
  switch (cmd.type) {
    case 'ap.toggle':
      return [{ name: AP_TOGGLES[cmd.mode] }];
    case 'ap.set':
      switch (cmd.key) {
        case 'hdg':
          return [{ name: 'HEADING_BUG_SET', value: Math.round(((cmd.value % 360) + 360) % 360) }];
        case 'alt':
          if (cmd.value < -1000 || cmd.value > 60000) throw new CommandError('Altitude must be between -1,000 and 60,000 ft.');
          return [{ name: 'AP_ALT_VAR_SET_ENGLISH', value: Math.round(cmd.value) }];
        case 'vs':
          if (Math.abs(cmd.value) > 10000) throw new CommandError('Vertical speed must be within ±10,000 fpm.');
          return [{ name: 'AP_VS_VAR_SET_ENGLISH', value: Math.round(cmd.value) }];
        case 'spd':
          if (cmd.value < 0 || cmd.value > 999) throw new CommandError('Speed must be between 0 and 999 kt.');
          return [{ name: 'AP_SPD_VAR_SET', value: Math.round(cmd.value) }];
      }
      break;
    case 'radio.set': {
      if (!validRadioMhz(cmd.radio, cmd.mhz)) {
        throw new CommandError(cmd.radio.startsWith('com') ? 'COM frequencies run from 118.000 to 136.990 MHz.' : 'NAV frequencies run from 108.00 to 117.95 MHz.');
      }
      return [{ name: RADIO_SET[cmd.radio][cmd.slot], value: Math.round(cmd.mhz * 1_000_000) }];
    }
    case 'radio.swap':
      return [{ name: RADIO_SET[cmd.radio].swap }];
    case 'obs.set':
      return [{ name: cmd.nav === 1 ? 'VOR1_SET' : 'VOR2_SET', value: Math.round(((cmd.deg % 360) + 360) % 360) }];
    case 'adf.set':
      if (cmd.khz < 190 || cmd.khz > 1799) throw new CommandError('ADF frequencies run from 190 to 1799 kHz.');
      return [{ name: 'ADF_COMPLETE_SET', value: encodeBcd(Math.round(cmd.khz * 1000)) }];
    case 'xpdr.set':
      if (!isValidSquawk(cmd.code)) throw new CommandError('A squawk code is four digits from 0 to 7.');
      return [{ name: 'XPNDR_SET', value: encodeBcd(Number(cmd.code)) }];
    case 'baro.set':
      // KOHLSMAN_SET takes millibars * 16.
      return [{ name: 'KOHLSMAN_SET', value: Math.round(cmd.inHg * 33.8639 * 16) }];
    case 'light.set':
      if (t && t.lights[cmd.light] === cmd.on) return [];
      return [{ name: LIGHT_TOGGLES[cmd.light] }];
    case 'gear.set':
      return [{ name: cmd.down ? 'GEAR_DOWN' : 'GEAR_UP' }];
    case 'flaps.step':
      return [{ name: cmd.dir > 0 ? 'FLAPS_INCR' : 'FLAPS_DECR' }];
    case 'sim.pause':
      return [{ name: cmd.paused ? 'PAUSE_ON' : 'PAUSE_OFF' }];
    case 'sim.rate': {
      const steps = simRateSteps(t?.sim.rate ?? 1, cmd.rate);
      return Array.from({ length: Math.abs(steps) }, () => ({ name: steps > 0 ? 'SIM_RATE_INCR' : 'SIM_RATE_DECR' }));
    }
    case 'sim.slew':
      return [{ name: cmd.on ? 'SLEW_ON' : 'SLEW_OFF' }];
    case 'sim.time':
      return [
        { name: 'ZULU_HOURS_SET', value: Math.max(0, Math.min(23, Math.round(cmd.zuluHour))) },
        { name: 'ZULU_MINUTES_SET', value: Math.max(0, Math.min(59, Math.round(cmd.zuluMinute))) },
      ];
  }
  return null;
}
