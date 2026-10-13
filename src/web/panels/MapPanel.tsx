import { useEffect, useRef, useState } from 'react';
import maplibregl, { type GeoJSONSource, type MapMouseEvent, type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { AirportDetails, AvionicsPlanState, FlightPlan, PlanWaypoint, Telemetry } from '../../shared/types';
import { destinationPoint, distanceNm, greatCirclePoints, normalizeDeg } from '../../shared/geo';
import { act, getState, subscribe, useSettings, useTelemetry } from '../lib/store';
import { api, loadAirportsData, loadNavaidsData } from '../lib/api';
import { fmtDistance, fmtDuration, fmtFreq, fmtInt, fmtLat, fmtLon } from '../lib/format';
import { activeIndexIn, insertNearest, routeOf, setDeparture, setDestination, userWaypoint, insertWaypoint } from '../lib/plan';
import { bestRunway, repositionCommand, runwayOptions } from '../lib/reposition';
import { directTo } from './FlightPlanPanel';
import { Button, Icon, IconButton } from '../components/ui';
import type { PanelProps } from './registry';

// ---------------------------------------------------------------- Base maps

const esri = (service: string) => [`https://server.arcgisonline.com/ArcGIS/rest/services/${service}/MapServer/tile/{z}/{y}/{x}`];

/** Raster base maps that need no API key. Each may have a label layer drawn on top. */
const BASE_MAPS: Record<string, { label: string; tiles: string[]; labels?: string[]; attribution: string; maxzoom: number; dim?: boolean }> = {
  dark: {
    label: 'Dark',
    tiles: esri('Canvas/World_Dark_Gray_Base'),
    labels: esri('Canvas/World_Dark_Gray_Reference'),
    attribution: 'Esri, HERE, Garmin, © OpenStreetMap contributors',
    maxzoom: 16,
  },
  light: {
    label: 'Streets',
    tiles: esri('World_Street_Map'),
    attribution: 'Esri, HERE, Garmin, USGS, © OpenStreetMap contributors',
    maxzoom: 19,
    dim: true,
  },
  topo: {
    label: 'Terrain',
    tiles: esri('World_Topo_Map'),
    attribution: 'Esri, HERE, Garmin, FAO, NOAA, USGS, © OpenStreetMap contributors',
    maxzoom: 19,
    dim: true,
  },
  satellite: {
    label: 'Satellite',
    tiles: esri('World_Imagery'),
    labels: esri('Reference/World_Boundaries_and_Places'),
    attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
    maxzoom: 19,
  },
};

const FONT = ['Open Sans Semibold'];
const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
const DIM_PAINT = { 'raster-brightness-max': 0.72, 'raster-saturation': -0.25 };

function baseStyle(): StyleSpecification {
  return {
    version: 8,
    glyphs: 'https://fonts.openmaptiles.org/{fontstack}/{range}.pbf',
    sources: {},
    layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#0a1015' } }],
  };
}

/** Replaces the base map (and its label layer) underneath SkyDeck's own overlays. */
function swapBase(map: maplibregl.Map, id: string) {
  const b = BASE_MAPS[id] ?? BASE_MAPS.dark;
  for (const layer of ['base-labels', 'base']) {
    if (map.getLayer(layer)) map.removeLayer(layer);
    if (map.getSource(layer)) map.removeSource(layer);
  }
  const before = map.getLayer('airports-l') ? 'airports-l' : undefined;
  map.addSource('base', { type: 'raster', tiles: b.tiles, tileSize: 256, attribution: b.attribution, maxzoom: b.maxzoom });
  map.addLayer({ id: 'base', type: 'raster', source: 'base', paint: b.dim ? DIM_PAINT : {} }, before);
  if (b.labels) {
    map.addSource('base-labels', { type: 'raster', tiles: b.labels, tileSize: 256, maxzoom: b.maxzoom });
    map.addLayer({ id: 'base-labels', type: 'raster', source: 'base-labels', paint: { 'raster-opacity': 0.8 } }, before);
  }
}

// ---------------------------------------------------------------- Static overlays

async function airportsGeoJson(): Promise<GeoJSON.FeatureCollection> {
  const rows = (await loadAirportsData()) as Array<[string, string, string, string, number, number, number | null, string]>;
  return {
    type: 'FeatureCollection',
    features: rows.map((r) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [r[5], r[4]] }, properties: { i: r[0], n: r[1], s: r[7] } })),
  };
}

