import { useEffect, useMemo, useState } from 'react';
import type { AirportDetails, GroundLayout, GroundState, Stand, TaxiRoute } from '../../shared/types';
import { usePlan, useGround, useTelemetry } from '../lib/store';
import { api } from '../lib/api';
import { toast } from '../lib/toast';
import { fmtInt } from '../lib/format';
import { Button, Empty, Icon, Section } from '../components/ui';
import { NoAircraft } from './common';
import type { PanelProps } from './registry';

const KIND_LABEL: Record<Stand['kind'], string> = { gate: 'Gate', ramp: 'Ramp', cargo: 'Cargo', military: 'Military', other: 'Other' };

async function attempt(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e) {
    toast((e as Error).message, 'error');
  }
}

/** Taxiway layout and airport details for one airport, loaded when the ident changes. */
export function useAirportGround(ident: string | null) {
  const [layout, setLayout] = useState<GroundLayout | null>(null);
  const [details, setDetails] = useState<AirportDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setLayout(null);
    setDetails(null);
    setError(null);
    if (!ident) return;
    let live = true;
    api.groundLayout(ident).then((l) => live && setLayout(l)).catch((e: Error) => live && setError(e.message));
    api.airport(ident).then((d) => live && setDetails(d)).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [ident]);
  return { layout, details, error };
}

