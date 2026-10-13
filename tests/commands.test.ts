import { describe, expect, it } from 'vitest';
import { parseCommand } from '../src/web/lib/commands';
import { parseAltitude, parseFrequency, fmtHeading, fmtVs } from '../src/web/lib/format';
import { encodeBcd, eventsForCommand, simRateSteps } from '../src/server/bridge/events';
import { decodeBcd16 } from '../src/server/bridge/simvars';

const cmd = (text: string) => {
  const a = parseCommand(text).action;
  return a && a.kind === 'command' ? a.command : a;
};

describe('command bar', () => {
  it('sets autopilot targets', () => {
    expect(cmd('hdg 270')).toEqual({ type: 'ap.set', key: 'hdg', value: 270 });
    expect(cmd('HDG 360')).toEqual({ type: 'ap.set', key: 'hdg', value: 0 });
    expect(cmd('alt 8000')).toEqual({ type: 'ap.set', key: 'alt', value: 8000 });
    expect(cmd('alt FL120')).toEqual({ type: 'ap.set', key: 'alt', value: 12000 });
    expect(cmd('vs -500')).toEqual({ type: 'ap.set', key: 'vs', value: -500 });
    expect(cmd('vs +700')).toEqual({ type: 'ap.set', key: 'vs', value: 700 });
    expect(cmd('spd 120')).toEqual({ type: 'ap.set', key: 'spd', value: 120 });
  });

  it('toggles modes and respects on/off', () => {
    expect(parseCommand('ap on').action).toMatchObject({ kind: 'apMode', mode: 'master', on: true });
    expect(parseCommand('hdg').action).toMatchObject({ kind: 'apMode', mode: 'hdg' });
  });

  it('tunes radios the way pilots type frequencies', () => {
    expect(cmd('com1 121.5')).toEqual({ type: 'radio.set', radio: 'com1', slot: 'active', mhz: 121.5 });
    expect(cmd('com1 stby 1183')).toEqual({ type: 'radio.set', radio: 'com1', slot: 'standby', mhz: 118.3 });
    expect(cmd('com1s 118.3')).toEqual({ type: 'radio.set', radio: 'com1', slot: 'standby', mhz: 118.3 });
    expect(cmd('nav1 110.3')).toEqual({ type: 'radio.set', radio: 'nav1', slot: 'active', mhz: 110.3 });
    expect(cmd('com2 swap')).toEqual({ type: 'radio.swap', radio: 'com2' });
    expect(parseCommand('com1 99.1').action).toBeNull();
    expect(parseCommand('com1 99.1').hint).toBeTruthy();
  });

  it('handles transponder and altimeter', () => {
    expect(cmd('squawk 7000')).toEqual({ type: 'xpdr.set', code: '7000' });
    expect(parseCommand('squawk 7800').action).toBeNull();
    expect(cmd('qnh 1013')).toMatchObject({ type: 'baro.set' });
    expect((cmd('qnh 1013') as { inHg: number }).inHg).toBeCloseTo(29.91, 2);
    expect(cmd('baro std')).toEqual({ type: 'baro.std' });
  });

  it('understands navigation and repositioning', () => {
    expect(parseCommand('direct lgav').action).toMatchObject({ kind: 'direct', ident: 'LGAV' });
    expect(parseCommand('final LGIR 27').action).toMatchObject({ kind: 'reposition', ident: 'LGIR', runway: '27', finalNm: 5 });
    expect(parseCommand('final LGIR 9 10nm').action).toMatchObject({ runway: '09', finalNm: 10 });
    expect(parseCommand('goto ltba 34l').action).toMatchObject({ kind: 'reposition', runway: '34L', finalNm: 0 });
    expect(parseCommand('route LGIR SIT LGAV').action).toMatchObject({ kind: 'route', route: 'LGIR SIT LGAV' });
  });

  it('controls the simulator', () => {
    expect(cmd('pause')).toEqual({ type: 'sim.pause', paused: true });
    expect(cmd('rate 4')).toEqual({ type: 'sim.rate', rate: 4 });
    expect(parseCommand('time 18:30').action).toMatchObject({ kind: 'localTime', hour: 18, minute: 30 });
    expect(parseCommand('landing on').action).toMatchObject({ kind: 'lights', lights: ['landing'], on: true });
    expect(cmd('fuel 50%')).toEqual({ type: 'fuel.set', pct: 50 });
  });

  it('returns nothing for gibberish', () => {
    expect(parseCommand('make me a sandwich').action).toBeNull();
  });
});

describe('formatting helpers', () => {
  it('parses frequencies', () => {
    expect(parseFrequency('com1', '121.5')).toBe(121.5);
    expect(parseFrequency('com1', '1215')).toBe(121.5);
    expect(parseFrequency('com1', '121725')).toBe(121.725);
    expect(parseFrequency('nav1', '118.0')).toBeNull();
  });
  it('parses altitudes', () => {
    expect(parseAltitude('FL085')).toBe(8500);
    expect(parseAltitude('12,000 ft')).toBe(12000);
    expect(parseAltitude('abc')).toBeNull();
  });
  it('formats headings and vertical speed', () => {
    expect(fmtHeading(0)).toBe('360');
    expect(fmtHeading(5.4)).toBe('005');
    expect(fmtVs(-500)).toBe('−500');
  });
});

describe('simulator events', () => {
  it('encodes BCD values', () => {
    expect(encodeBcd(7000)).toBe(0x7000);
    expect(decodeBcd16(0x1200)).toBe('1200');
  });
  it('maps commands to key events', () => {
    expect(eventsForCommand({ type: 'radio.set', radio: 'com2', slot: 'standby', mhz: 121.5 }, null)).toEqual([{ name: 'COM2_STBY_RADIO_SET_HZ', value: 121500000 }]);
    expect(eventsForCommand({ type: 'ap.set', key: 'hdg', value: 450 }, null)).toEqual([{ name: 'HEADING_BUG_SET', value: 90 }]);
    expect(eventsForCommand({ type: 'teleport', lat: 0, lon: 0, altFt: 0, headingTrue: 0, kts: 0, onGround: true }, null)).toBeNull();
    expect(() => eventsForCommand({ type: 'xpdr.set', code: '7890' }, null)).toThrow();
  });
  it('steps the simulation rate', () => {
    expect(simRateSteps(1, 4)).toBe(2);
    expect(simRateSteps(4, 0.5)).toBe(-3);
  });
});