async function navaidsGeoJson(): Promise<GeoJSON.FeatureCollection> {
  const rows = (await loadNavaidsData()) as Array<[string, string, string, number | null, number, number]>;
  return {
    type: 'FeatureCollection',
    features: rows
      .filter((r) => r[2] !== 'DME' && r[2] !== 'TACAN')
      .map((r) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [r[5], r[4]] },
        properties: { i: r[0], n: r[1], t: r[2].startsWith('NDB') ? 'NDB' : 'VOR', f: r[3] },
      })),
  };
}

function addOverlays(map: maplibregl.Map) {
  map.addSource('airports', { type: 'geojson', data: EMPTY });
  map.addSource('navaids', { type: 'geojson', data: EMPTY });
  map.addSource('route', { type: 'geojson', data: EMPTY });
  map.addSource('route-active', { type: 'geojson', data: EMPTY });
  map.addSource('route-points', { type: 'geojson', data: EMPTY });
  map.addSource('trail', { type: 'geojson', data: EMPTY });
  map.addSource('guides', { type: 'geojson', data: EMPTY });
  map.addSource('avionics', { type: 'geojson', data: EMPTY });

  const airportLayer = (id: string, size: string[], minzoom: number, radius: number, color: string) => {
    map.addLayer({
      id: `airports-${id}`,
      type: 'circle',
      source: 'airports',
      minzoom,
      filter: ['in', ['get', 's'], ['literal', size]],
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], minzoom, radius * 0.7, 12, radius * 1.6],
        'circle-color': '#0a1015',
        'circle-stroke-color': color,
        'circle-stroke-width': 2,
      },
    });
    map.addLayer({
      id: `airports-${id}-label`,
      type: 'symbol',
      source: 'airports',
      minzoom: minzoom + 1,
      filter: ['in', ['get', 's'], ['literal', size]],
      layout: { 'text-field': ['get', 'i'], 'text-font': FONT, 'text-size': 11, 'text-offset': [0, 1.2], 'text-anchor': 'top', 'text-optional': true },
      paint: { 'text-color': '#c9d4dc', 'text-halo-color': '#0a1015', 'text-halo-width': 1.5 },
    });
  };
  airportLayer('l', ['L'], 3, 5, '#9fd8e3');
  airportLayer('m', ['M'], 6.5, 4, '#7fb6c2');
  airportLayer('s', ['S', 'W'], 9, 3, '#65808c');

  map.addLayer({
    id: 'navaids',
    type: 'circle',
    source: 'navaids',
    minzoom: 6.5,
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 6.5, 3, 12, 6],
      'circle-color': 'transparent',
      'circle-stroke-color': ['match', ['get', 't'], 'NDB', '#c9a35a', '#57c3a8'],
      'circle-stroke-width': 1.5,
    },
  });
  map.addLayer({
    id: 'navaids-label',
    type: 'symbol',
    source: 'navaids',
    minzoom: 7.5,
    layout: { 'text-field': ['get', 'i'], 'text-font': FONT, 'text-size': 10, 'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-optional': true },
    paint: { 'text-color': ['match', ['get', 't'], 'NDB', '#c9a35a', '#57c3a8'], 'text-halo-color': '#0a1015', 'text-halo-width': 1.5 },
  });

  map.addLayer({ id: 'trail', type: 'line', source: 'trail', paint: { 'line-color': '#e9eef2', 'line-opacity': 0.35, 'line-width': 2 } });
  map.addLayer({
    id: 'avionics',
    type: 'line',
    source: 'avionics',
    layout: { 'line-join': 'round' },
    paint: { 'line-color': '#e9eef2', 'line-width': 1.5, 'line-opacity': 0.75, 'line-dasharray': [1.5, 2] },
  });
  map.addLayer({ id: 'route', type: 'line', source: 'route', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#ea4fdc', 'line-width': 3, 'line-opacity': 0.85 } });
  map.addLayer({ id: 'route-active', type: 'line', source: 'route-active', layout: { 'line-cap': 'round' }, paint: { 'line-color': '#ff7af2', 'line-width': 5 } });
  map.addLayer({
    id: 'guides',
    type: 'line',
    source: 'guides',
    paint: {
      'line-color': ['match', ['get', 'k'], 'hdg', '#3fd0e6', '#ea4fdc'],
      'line-width': 2,
      'line-dasharray': [2, 2],
    },
  });
  map.addLayer({
    id: 'route-points',
    type: 'circle',
    source: 'route-points',
    paint: {
      'circle-radius': ['case', ['==', ['get', 'p'], 1], 3.5, 5],
      'circle-color': '#0a1015',
      'circle-stroke-color': '#ea4fdc',
      'circle-stroke-width': ['case', ['==', ['get', 'p'], 1], 1.5, 2.5],
    },
  });
  map.addLayer({
    id: 'route-points-label',
    type: 'symbol',
    source: 'route-points',
    layout: {
      'text-field': ['get', 'i'],
      'text-font': FONT,
      'text-size': ['case', ['==', ['get', 'p'], 1], 10, 12],
      'text-offset': [0.9, -0.9],
      'text-anchor': 'bottom-left',
      'text-allow-overlap': true,
    },
    paint: { 'text-color': '#ff9cf5', 'text-halo-color': '#0a1015', 'text-halo-width': 2 },
  });
}

function routeData(plan: FlightPlan | null, t: Telemetry | null) {
  const wps = routeOf(plan);
  const lines: GeoJSON.Feature[] = [];
  for (let i = 1; i < wps.length; i++) {
    lines.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: greatCirclePoints(wps[i - 1].lat, wps[i - 1].lon, wps[i].lat, wps[i].lon) } });
  }
  const active = activeIndexIn(wps, t);
  const activeLine: GeoJSON.Feature[] =
    active > 0
      ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: greatCirclePoints(wps[active - 1].lat, wps[active - 1].lon, wps[active].lat, wps[active].lon) } }]
      : [];
  return {
    route: { type: 'FeatureCollection', features: lines } as GeoJSON.FeatureCollection,
    active: { type: 'FeatureCollection', features: activeLine } as GeoJSON.FeatureCollection,
    points: {
      type: 'FeatureCollection',
      features: wps.map((w) => ({ type: 'Feature', properties: { i: w.ident, id: w.id, p: w.procedure ? 1 : 0 }, geometry: { type: 'Point', coordinates: [w.lon, w.lat] } })),
    } as GeoJSON.FeatureCollection,
  };
}