const fmtM = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${fmtInt(m)} m`);

function RouteCard({ g, route }: { g: GroundState; route: TaxiRoute }) {
  const p = g.progress;
  const dest = route.to.kind === 'runway' ? `holding point runway ${route.to.runway}` : route.to.stand.name;
  return (
    <div className="taxi-route">
      <div className="taxi-route__head">
        <span className="taxi-route__to">
          <small>Taxi to</small>
          {dest}
        </span>
        <Button size="sm" variant="ghost" icon="close" onClick={() => void attempt(() => api.clearTaxiRoute())} title="Clear the taxi route">
          Clear
        </Button>
      </div>
      {route.via.length > 0 && (
        <div className="chip-row taxi-route__via" aria-label="Taxiways">
          <span className="muted small">via</span>
          {route.via.map((v, i) => (
            <span key={i} className="taxiway-chip">
              {v}
            </span>
          ))}
          {route.crossings.map((c) => (
            <span key={c} className="taxiway-chip taxiway-chip--runway" title="Runway crossing">
              cross {c}
            </span>
          ))}
        </div>
      )}
      {p && !p.arrived && p.next && (
        <div className="taxi-next" aria-live="polite">
          <span className="taxi-next__in">{p.nextInM != null ? fmtM(p.nextInM) : ''}</span>
          <span className={`taxi-next__text ${p.next.kind === 'hold' || p.next.kind === 'cross' ? 'is-hold' : ''}`}>{p.next.text}</span>
        </div>
      )}
      {p && (
        <div className="taxi-route__facts">
          {p.arrived ? <span className="tone-green">You have arrived.</span> : <span>{fmtM(p.remainingM)} to go</span>}
          <span>{fmtM(route.lengthM)} in total</span>
          {p.offRouteM > 40 && <span className="warning-text">{fmtInt(p.offRouteM)} m off the route</span>}
        </div>
      )}
    </div>
  );
}

/** Docking guidance onto the stand, like the stand-entry guidance boards at gates. */
function Docking({ d }: { d: NonNullable<GroundState['docking']> }) {
  const stop = d.distanceM < 0.8;
  const lateral = Math.abs(d.lateralM) < 0.5 ? 'On centre line' : d.lateralM > 0 ? `Steer left ${d.lateralM.toFixed(1)} m` : `Steer right ${Math.abs(d.lateralM).toFixed(1)} m`;
  // The dot is the aircraft, seen from behind: right of the line when the aircraft is right of it.
  const offset = Math.max(-1, Math.min(1, d.lateralM / 5));
  return (
    <div className={`docking ${stop ? 'is-stop' : ''}`} aria-live="polite">
      <span className="docking__stand">{d.stand}</span>
      <div className="docking__scale" aria-hidden="true">
        <span className="docking__centre" />
        <span className="docking__you" style={{ left: `${50 + offset * 45}%` }} />
      </div>
      <span className="docking__lateral">{lateral}</span>
      <span className="docking__dist">{stop ? 'STOP' : `${d.distanceM < 20 ? d.distanceM.toFixed(1) : Math.round(d.distanceM)} m`}</span>
      {Math.abs(d.headingError) > 10 && <span className="muted small">Heading off by {Math.abs(d.headingError)}°</span>}
    </div>
  );
}

function StandPicker({ airport, layout, here, assigned }: { airport: string; layout: GroundLayout; here: boolean; assigned: Stand | null }) {
  const [filter, setFilter] = useState('');
  const [kind, setKind] = useState<'all' | Stand['kind']>('all');
  const kinds = useMemo(() => [...new Set(layout.stands.map((s) => s.kind))], [layout]);
  const list = useMemo(() => {
    const q = filter.trim().toUpperCase().replace(/\s+/g, '');
    return layout.stands
      .filter((s) => (kind === 'all' || s.kind === kind) && (!q || s.name.toUpperCase().replace(/\s+/g, '').includes(q)))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  }, [layout, filter, kind]);
  if (!layout.stands.length) return <p className="muted">This airport has no parking spots in its scenery.</p>;
  return (
    <div className="stand-picker">
      <div className="stand-picker__filters">
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find a stand, e.g. A12" aria-label="Find a stand" />
        <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} aria-label="Stand type">
          <option value="all">All types</option>
          {kinds.map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </select>
      </div>
      <ul className="stand-list">
        {list.slice(0, 60).map((s) => (
          <li key={s.index} className={assigned?.index === s.index ? 'is-assigned' : ''}>
            <span className="stand-list__name">{s.name}</span>
            <span className="muted small">
              {KIND_LABEL[s.kind]} · {s.size}
            </span>
            <span className="stand-list__actions">
              {here && (
                <Button size="sm" onClick={() => void attempt(() => api.taxiTo({ airport, stand: s.index }))}>
                  Taxi here
                </Button>
              )}
              <Button size="sm" variant={assigned?.index === s.index ? 'primary' : 'default'} onClick={() => void attempt(() => api.assignStand(airport, assigned?.index === s.index ? null : s.index))} title="ATC will send you to this stand after landing">
                {assigned?.index === s.index ? 'My stand' : 'Use as my stand'}
              </Button>
            </span>
          </li>
        ))}
      </ul>
      {list.length > 60 && <p className="muted small">{list.length - 60} more: type to narrow the list.</p>}
    </div>
  );
}

export function GroundPanel({ detail }: PanelProps) {
  const t = useTelemetry();
  const g = useGround();
  const plan = usePlan();
  const destination = plan && plan.waypoints.length > 1 && plan.waypoints[plan.waypoints.length - 1].type === 'airport' ? plan.waypoints[plan.waypoints.length - 1].ident : null;
  const here = g?.airport ?? null;
  const ident = here ?? destination;
  const { layout, details, error } = useAirportGround(ident);
  if (!t) return <NoAircraft />;
  const route = g?.route ?? null;
  const assigned = g?.assignedStand && g.assignedStand.airport === ident ? g.assignedStand.stand : null;
  const runways = (details?.runways ?? []).flatMap((r) => r.ends.map((e) => e.ident)).filter(Boolean).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  return (
    <div className={`panel-body ground ${detail ? 'ground--detail' : ''}`}>
      <div className="ground__head">
        <Icon name="moveTo" />
        <div>
          <strong>{ident ?? 'Not at an airport'}</strong>
          <span className="muted">{here ? details?.name ?? '' : destination ? `Destination · ${details?.name ?? ''}` : 'Taxi tools appear when you are on the ground at an airport.'}</span>
        </div>
        {g?.runway && <span className="pill pill--amber">On runway {g.runway}</span>}
      </div>
      {layout?.source === 'generated' && <p className="muted small">Demo aircraft: these taxiways are a simple stand-in, not the real airport.</p>}

      {g?.docking && <Docking d={g.docking} />}
      {route && g && <RouteCard g={g} route={route} />}
      {route && detail && (
        <Section title="Turn by turn">
          <ol className="taxi-steps">
            {route.steps.map((s, i) => (
              <li key={i}>
                <span className="muted num">{fmtM(s.atM)}</span> {s.text}
              </li>
            ))}
          </ol>
        </Section>
      )}

      {!ident && (
        <Empty title="Not on the ground">
          <p>Add a destination airport to the flight plan to pick your arrival stand in advance.</p>
        </Empty>
      )}
      {ident && error && <p className="muted">{error}</p>}
      {here && runways.length > 0 && (
        <Section title="Taxi to a runway">
          <div className="chip-row">
            {runways.map((r) => (
              <Button key={r} size="sm" onClick={() => void attempt(() => api.taxiTo({ airport: here, runway: r }))}>
                {r}
              </Button>
            ))}
          </div>
        </Section>
      )}
      {ident && layout && (
        <Section title={here ? 'Stands' : `Arrival stand at ${ident}`}>
          {assigned && (
            <p className="small">
              Your stand: <strong>{assigned.name}</strong>
            </p>
          )}
          <StandPicker airport={ident} layout={layout} here={!!here} assigned={assigned} />
        </Section>
      )}
    </div>
  );
}
