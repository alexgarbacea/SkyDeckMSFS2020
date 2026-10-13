import { describe, expect, it } from 'vitest';
import { expandPlan, type AirportProcedureLegs, type LegFix } from '../src/server/flightplan/procedures';
import type { FlightPlan, PlanWaypoint } from '../src/shared/types';

const fix = (ident: string, lat = 41, lon = 29): LegFix => ({ ident, region: 'LT', type: 'fix', lat, lon });
const wp = (ident: string, type: PlanWaypoint['type'] = 'fix'): PlanWaypoint => ({ id: ident, ident, type, lat: 41, lon: 29 });

const dep: AirportProcedureLegs = {
  departures: {
    SID1A: { runways: { '23': [fix('DE23'), fix('A1')], '05': [fix('DE05')] }, common: [fix('B1'), fix('EXIT')], transitions: { TRANS: [fix('T1')] } },
  },
  arrivals: {},
  approaches: {},
};
const arr: AirportProcedureLegs = {
  departures: {},
  arrivals: { STAR1: { runways: { '24R': [fix('R1')] }, common: [fix('ENTRY'), fix('C1'), fix('IAF')], transitions: {} } },
  approaches: { 'ILS 24R Z': { runways: {}, common: [fix('IAF'), fix('FAF')], transitions: { IAF: [fix('IAF')] } } },
};

const plan = (procedures: FlightPlan['procedures'], enroute: PlanWaypoint[] = [wp('EXIT'), wp('MID'), wp('ENTRY')]): FlightPlan => ({
  title: '',
  rules: 'IFR',
  cruiseAltFt: 8000,
  waypoints: [wp('DEP', 'airport'), ...enroute, wp('ARR', 'airport')],
  procedures,
  source: 'test',
  updatedAt: 0,
  sentToSimAt: null,
});

const idents = (w: PlanWaypoint[]) => w.map((x) => x.ident).join(' ');

describe('expandPlan', () => {
  it('inserts the SID for the chosen runway and drops the duplicated exit fix', () => {
    const out = expandPlan(plan({ sid: 'SID1A', departureRunway: '23' }), dep, null);
    expect(idents(out)).toBe('DEP DE23 A1 B1 EXIT MID ENTRY ARR');
    expect(out[1].procedure).toEqual({ kind: 'sid', name: 'SID1A', runway: '23' });
    expect(out[5].procedure).toBeUndefined();
  });

  it('adds the enroute transition after the common part', () => {
    const out = expandPlan(plan({ sid: 'SID1A', departureRunway: '05', sidTransition: 'TRANS' }, [wp('MID')]), dep, null);
    expect(idents(out)).toBe('DEP DE05 B1 EXIT T1 MID ARR');
  });

  it('chains the STAR and the approach in order', () => {
    const out = expandPlan(plan({ star: 'STAR1', approach: 'ILS 24R Z', arrivalRunway: '24R' }), null, arr);
    expect(idents(out)).toBe('DEP EXIT MID ENTRY C1 IAF R1 IAF FAF ARR');
    expect(out.filter((w) => w.procedure?.kind === 'approach').map((w) => w.ident)).toEqual(['IAF', 'FAF']);
  });

  it('leaves the plan alone when procedures are unknown', () => {
    const p = plan({ sid: 'NOPE', star: 'NOPE' });
    expect(idents(expandPlan(p, dep, arr))).toBe('DEP EXIT MID ENTRY ARR');
  });

  it('does not duplicate previously expanded fixes', () => {
    const p = plan({ sid: 'SID1A', departureRunway: '23' });
    const once = expandPlan(p, dep, null);
    const twice = expandPlan({ ...p, waypoints: once }, dep, null);
    expect(idents(twice)).toBe(idents(once));
  });
});