/** The route as the avionics hold it (from SkyDeck Link), drawn as a thin dashed line. */
function avionicsData(state: AvionicsPlanState | null): GeoJSON.FeatureCollection {
  const pts = (state?.legs ?? []).filter((l) => l.lat != null && l.lon != null).map((l) => [l.lon!, l.lat!]);
  if (pts.length < 2) return EMPTY;
  return { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: pts } }] };
}

function guidesData(t: Telemetry | null): GeoJSON.FeatureCollection {
  if (!t) return EMPTY;
  const features: GeoJSON.Feature[] = [];
  const { lat, lon } = t.position;
  if (t.autopilot.available && !t.position.onGround) {
    const len = Math.max(3, (t.speed.gs * 3) / 60); // three minutes ahead
    const p = destinationPoint(lat, lon, normalizeDeg(t.autopilot.hdg + t.attitude.magVar), len);
    features.push({ type: 'Feature', properties: { k: 'hdg' }, geometry: { type: 'LineString', coordinates: [[lon, lat], [p.lon, p.lat]] } });
  }
  if (t.gps.hasPlan && (t.gps.nextLat || t.gps.nextLon)) {
    features.push({ type: 'Feature', properties: { k: 'gps' }, geometry: { type: 'LineString', coordinates: greatCirclePoints(lat, lon, t.gps.nextLat, t.gps.nextLon) } });
  }
  return { type: 'FeatureCollection', features };
}

