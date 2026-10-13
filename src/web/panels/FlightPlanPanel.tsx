import { useEffect, useMemo, useState } from 'react';
import type { AirportDetails, FlightPlan, PlanWaypoint, Telemetry } from '../../shared/types';
import { useAvionics, usePlan, useStatus, useTelemetry } from '../lib/store';
import { api } from '../lib/api';
import { toast } from '../lib/toast';
import { fmtDistance, fmtDuration, fmtHeading, fmtInt, fmtLat, fmtLon, parseAltitude } from '../lib/format';
import {
  activeIndex,
  insertWaypoint,
  moveWaypoint,
  planLegs,
  remainingNm,
  removeWaypoint,
  routeOf,
  routeString,
  savePlan,
  setDeparture,
  setDestination,
  updatePlan,
  updateWaypoint,
  waypointFromResult,
} from '../lib/plan';
import { Button, Empty, Icon, IconButton, Section, Segmented, ValueField } from '../components/ui';
import { PlaceSearch } from '../components/PlaceSearch';
import { ImportDialog } from '../components/ImportDialog';
import type { PanelProps } from './registry';

const TYPE_LABEL: Record<PlanWaypoint['type'], string> = { airport: 'Airport', vor: 'VOR', ndb: 'NDB', fix: 'Waypoint', user: 'Custom point' };

export async function sendPlanToSim() {
  try {
    const r = await api.sendPlan();
    if (r.via === 'avionics') {
      toast(`Flight plan loaded into the ${r.avionics}.`, 'success');
      for (const w of r.warnings ?? []) toast(w, 'warning');
    } else if (r.via === 'preflight') {
      toast('Flight plan handed to MSFS. Start the flight and the avionics load it.', 'success');
    } else if (r.via === 'demo') {
      toast('Flight plan loaded into the demo aircraft.', 'success');
    } else {
      toast("Flight plan sent to MSFS. Aircraft with their own avionics (G1000 NXi, G3000, airliners) may ignore it during a flight; SkyDeck Link fixes that for the G1000 NXi.", 'warning');
    }
  } catch (e) {
    toast((e as Error).message, 'error');
  }
}

export async function directTo(waypoint: PlanWaypoint) {
  try {
    await api.directTo({ waypoint });
    toast(`Direct to ${waypoint.ident}. Engage NAV to follow it.`, 'success');
  } catch (e) {
    toast((e as Error).message, 'error');
  }
}

function SendStatus({ plan }: { plan: FlightPlan }) {
  if (plan.sentToSimAt) return <span className="pill pill--green">Sent</span>;
  return <span className="pill pill--amber">Not sent yet</span>;
}

/** What the avionics actually hold, as reported by SkyDeck Link, so the pilot can verify a send. */
function AvionicsSummary() {
  const status = useStatus();
  const avionics = useAvionics();
  const t = useTelemetry();
  if (!status?.link.connected) {
    if (!t || status?.connection !== 'connected') return null;
    return (
      <p className="avionics-line avionics-line--off">
        Aircraft with glass-cockpit avionics only read new flight plans when a flight starts. For the G1000 NXi, install SkyDeck Link in Settings.
      </p>
    );
  }
  if (!avionics?.ready) return <p className="avionics-line">{status.link.avionics} linked, waiting for it to start…</p>;
  const route = [avionics.origin, avionics.departure, avionics.arrival, avionics.approach, avionics.destination].filter(Boolean);
  return (
    <p className="avionics-line" title="The flight plan currently loaded in the avionics">
      <span className="avionics-line__name">{status.link.avionics}</span>
      {route.length ? route.join(', ') : 'No flight plan loaded'}
      {avionics.legs?.length ? <span className="muted"> ({avionics.legs.length} legs)</span> : null}
    </p>
  );
}

