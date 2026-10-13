import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPln, formatLla, parseApproachName, parseLla, parsePln, splitRunway } from '../src/server/flightplan/pln';
import type { FlightPlan } from '../src/shared/types';

const fixture = readFileSync(path.join(__dirname, 'fixtures', 'world-map-lgir.pln'), 'utf8');

describe('coordinates', () => {
  it('formats and parses MSFS LLA strings', () => {
    const s = formatLla(35.339736, 25.180228, 100);
    expect(s).toBe('N35° 20\' 23.05",E25° 10\' 48.82",+000100.00');
    const p = parseLla(s)!;
    expect(p.lat).toBeCloseTo(35.339736, 5);
    expect(p.lon).toBeCloseTo(25.180228, 5);
    expect(p.altFt).toBe(100);
  });

  it('handles southern and western hemispheres', () => {
    const p = parseLla(formatLla(-33.9461, -151.1772, -12))!;
    expect(p.lat).toBeCloseTo(-33.9461, 4);
    expect(p.lon).toBeCloseTo(-151.1772, 4);
    expect(p.altFt).toBe(-12);
  });

  it('never prints 60 seconds', () => {
    expect(formatLla(10.9999999, 20, 0)).toContain('N11° 0\' 0.00"');
  });
});

describe('parsePln', () => {
  it('reads a World Map plan and drops the sim pseudo waypoints', () => {
    const plan = parsePln(fixture, 'MSFS World Map');
    expect(plan.title).toBe('Nikos Kazantzakis to Nikos Kazantzakis');
    expect(plan.waypoints.map((w) => w.ident)).toEqual(['LGIR', 'Custom', 'LGIR']);
    expect(plan.waypoints[0].type).toBe('airport');
    expect(plan.waypoints[1].type).toBe('user');
    expect(plan.procedures.departureRunway).toBe('09');
    expect(plan.cruiseAltFt).toBe(1000);
  });

  it('rejects files that are not flight plans', () => {
    expect(() => parsePln('<xml></xml>')).toThrow(/does not look like/);
  });
});

describe('buildPln', () => {
  const plan: FlightPlan = {
    title: 'LTBA to LTFJ',
    rules: 'IFR',
    cruiseAltFt: 8000,
    procedures: { departureRunway: '23', sid: 'BARP1B', approach: 'ILS 24R Z', arrivalRunway: '24R' },
    waypoints: [
      { id: '1', ident: 'LTBA', type: 'airport', lat: 40.97, lon: 28.82, name: 'Atatürk & co', altFt: 163 },
      { id: '2', ident: 'DE23', type: 'fix', lat: 40.95, lon: 28.8, region: 'LT', procedure: { kind: 'sid', name: 'BARP1B', runway: '23' } },
      { id: '3', ident: 'BKZ', type: 'vor', lat: 41.13, lon: 29.14, region: 'LT' },
      { id: '4', ident: 'MY POINT', type: 'user', lat: 41.0, lon: 29.2 },
      { id: '5', ident: 'LTFJ', type: 'airport', lat: 40.9, lon: 29.31, altFt: 312 },
    ],
    source: 'test',
    updatedAt: 0,
    sentToSimAt: null,
  };
  const xml = buildPln(plan);

  it('writes procedure tags MSFS understands', () => {
    expect(xml).toContain('<DepartureFP>BARP1B</DepartureFP>');
    expect(xml).toContain('<ApproachTypeFP>ILS</ApproachTypeFP>');
    expect(xml).toContain('<RunwayDesignatorFP>RIGHT</RunwayDesignatorFP>');
    expect(xml).toContain('<SuffixFP>Z</SuffixFP>');
    expect(xml).toContain('<DeparturePosition>23</DeparturePosition>');
  });

  it('escapes text and sanitises user waypoint ids', () => {
    expect(xml).toContain('Atatürk &amp; co');
    expect(xml).toContain('<ATCWaypoint id="MYPOINT">');
    expect(xml).not.toMatch(/<ATCWaypoint id="MYPOINT">[\s\S]*?<ICAOIdent>MY POINT/);
  });

  it('round-trips the enroute route (procedure fixes are re-expanded on send)', () => {
    const back = parsePln(xml);
    expect(back.waypoints.map((w) => w.ident)).toEqual(['LTBA', 'BKZ', 'MYPOINT', 'LTFJ']);
    expect(back.procedures).toMatchObject({ sid: 'BARP1B', departureRunway: '23', approach: 'ILS 24R Z', arrivalRunway: '24R' });
    expect(back.waypoints[1]).toMatchObject({ type: 'vor', region: 'LT' });
  });

  it('refuses plans with fewer than two waypoints', () => {
    expect(() => buildPln({ ...plan, waypoints: plan.waypoints.slice(0, 1) })).toThrow();
  });
});

describe('runway and approach names', () => {
  it('splits runways', () => {
    expect(splitRunway('09')).toEqual({ number: '9', designator: null });
    expect(splitRunway('34L')).toEqual({ number: '34', designator: 'LEFT' });
  });
  it('parses approach names', () => {
    expect(parseApproachName('RNAV 22L Z')).toEqual({ type: 'RNAV', runway: '22L', suffix: 'Z' });
    expect(parseApproachName('VOR/DME 27')).toEqual({ type: 'VOR/DME', runway: '27', suffix: null });
    expect(parseApproachName('NDB CIRCLING E')).toBeNull();
  });
});