// ---------------------------------------------------------------- Aircraft marker

function aircraftElement() {
  const el = document.createElement('div');
  el.className = 'map-aircraft';
  el.innerHTML =
    '<svg viewBox="-20 -20 40 40" width="40" height="40" aria-label="Your aircraft"><path d="M0 -16 L3 -5 L15 2 L15 5 L3 2 L2 11 L6 14 L6 16 L0 14.5 L-6 16 L-6 14 L-2 11 L-3 2 L-15 5 L-15 2 L-3 -5 Z" fill="#f3b43f" stroke="#0a1015" stroke-width="1.5" stroke-linejoin="round"/></svg>';
  return el;
}

// ---------------------------------------------------------------- Popups

type Selection =
  | { kind: 'airport'; lngLat: [number, number]; ident: string; name: string; details?: AirportDetails | null }
  | { kind: 'navaid'; lngLat: [number, number]; ident: string; name: string; type: string; freq: number | null }
  | { kind: 'waypoint'; lngLat: [number, number]; wp: PlanWaypoint }
  | { kind: 'point'; lngLat: [number, number] };

function AirportCard({ sel, onClose }: { sel: Extract<Selection, { kind: 'airport' }>; onClose: () => void }) {
  const [details, setDetails] = useState<AirportDetails | null | undefined>(undefined);
  const t = useTelemetry();
  useEffect(() => {
    api.airport(sel.ident).then(setDetails).catch(() => setDetails(null));
  }, [sel.ident]);
  const wp: PlanWaypoint = { id: crypto.randomUUID(), ident: sel.ident, type: 'airport', lat: sel.lngLat[1], lon: sel.lngLat[0], name: sel.name, altFt: details?.elevFt ?? null };
  const runway = details ? bestRunway(runwayOptions(details), t?.environment.windDir) : undefined;
  const freqs = details?.frequencies.slice(0, 6) ?? [];
  return (
    <>
      <div className="map-card__title">
        <strong>{sel.ident}</strong>
        <span>{sel.name}</span>
      </div>
      {details === undefined && <p className="muted small">Loading airport…</p>}
      {details && (
        <div className="map-card__facts">
          <span>Elevation {details.elevFt != null ? `${fmtInt(details.elevFt)} ft` : '—'}</span>
          <span>
            Runways{' '}
            {details.runways
              .map((r) => r.ends.map((e) => e.ident).join('/'))
              .slice(0, 4)
              .join(', ') || '—'}
          </span>
          {t && <span>{fmtDistance(distanceNm(t.position.lat, t.position.lon, sel.lngLat[1], sel.lngLat[0]))} nm from you</span>}
        </div>
      )}
      {freqs.length > 0 && (
        <div className="chip-row">
          {freqs.map((f, i) => (
            <button key={i} type="button" className="freq-chip" title="Put in COM 1 standby" onClick={() => act({ type: 'radio.set', radio: 'com1', slot: 'standby', mhz: f.mhz })}>
              <span>{f.type}</span>
              {f.mhz.toFixed(3)}
            </button>
          ))}
        </div>
      )}
      <div className="map-card__actions">
        <Button size="sm" onClick={() => { void setDeparture(wp); onClose(); }}>Set as departure</Button>
        <Button size="sm" onClick={() => { void setDestination(wp); onClose(); }}>Set as destination</Button>
        <Button size="sm" onClick={() => { void insertWaypoint(wp); onClose(); }}>Add to route</Button>
        {t && <Button size="sm" icon="direct" onClick={() => { void directTo(wp); onClose(); }}>Direct to</Button>}
        {t && details && runway && (
          <Button size="sm" icon="moveTo" onClick={() => { act(repositionCommand(details, runway, 0, 0)); onClose(); }} title={`Puts the aircraft on runway ${runway.ident}`}>
            Move aircraft to runway {runway.ident}
          </Button>
        )}
      </div>
    </>
  );
}