function PlanHeader({ plan, t, onImport }: { plan: FlightPlan; t: Telemetry | null; onImport: () => void }) {
  const status = useStatus();
  // Totals follow the route the aircraft flies, including SID/STAR/approach fixes.
  const total = planLegs({ ...plan, waypoints: routeOf(plan) }).at(-1)?.cumulativeNm ?? 0;
  const remaining = remainingNm(plan, t);
  const gs = t && t.speed.gs > 40 ? t.speed.gs : null;
  const dep = plan.waypoints[0];
  const dest = plan.waypoints.length > 1 ? plan.waypoints[plan.waypoints.length - 1] : null;
  return (
    <div className="plan-head">
      <div className="plan-head__route">
        <span className="plan-head__ident">{dep?.ident ?? '—'}</span>
        <svg className="plan-head__line" viewBox="0 0 60 10" aria-hidden="true">
          <path d="M2 5h52M50 1l5 4-5 4" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
        <span className="plan-head__ident">{dest?.ident ?? '—'}</span>
        <SendStatus plan={plan} />
      </div>
      <AvionicsSummary />
      <div className="plan-head__stats">
        <span>
          <b>{fmtDistance(total)}</b> nm
        </span>
        {remaining != null && (
          <span>
            <b className="tone-magenta">{fmtDistance(remaining)}</b> nm to go
          </span>
        )}
        {gs && remaining != null && (
          <span>
            ETE <b className="tone-magenta">{fmtDuration((remaining / gs) * 3600)}</b>
          </span>
        )}
        <span className="plan-head__cruise">
          Cruise
          <ValueField
            label="Cruise altitude"
            value={plan.cruiseAltFt}
            format={(v) => fmtInt(v)}
            parse={parseAltitude}
            unit="ft"
            step={500}
            bigStep={1000}
            min={500}
            max={60000}
            onCommit={(v) => void updatePlan({ cruiseAltFt: v })}
          />
        </span>
      </div>
      <div className="plan-head__actions">
        <Button variant="primary" icon="send" disabled={plan.waypoints.length < 2 || status?.connection === 'searching'} onClick={() => void sendPlanToSim()} title="Loads this plan into the aircraft's GPS / FMS">
          Send to aircraft
        </Button>
        <Button icon="upload" onClick={onImport}>
          Import
        </Button>
        <a className="btn btn--ghost btn--md" href="/api/plan/export.pln" download>
          <Icon name="download" />
          <span>Save .PLN</span>
        </a>
        <Button
          variant="ghost"
          icon="trash"
          onClick={() => {
            if (confirm('Clear the whole flight plan?')) void savePlan(null);
          }}
        >
          Clear
        </Button>
      </div>
    </div>
  );
}

/** How the aircraft gets to waypoint i: runway, SID, airway, STAR + approach, or direct. */
function viaText(plan: FlightPlan, w: PlanWaypoint, i: number): string {
  const p = plan.procedures;
  if (i === 0) return p.departureRunway ? `RWY ${p.departureRunway}` : '';
  if (i === plan.waypoints.length - 1) return [p.star, p.approach].filter(Boolean).join(' + ') || w.airway || 'Direct';
  if (i === 1 && p.sid) return p.sid;
  return w.airway ?? 'Direct';
}

