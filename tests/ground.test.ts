import { describe, expect, it } from 'vitest';
import { buildGround, calibrate, findRoute, standName, syntheticGround, type RawGround } from '../src/server/ground/graph';
import { runwayAt, runwayGeoms } from '../src/server/ground/geometry';
import type { AirportDetails } from '../src/shared/types';

export function airport(ident: string, lat: number, lon: number, ends: [string, string] = ['09', '27']): AirportDetails {
  // A 2,400 m east-west runway centred on the airport reference point.
  const half = 1200 / (111320 * Math.cos((lat * Math.PI) / 180));
  return {
    ident,
    name: `${ident} International Airport`,
    city: `City ${ident}`,
    country: 'XX',
    lat,
    lon,
    elevFt: 100,
    size: 'large',
    runways: [
      {
        ends: [
          { ident: ends[0], lat, lon: lon - half, headingTrue: 90, elevFt: 100 },
          { ident: ends[1], lat, lon: lon + half, headingTrue: 270, elevFt: 100 },
        ],
        lengthFt: 7874,
        widthFt: 148,
        surface: 'ASP',
        lighted: true,
      },
    ],
    frequencies: [],
    procedures: null,
    source: 'offline',
  };
}

describe('synthetic ground layout', () => {
  const ap = airport('AAAA', 35, 25);
  const g = syntheticGround('AAAA', ap)!;

  it('has stands, hold-short points and runway nodes', () => {
    expect(g.stands).toHaveLength(4);
    expect(g.nodes.filter((n) => n.hold)).toHaveLength(3);
    expect(g.nodeRunway.filter((r) => r >= 0)).toHaveLength(3);
  });

  it('routes from a stand to the holding point nearest the threshold', () => {
    const s = g.stands[0];
    const r = findRoute(g, { lat: s.lat, lon: s.lon }, { kind: 'runway', runway: '27' })!;
    expect(r).not.toBeNull();
    expect(r.to).toEqual({ kind: 'runway', runway: '27' });
    expect(r.via).toEqual(['P', 'A', 'A3']);
    expect(r.crossings).toEqual([]);
    expect(r.steps[r.steps.length - 1].text).toBe('Hold short of runway 27');
    // The route ends at the hold-short point next to the 27 threshold (east end).
    const end = r.points[r.points.length - 1];
    expect(end[0]).toBeGreaterThan(25.01);
  });

  it('routes from the runway to a stand, leaving the runway first', () => {
    const r = findRoute(g, { lat: 35, lon: 25.005, headingTrue: 270 }, { kind: 'stand', index: 2 })!;
    expect(r.to.kind).toBe('stand');
    expect(r.crossings).toEqual([]);
    expect(r.steps[r.steps.length - 1].text).toBe('Arrive at Parking 3');
  });

  it('knows when a point is on the runway', () => {
    const rws = runwayGeoms(ap);
    expect(runwayAt(rws, 35, 25)?.name).toBe('09/27');
    expect(runwayAt(rws, 35.002, 25)).toBeNull();
  });
});

describe('simulator taxi data', () => {
  const ap = airport('CCCC', 40, 10);
  // A square of taxiways next to the runway (x east / z north, metres from the reference point) and one stand.
  const raw: RawGround = {
    refLat: 40,
    refLon: 10,
    points: [
      { type: 1, x: -1200, z: 0 }, // 0 runway west end
      { type: 1, x: 1200, z: 0 }, // 1 runway east end
      { type: 2, x: 1100, z: 70 }, // 2 hold short near the east end
      { type: 1, x: 1100, z: 150 }, // 3
      { type: 1, x: 0, z: 150 }, // 4
      { type: 1, x: 0, z: 250 }, // 5 apron
    ],
    parkings: [{ type: 9, name: 13, number: 4, heading: 180, radius: 18, x: 0, z: 300 }],
    paths: [
      { type: 2, start: 0, end: 1, nameIndex: 0 },
      { type: 1, start: 1, end: 2, nameIndex: 2 },
      { type: 1, start: 2, end: 3, nameIndex: 2 },
      { type: 1, start: 3, end: 4, nameIndex: 1 },
      { type: 1, start: 4, end: 5, nameIndex: 3 },
      { type: 3, start: 5, end: 0, nameIndex: 0 },
      { type: 6, start: 0, end: 5, nameIndex: 0 }, // vehicle road: ignored
    ],
    names: ['', 'A', 'B1', 'P'],
  };

  it('keeps the documented axes when they fit the runway', () => {
    expect(calibrate(raw, runwayGeoms(ap)).orientation).toBe(0);
  });

  it('builds stands and plans a named route', () => {
    const g = buildGround('CCCC', raw, ap);
    expect(g.stands[0]).toMatchObject({ name: 'Gate B4', kind: 'gate', size: 'medium' });
    const r = findRoute(g, { lat: g.stands[0].lat, lon: g.stands[0].lon }, { kind: 'runway', runway: '27' })!;
    expect(r.via).toEqual(['P', 'A', 'B1']);
    // Southbound out of the stand, left onto A (east), right onto B1 (south).
    expect(r.steps.map((s) => s.text)).toEqual(['Turn left onto A', 'Turn right onto B1', 'Hold short of runway 27']);
  });

  it('detects swapped axes', () => {
    const swapped: RawGround = { ...raw, points: raw.points.map((p) => ({ ...p, x: p.z, z: p.x })) };
    expect(calibrate(swapped, runwayGeoms(ap)).orientation).toBe(4);
  });

  it('names stands like the scenery does', () => {
    expect(standName(12, 7)).toBe('Gate A7');
    expect(standName(1, 3)).toBe('Parking 3');
    expect(standName(10, 22)).toBe('Gate 22');
  });
});