function PointCard({ sel, onClose }: { sel: Extract<Selection, { kind: 'point' }>; onClose: () => void }) {
  const t = useTelemetry();
  const [moving, setMoving] = useState(false);
  const [alt, setAlt] = useState(String(Math.max(1000, Math.round((t?.position.altFt ?? 3000) / 500) * 500)));
  const [hdg, setHdg] = useState(String(Math.round(t?.attitude.hdgTrue ?? 0)));
  const [kts, setKts] = useState(String(Math.max(80, Math.round(t?.speed.ias ?? 100))));
  const [lon, lat] = sel.lngLat;
  return (
    <>
      <div className="map-card__title">
        <strong>Point</strong>
        <span>
          {fmtLat(lat)} {fmtLon(lon)}
        </span>
      </div>
      {!moving ? (
        <div className="map-card__actions">
          {t && <Button size="sm" icon="direct" onClick={() => { void directTo(userWaypoint(lat, lon)); onClose(); }}>Direct to here</Button>}
          <Button size="sm" icon="plus" onClick={() => { void insertNearest(userWaypoint(lat, lon)); onClose(); }}>Add to flight plan</Button>
          {t && <Button size="sm" icon="moveTo" onClick={() => setMoving(true)}>Move aircraft here…</Button>}
        </div>
      ) : (
        <form
          className="map-card__form"
          onSubmit={(e) => {
            e.preventDefault();
            act({ type: 'teleport', lat, lon, altFt: Number(alt) || 3000, headingTrue: Number(hdg) || 0, kts: Number(kts) || 100, onGround: false });
            onClose();
          }}
        >
          <label>Altitude <input value={alt} onChange={(e) => setAlt(e.target.value)} inputMode="numeric" size={6} /> ft</label>
          <label>Heading <input value={hdg} onChange={(e) => setHdg(e.target.value)} inputMode="numeric" size={4} />° true</label>
          <label>Speed <input value={kts} onChange={(e) => setKts(e.target.value)} inputMode="numeric" size={4} /> kt</label>
          <Button size="sm" variant="primary" type="submit">Move aircraft</Button>
        </form>
      )}
    </>
  );
}