function WaypointList({ plan, t, detail }: { plan: FlightPlan; t: Telemetry | null; detail?: boolean }) {
  const legs = planLegs(plan);
  const active = activeIndex(plan, t);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const flying = !!t;
  const magVar = t?.attitude.magVar ?? 0;

  return (
    <div className="wpt-table-wrap">
      <table className={`table wpt-table ${detail ? 'wpt-table--detail' : ''}`}>
        <thead>
          <tr>
            <th aria-label="Reorder" />
            <th>Waypoint</th>
            <th>Via</th>
            <th className="num">Course</th>
            <th className="num">Leg</th>
            {detail && <th className="num">Total</th>}
            {detail && <th>Position</th>}
            {detail && <th className="num">Altitude</th>}
            <th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {plan.waypoints.map((w, i) => {
            const leg = i > 0 ? legs[i - 1] : null;
            const isActive = i === active;
            const isPast = active > 0 && i < active;
            return (
              <tr
                key={w.id}
                className={`${isActive ? 'is-active' : ''} ${isPast ? 'is-past' : ''} ${dragOver === i ? 'is-drop' : ''}`}
                draggable
                onDragStart={(e) => {
                  setDragFrom(i);
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(i);
                }}
                onDragLeave={() => setDragOver(null)}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragFrom != null && dragFrom !== i) void moveWaypoint(dragFrom, i);
                  setDragFrom(null);
                  setDragOver(null);
                }}
                onDragEnd={() => {
                  setDragFrom(null);
                  setDragOver(null);
                }}
              >
                <td className="wpt-table__grip" title="Drag to reorder">
                  <Icon name="grip" size={14} />
                </td>
                <td>
                  <span className="wpt-ident">{w.ident}</span>
                  <span className="wpt-type">{w.type === 'airport' && w.name ? w.name : TYPE_LABEL[w.type]}</span>
                </td>
                <td className="muted">{viaText(plan, w, i)}</td>
                <td className="num">{leg ? `${fmtHeading(leg.courseTrue - magVar)}°` : ''}</td>
                <td className="num">{leg ? fmtDistance(leg.distNm) : ''}</td>
                {detail && <td className="num">{leg ? fmtDistance(leg.cumulativeNm) : ''}</td>}
                {detail && (
                  <td className="muted small">
                    {fmtLat(w.lat)} {fmtLon(w.lon)}
                  </td>
                )}
                {detail && (
                  <td className="num">
                    {w.type === 'airport' ? (
                      <span className="muted">{w.altFt != null ? `${fmtInt(w.altFt)} ft` : ''}</span>
                    ) : (
                      <input
                        className="cell-input"
                        defaultValue={w.altFt != null ? String(w.altFt) : ''}
                        placeholder="—"
                        aria-label={`Altitude at ${w.ident}`}
                        onBlur={(e) => {
                          const v = e.target.value.trim() ? parseAltitude(e.target.value) : null;
                          if (v !== (w.altFt ?? null)) void updateWaypoint(w.id, { altFt: v });
                        }}
                      />
                    )}
                  </td>
                )}
                <td className="wpt-table__actions">
                  {flying && <IconButton icon="direct" label={`Direct to ${w.ident}`} onClick={() => void directTo(w)} />}
                  <IconButton icon="close" label={`Remove ${w.ident}`} onClick={() => void removeWaypoint(w.id)} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function AddWaypoint() {
  return (
    <div className="plan-add">
      <PlaceSearch placeholder="Add a waypoint: airport, VOR, NDB or fix" onPick={(r) => void insertWaypoint(waypointFromResult(r))} />
      <p className="muted small">Added before the destination. Drag rows to reorder, or right-click the map to add a point.</p>
    </div>
  );
}

function NewPlan({ onImport }: { onImport: () => void }) {
  const plan = usePlan();
  const dep = plan?.waypoints[0];
  return (
    <div className="panel-body plan-new">
      <Empty title="No flight plan yet">
        <p>Pick a departure and a destination, then add waypoints in between. Or import a plan you already made.</p>
      </Empty>
      <div className="plan-new__fields">
        <label className="field">
          <span>From {dep && <b className="tone-cyan">{dep.ident}</b>}</span>
          <PlaceSearch placeholder="Departure airport" kinds={['airport']} onPick={(r) => void setDeparture(waypointFromResult(r))} />
        </label>
        <label className="field">
          <span>To</span>
          <PlaceSearch placeholder="Destination airport" kinds={['airport']} onPick={(r) => void setDestination(waypointFromResult(r))} />
        </label>
      </div>
      <div className="chip-row">
        <Button icon="upload" onClick={onImport}>
          Import from SimBrief, MSFS or a file
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Detail: procedures + profile

function useAirport(ident: string | undefined) {
  const [airport, setAirport] = useState<AirportDetails | null>(null);
  const status = useStatus();
  useEffect(() => {
    setAirport(null);
    if (!ident) return;
    api.airport(ident).then(setAirport).catch(() => setAirport(null));
  }, [ident, status?.connection]);
  return airport;
}

function Picker({ label, value, options, onChange, empty = 'None' }: { label: string; value?: string; options: string[]; onChange: (v: string | undefined) => void; empty?: string }) {
  return (
    <label className="field field--select">
      <span>{label}</span>
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value || undefined)}>
        <option value="">{empty}</option>
        {value && !options.includes(value) && <option value={value}>{value}</option>}
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}

function Procedures({ plan }: { plan: FlightPlan }) {
  const dep = plan.waypoints[0];
  const dest = plan.waypoints[plan.waypoints.length - 1];
  const depAirport = useAirport(dep?.type === 'airport' ? dep.ident : undefined);
  const destAirport = useAirport(dest?.type === 'airport' && plan.waypoints.length > 1 ? dest.ident : undefined);
  const p = plan.procedures;
  const set = (patch: Partial<FlightPlan['procedures']>) => void updatePlan({ procedures: { ...p, ...patch } });
  const runways = (a: AirportDetails | null) => (a ? a.runways.flatMap((r) => r.ends.map((e) => e.ident)).filter(Boolean).sort() : []);
  const forRunway = (list: { name: string; runways: string[] }[] | undefined, rwy?: string) =>
    (list ?? []).filter((x) => !rwy || x.runways.includes('ALL') || x.runways.includes(rwy)).map((x) => x.name);
  const noProcedures = (a: AirportDetails | null) => a && !a.procedures;

  return (
    <div className="procedures">
      <Section title={`Departure${depAirport ? `: ${depAirport.ident}` : ''}`}>
        {dep?.type !== 'airport' ? (
          <p className="muted">The plan does not start at an airport.</p>
        ) : (
          <div className="procedures__grid">
            <Picker label="Runway" value={p.departureRunway} options={runways(depAirport)} onChange={(v) => set({ departureRunway: v, sid: undefined })} />
            <Picker label="SID" value={p.sid} options={forRunway(depAirport?.procedures?.departures, p.departureRunway)} onChange={(v) => set({ sid: v })} />
          </div>
        )}
        {noProcedures(depAirport) && <p className="muted small">SIDs come from MSFS. Connect the sim to choose one.</p>}
      </Section>
      <Section title={`Arrival${destAirport ? `: ${destAirport.ident}` : ''}`}>
        {dest?.type !== 'airport' || plan.waypoints.length < 2 ? (
          <p className="muted">The plan does not end at an airport.</p>
        ) : (
          <div className="procedures__grid">
            <Picker label="STAR" value={p.star} options={forRunway(destAirport?.procedures?.arrivals)} onChange={(v) => set({ star: v })} />
            <Picker
              label="Approach"
              value={p.approach}
              options={(destAirport?.procedures?.approaches ?? []).map((a) => a.name)}
              onChange={(v) => {
                const rw = destAirport?.procedures?.approaches.find((a) => a.name === v)?.runways[0];
                set({ approach: v, arrivalRunway: rw && rw !== 'ALL' ? rw : p.arrivalRunway });
              }}
            />
            <Picker label="Landing runway" value={p.arrivalRunway} options={runways(destAirport)} onChange={(v) => set({ arrivalRunway: v })} />
          </div>
        )}
        {noProcedures(destAirport) && <p className="muted small">STARs and approaches come from MSFS. Connect the sim to choose them.</p>}
      </Section>
    </div>
  );
}

function Profile({ plan, t }: { plan: FlightPlan; t: Telemetry | null }) {
  const legs = planLegs(plan);
  const total = legs.at(-1)?.cumulativeNm ?? 0;
  const pts = useMemo(() => {
    if (total <= 0) return [];
    const dep = plan.waypoints[0];
    const dest = plan.waypoints[plan.waypoints.length - 1];
    const startAlt = dep.type === 'airport' ? dep.altFt ?? 0 : plan.cruiseAltFt;
    const endAlt = dest.type === 'airport' ? dest.altFt ?? 0 : plan.cruiseAltFt;
    // Climb ~500 ft/nm, descend on a 3° path (~318 ft/nm), never above cruise.
    return [0, ...legs.map((l) => l.cumulativeNm)].map((d, i) => {
      const wp = plan.waypoints[i];
      const profile = Math.min(plan.cruiseAltFt, startAlt + d * 500, endAlt + (total - d) * 318);
      return { d, alt: wp.altFt != null && wp.type !== 'airport' ? wp.altFt : profile, ident: wp.ident };
    });
  }, [plan, legs, total]);
  if (pts.length < 2) return null;
  const W = 800;
  const H = 150;
  const maxAlt = Math.max(plan.cruiseAltFt, ...pts.map((p) => p.alt)) * 1.15 || 1000;
  const x = (d: number) => 20 + (d / total) * (W - 40);
  const y = (a: number) => H - 20 - (a / maxAlt) * (H - 40);
  const remaining = remainingNm(plan, t);
  const flown = remaining != null ? total - remaining : null;
  return (
    <Section title="Vertical profile">
      <svg className="profile" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Planned altitude along the route">
        <line x1="20" x2={W - 20} y1={H - 20} y2={H - 20} stroke="var(--rule)" />
        <line x1="20" x2={W - 20} y1={y(plan.cruiseAltFt)} y2={y(plan.cruiseAltFt)} stroke="var(--cyan-dim)" strokeDasharray="4 4" />
        <polyline fill="none" stroke="var(--magenta)" strokeWidth="2" points={pts.map((p) => `${x(p.d)},${y(p.alt)}`).join(' ')} vectorEffect="non-scaling-stroke" />
        {pts.map((p, i) => (
          <g key={i}>
            <circle cx={x(p.d)} cy={y(p.alt)} r="3" fill="var(--magenta)" />
            <text x={x(p.d)} y={H - 6} fontSize="10" textAnchor="middle" fill="var(--ink-2)">
              {p.ident}
            </text>
          </g>
        ))}
        {flown != null && t && <path d={`M${x(flown)} ${y(t.position.altFt) - 7} l6 7 l-6 7 l-6 -7z`} fill="var(--ink)" />}
      </svg>
    </Section>
  );
}

export function FlightPlanPanel({ detail }: PanelProps) {
  const plan = usePlan();
  const t = useTelemetry();
  const [importing, setImporting] = useState(false);
  const dialog = importing && <ImportDialog onClose={() => setImporting(false)} />;

  if (!plan || plan.waypoints.length < 2) {
    return (
      <>
        <NewPlan onImport={() => setImporting(true)} />
        {plan && plan.waypoints.length === 1 && <AddWaypoint />}
        {dialog}
      </>
    );
  }
  return (
    <div className={`panel-body plan ${detail ? 'plan--detail' : ''}`}>
      <PlanHeader plan={plan} t={t} onImport={() => setImporting(true)} />
      {detail ? (
        <div className="plan__detail">
          <div className="plan__main">
            <WaypointList plan={plan} t={t} detail />
            <AddWaypoint />
            <Profile plan={plan} t={t} />
          </div>
          <aside className="plan__side">
            <Procedures plan={plan} />
            <Section title="Flight">
              <Segmented label="Flight rules" value={plan.rules} onChange={(rules) => void updatePlan({ rules })} options={[{ value: 'IFR', label: 'IFR' }, { value: 'VFR', label: 'VFR' }]} />
              <p className="muted small">Source: {plan.source}</p>
            </Section>
            <Section title="Route">
              <p className="route-string">{routeString(plan)}</p>
            </Section>
          </aside>
        </div>
      ) : (
        <>
          <WaypointList plan={plan} t={t} />
          <AddWaypoint />
        </>
      )}
      {dialog}
    </div>
  );
}

/** Used by the command bar. */
export function startDirectTo(ident: string) {
  api
    .directTo({ ident })
    .then(() => toast(`Direct to ${ident.toUpperCase()}. Engage NAV to follow it.`, 'success'))
    .catch((e: Error) => toast(e.message, 'error'));
}