function SelectionCard({ sel, onClose }: { sel: Selection; onClose: () => void }) {
  return (
    <div className="map-card" role="dialog" aria-label="Map selection">
      <IconButton icon="close" label="Close" className="map-card__close" onClick={onClose} />
      {sel.kind === 'airport' && <AirportCard sel={sel} onClose={onClose} />}
      {sel.kind === 'point' && <PointCard sel={sel} onClose={onClose} />}
      {sel.kind === 'navaid' && (
        <>
          <div className="map-card__title">
            <strong>{sel.ident}</strong>
            <span>
              {sel.name} {sel.type}
            </span>
          </div>
          {sel.freq && <p className="map-card__facts">{sel.type === 'NDB' ? `${sel.freq} kHz` : `${fmtFreq('nav1', sel.freq / 1000)} MHz`}</p>}
          <div className="map-card__actions">
            {sel.type !== 'NDB' && sel.freq && (
              <Button size="sm" onClick={() => { act({ type: 'radio.set', radio: 'nav1', slot: 'standby', mhz: sel.freq! / 1000 }); onClose(); }}>
                Tune NAV 1 standby
              </Button>
            )}
            {sel.type === 'NDB' && sel.freq && (
              <Button size="sm" onClick={() => { act({ type: 'adf.set', khz: sel.freq! }); onClose(); }}>
                Tune ADF
              </Button>
            )}
            <Button size="sm" onClick={() => { void insertNearest({ id: crypto.randomUUID(), ident: sel.ident, type: sel.type === 'NDB' ? 'ndb' : 'vor', lat: sel.lngLat[1], lon: sel.lngLat[0], name: sel.name }); onClose(); }}>
              Add to flight plan
            </Button>
          </div>
        </>
      )}
      {sel.kind === 'waypoint' && (
        <>
          <div className="map-card__title">
            <strong>{sel.wp.ident}</strong>
            <span>In your flight plan</span>
          </div>
          <div className="map-card__actions">
            {getState().telemetry && <Button size="sm" icon="direct" onClick={() => { void directTo(sel.wp); onClose(); }}>Direct to</Button>}
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Panel

interface LayerPrefs {
  airports: boolean;
  navaids: boolean;
  trail: boolean;
  avionics: boolean;
}

function loadPrefs(): LayerPrefs {
  try {
    return { airports: true, navaids: true, trail: true, avionics: true, ...JSON.parse(localStorage.getItem('skydeck.map.layers') ?? '{}') };
  } catch {
    return { airports: true, navaids: true, trail: true, avionics: true };
  }
}

export function MapPanel({ detail }: PanelProps) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const readyRef = useRef(false);
  const [follow, setFollow] = useState(true);
  const [trackUp, setTrackUp] = useState(false);
  const [layersOpen, setLayersOpen] = useState(false);
  const [prefs, setPrefs] = useState<LayerPrefs>(loadPrefs);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [cardPos, setCardPos] = useState<{ x: number; y: number } | null>(null);
  const settings = useSettings();
  const t = useTelemetry();
  const followRef = useRef(follow);
  const trackUpRef = useRef(trackUp);
  followRef.current = follow;
  trackUpRef.current = trackUp;
  const styleId = settings?.mapStyle ?? 'dark';

  // Create the map once.
  useEffect(() => {
    if (!container.current) return;
    const s = getState();
    const start = s.telemetry?.position ?? (s.plan?.waypoints[0] ? { lat: s.plan.waypoints[0].lat, lon: s.plan.waypoints[0].lon } : { lat: 45, lon: 10 });
    const map = new maplibregl.Map({
      container: container.current,
      style: baseStyle(),
      center: [start.lon, start.lat],
      zoom: s.telemetry ? 9 : 5,
      attributionControl: { compact: true },
      dragRotate: true,
      pitchWithRotate: false,
    });
    mapRef.current = map;
    const marker = new maplibregl.Marker({ element: aircraftElement(), rotationAlignment: 'map', pitchAlignment: 'map' });
    let markerShown = false;
    const trail: Array<[number, number]> = [];
    let lastTrail = 0;
    let lastPlan: FlightPlan | null | undefined;
    let lastAvionics: AvionicsPlanState | null | undefined;
    let lastActive = -2;

    // isStyleLoaded() stays false while tiles stream in, so track readiness ourselves.
    let ready = false;
    const update = () => {
      if (!ready) return;
      const { telemetry, plan, avionics } = getState();
      if (avionics !== lastAvionics) {
        lastAvionics = avionics;
        (map.getSource('avionics') as GeoJSONSource | undefined)?.setData(avionicsData(avionics));
      }
      // Aircraft
      if (telemetry) {
        const { lat, lon } = telemetry.position;
        marker.setLngLat([lon, lat]).setRotation(telemetry.attitude.hdgTrue);
        if (!markerShown) {
          marker.addTo(map);
          markerShown = true;
          map.jumpTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 8) });
        }
        if (followRef.current) {
          map.jumpTo({ center: [lon, lat], bearing: trackUpRef.current ? telemetry.attitude.trackTrue : map.getBearing() });
        }
        const now = Date.now();
        if (now - lastTrail > 1000) {
          lastTrail = now;
          const prev = trail[trail.length - 1];
          // A jump of more than 20 nm means the aircraft was moved: start a new trail.
          if (prev && distanceNm(prev[1], prev[0], lat, lon) > 20) trail.length = 0;
          trail.push([lon, lat]);
          if (trail.length > 3600) trail.shift();
          (map.getSource('trail') as GeoJSONSource | undefined)?.setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: trail } });
        }
      } else if (markerShown) {
        marker.remove();
        markerShown = false;
        trail.length = 0;
      }
      (map.getSource('guides') as GeoJSONSource | undefined)?.setData(guidesData(telemetry));
      const active = activeIndexIn(routeOf(plan), telemetry);
      if (plan !== lastPlan || active !== lastActive) {
        lastPlan = plan;
        lastActive = active;
        const r = routeData(plan, telemetry);
        (map.getSource('route') as GeoJSONSource | undefined)?.setData(r.route);
        (map.getSource('route-active') as GeoJSONSource | undefined)?.setData(r.active);
        (map.getSource('route-points') as GeoJSONSource | undefined)?.setData(r.points);
      }
    };

    map.on('load', () => {
      ready = true;
      readyRef.current = true;
      addOverlays(map);
      swapBase(map, getState().settings?.mapStyle ?? 'dark');
      airportsGeoJson().then((d) => (map.getSource('airports') as GeoJSONSource | undefined)?.setData(d)).catch(() => undefined);
      navaidsGeoJson().then((d) => (map.getSource('navaids') as GeoJSONSource | undefined)?.setData(d)).catch(() => undefined);
      applyPrefs(map, loadPrefs());
      const plan = getState().plan;
      if (!getState().telemetry && plan && plan.waypoints.length > 1) {
        const b = new maplibregl.LngLatBounds();
        plan.waypoints.forEach((w) => b.extend([w.lon, w.lat]));
        map.fitBounds(b, { padding: 60, duration: 0, maxZoom: 10 });
      }
      update();
    });
    const unsub = subscribe(update);

    // Stop following when the user drags the map.
    map.on('dragstart', (e) => {
      if ((e as unknown as { originalEvent?: Event }).originalEvent) setFollow(false);
    });

    const clickable = ['route-points', 'airports-l', 'airports-m', 'airports-s', 'navaids'];
    map.on('click', (e: MapMouseEvent) => {
      const layers = clickable.filter((l) => map.getLayer(l));
      const f = map.queryRenderedFeatures(e.point, { layers })[0];
      if (!f) {
        setSelection(null);
        return;
      }
      const coords = (f.geometry as GeoJSON.Point).coordinates as [number, number];
      const p = f.properties as Record<string, string | number | null>;
      if (f.layer.id === 'route-points') {
        const wp = routeOf(getState().plan).find((w) => w.id === p.id);
        if (wp) setSelection({ kind: 'waypoint', lngLat: coords, wp });
      } else if (f.layer.id === 'navaids') {
        setSelection({ kind: 'navaid', lngLat: coords, ident: String(p.i), name: String(p.n), type: String(p.t), freq: p.f == null ? null : Number(p.f) });
      } else {
        setSelection({ kind: 'airport', lngLat: coords, ident: String(p.i), name: String(p.n) });
      }
    });
    map.on('contextmenu', (e: MapMouseEvent) => {
      e.preventDefault();
      setSelection({ kind: 'point', lngLat: [e.lngLat.lng, e.lngLat.lat] });
    });
    for (const l of clickable) {
      map.on('mouseenter', l, () => (map.getCanvas().style.cursor = 'pointer'));
      map.on('mouseleave', l, () => (map.getCanvas().style.cursor = ''));
    }
    const ro = new ResizeObserver(() => map.resize());
    ro.observe(container.current);

    return () => {
      unsub();
      ro.disconnect();
      map.remove();
      mapRef.current = null;
      readyRef.current = false;
    };
    // The map is created once; style changes are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Base map changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    // The initial base map is added on load; this handles later changes.
    if (readyRef.current) swapBase(map, styleId);
  }, [styleId]);

  // Layer visibility.
  useEffect(() => {
    try {
      localStorage.setItem('skydeck.map.layers', JSON.stringify(prefs));
    } catch {
      /* storage unavailable: preferences just won't persist */
    }
    const map = mapRef.current;
    if (map && readyRef.current) applyPrefs(map, prefs);
  }, [prefs]);

  // Keep the selection card next to its point while the map moves.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !selection) {
      setCardPos(null);
      return;
    }
    const place = () => {
      const p = map.project(selection.lngLat);
      setCardPos({ x: p.x, y: p.y });
    };
    place();
    map.on('move', place);
    return () => {
      map.off('move', place);
    };
  }, [selection]);

  useEffect(() => {
    if (!trackUp) mapRef.current?.easeTo({ bearing: 0, duration: 300 });
  }, [trackUp]);

  const zoomTo = (delta: number) => mapRef.current?.easeTo({ zoom: (mapRef.current?.getZoom() ?? 5) + delta, duration: 200 });

  return (
    <div className={`map-panel ${detail ? 'map-panel--detail' : ''}`}>
      <div ref={container} className="map-panel__map" />
      <div className="map-tools" role="toolbar" aria-label="Map tools">
        <button type="button" className={`map-tool ${follow ? 'is-on' : ''}`} aria-pressed={follow} disabled={!t} onClick={() => setFollow((f) => !f)} title="Keep the aircraft centred">
          <Icon name="follow" />
          <span>Follow</span>
        </button>
        <button type="button" className={`map-tool ${trackUp ? 'is-on' : ''}`} aria-pressed={trackUp} disabled={!t} onClick={() => setTrackUp((v) => !v)} title="Rotate the map so your track points up">
          <Icon name="north" />
          <span>{trackUp ? 'Track up' : 'North up'}</span>
        </button>
        <button type="button" className={`map-tool ${layersOpen ? 'is-on' : ''}`} aria-expanded={layersOpen} onClick={() => setLayersOpen((v) => !v)} title="Map style and layers">
          <Icon name="layers" />
          <span>Layers</span>
        </button>
        <div className="map-tools__zoom">
          <IconButton icon="plus" label="Zoom in" onClick={() => zoomTo(1)} />
          <IconButton icon="minus" label="Zoom out" onClick={() => zoomTo(-1)} />
        </div>
        {layersOpen && (
          <div className="map-layers">
            <p className="map-layers__head">Map</p>
            {Object.entries(BASE_MAPS).map(([id, b]) => (
              <label key={id} className="radio">
                <input type="radio" name="basemap" checked={styleId === id} onChange={() => void api.saveSettings({ mapStyle: id })} />
                {b.label}
              </label>
            ))}
            <p className="map-layers__head">Show</p>
            {(
              [
                ['airports', 'Airports'],
                ['navaids', 'VORs and NDBs'],
                ['trail', 'Flown track'],
                ['avionics', 'Route in the avionics (SkyDeck Link)'],
              ] as const
            ).map(([k, label]) => (
              <label key={k} className="check">
                <input type="checkbox" checked={prefs[k]} onChange={(e) => setPrefs({ ...prefs, [k]: e.target.checked })} />
                {label}
              </label>
            ))}
          </div>
        )}
      </div>
      {t?.gps.hasPlan && t.gps.nextId && (
        <div className="map-next" aria-live="polite">
          <span className="map-next__label">Next</span>
          <strong>{t.gps.nextId}</strong>
          <span>{fmtDistance(t.gps.distNm)} nm</span>
          <span>{fmtDuration(t.gps.eteSec)}</span>
        </div>
      )}
      {!t && <div className="map-hint">Right-click the map to add points. Click an airport for details.</div>}
      {selection && cardPos && (
        <div className="map-card-anchor" style={{ left: cardPos.x, top: cardPos.y }}>
          <SelectionCard sel={selection} onClose={() => setSelection(null)} />
        </div>
      )}
    </div>
  );
}

function applyPrefs(map: maplibregl.Map, prefs: LayerPrefs) {
  const vis = (on: boolean) => (on ? 'visible' : 'none');
  for (const id of ['airports-l', 'airports-m', 'airports-s', 'airports-l-label', 'airports-m-label', 'airports-s-label']) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis(prefs.airports));
  }
  for (const id of ['navaids', 'navaids-label']) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis(prefs.navaids));
  if (map.getLayer('trail')) map.setLayoutProperty('trail', 'visibility', vis(prefs.trail));
  if (map.getLayer('avionics')) map.setLayoutProperty('avionics', 'visibility', vis(prefs.avionics));
}


