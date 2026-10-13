import { useState } from 'react';
import { LIGHT_NAMES, type LightName, type Telemetry } from '../../shared/types';
import { act, useSettings, useTelemetry } from '../lib/store';
import { fmtDuration, fmtInt, fmtWeight } from '../lib/format';
import { Button, ModeButton, Readout, Section } from '../components/ui';
import { NoAircraft } from './common';
import type { PanelProps } from './registry';

const LIGHT_LABEL: Record<LightName, string> = {
  nav: 'Nav',
  beacon: 'Beacon',
  strobe: 'Strobe',
  landing: 'Landing',
  taxi: 'Taxi',
  logo: 'Logo',
  wing: 'Wing',
  recognition: 'Recog',
  panel: 'Panel',
  cabin: 'Cabin',
};

function Lights({ t }: { t: Telemetry }) {
  const allOn = (names: LightName[], on: boolean) => names.forEach((light) => act({ type: 'light.set', light, on }));
  return (
    <Section
      title="Lights"
      actions={
        <>
          <Button size="sm" variant="ghost" onClick={() => allOn(['nav', 'beacon', 'strobe', 'landing', 'taxi', 'logo'], true)}>
            All exterior on
          </Button>
          <Button size="sm" variant="ghost" onClick={() => allOn([...LIGHT_NAMES], false)}>
            All off
          </Button>
        </>
      }
    >
      <div className="key-grid">
        {LIGHT_NAMES.map((l) => (
          <ModeButton key={l} on={t.lights[l]} label={LIGHT_LABEL[l]} tone="amber" onClick={() => act({ type: 'light.set', light: l, on: !t.lights[l] })} />
        ))}
      </div>
    </Section>
  );
}

function Controls({ t }: { t: Telemetry }) {
  const s = t.systems;
  return (
    <Section title="Controls">
      <div className="controls">
        {s.gearRetractable && (
          <div className="control">
            <span className="control__label">Gear</span>
            <span className={`control__state ${s.gearPct > 99 ? 'is-green' : s.gearPct > 0 ? 'is-amber' : ''}`}>
              {s.gearPct > 99 ? 'Down' : s.gearPct < 1 ? 'Up' : 'In transit'}
            </span>
            <Button size="sm" onClick={() => act({ type: 'gear.set', down: !s.gearDown })}>
              {s.gearDown ? 'Gear up' : 'Gear down'}
            </Button>
          </div>
        )}
        <div className="control">
          <span className="control__label">Flaps</span>
          <span className="control__state">
            {s.flapsPositions > 0 ? `${s.flapsIndex} of ${s.flapsPositions}` : 'None'}
            <span className="meter" aria-hidden="true">
              <span style={{ width: `${s.flapsPct}%` }} />
            </span>
          </span>
          <div className="chip-row">
            <Button size="sm" icon="minus" aria-label="Flaps up one step" disabled={s.flapsIndex <= 0} onClick={() => act({ type: 'flaps.step', dir: -1 })} />
            <Button size="sm" icon="plus" aria-label="Flaps down one step" disabled={s.flapsIndex >= s.flapsPositions} onClick={() => act({ type: 'flaps.step', dir: 1 })} />
          </div>
        </div>
        {s.spoilersAvailable && (
          <div className="control">
            <span className="control__label">Spoilers</span>
            <span className={`control__state ${s.spoilersArmed ? 'is-amber' : ''}`}>{s.spoilersArmed ? 'Armed' : `${fmtInt(s.spoilersPct)}%`}</span>
            <div className="chip-row">
              <Button size="sm" onClick={() => act({ type: 'spoilers.arm' })}>
                Arm
              </Button>
              <Button size="sm" onClick={() => act({ type: 'spoilers.toggle' })}>
                Extend/retract
              </Button>
            </div>
          </div>
        )}
      </div>
      <div className="key-grid">
        <ModeButton on={s.parkingBrake} tone="amber" label="Parking brake" onClick={() => act({ type: 'parkingBrake.toggle' })} />
        <ModeButton on={s.battery} label="Battery" onClick={() => act({ type: 'battery.toggle' })} />
        <ModeButton on={s.avionics} label="Avionics" onClick={() => act({ type: 'avionics.toggle' })} />
        <ModeButton on={s.pitotHeat} label="Pitot heat" onClick={() => act({ type: 'pitotHeat.toggle' })} />
        <ModeButton on={s.doorPct > 5} tone="amber" label="Main door" onClick={() => act({ type: 'door.toggle' })} />
      </div>
    </Section>
  );
}

function Engines({ t, detail }: { t: Telemetry; detail?: boolean }) {
  const running = t.engines.list.filter((e) => e.running).length;
  const turbine = t.engines.type === 1 || t.engines.type === 5;
  return (
    <Section
      title="Engines"
      actions={
        <>
          <Button size="sm" onClick={() => act({ type: 'engines.autostart' })} title="Runs the aircraft's automatic start-up (Ctrl+E in MSFS)">
            Auto-start
          </Button>
          <Button size="sm" variant="ghost" onClick={() => act({ type: 'engines.shutdown' })}>
            Shut down
          </Button>
        </>
      }
    >
      <p className={running === t.engines.count && running > 0 ? 'status-line is-green' : 'status-line'}>
        {t.engines.count === 0 ? 'No engines' : `${running} of ${t.engines.count} running`}
      </p>
      {detail && t.engines.count > 0 && (
        <table className="table table--compact">
          <thead>
            <tr>
              <th>Engine</th>
              <th className="num">{turbine ? 'N1' : 'RPM'}</th>
              <th className="num">Fuel flow</th>
              <th className="num">Throttle</th>
            </tr>
          </thead>
          <tbody>
            {t.engines.list.map((e, i) => (
              <tr key={i}>
                <td>
                  {i + 1} <span className={e.running ? 'dot is-green' : 'dot'} aria-label={e.running ? 'running' : 'off'} />
                </td>
                <td className="num">{turbine ? `${e.n1.toFixed(1)}%` : fmtInt(e.rpm)}</td>
                <td className="num">{e.fuelFlowGph.toFixed(1)} gal/h</td>
                <td className="num">{fmtInt(e.throttlePct)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}

function Fuel({ t }: { t: Telemetry }) {
  const settings = useSettings();
  const pct = t.fuel.capacityGal > 0 ? (t.fuel.totalGal / t.fuel.capacityGal) * 100 : 0;
  const [target, setTarget] = useState(Math.round(pct));
  const ff = t.engines.list.reduce((a, e) => a + (e.running ? e.fuelFlowGph : 0), 0);
  const enduranceSec = ff > 0.5 ? (t.fuel.totalGal / ff) * 3600 : null;
  return (
    <Section title="Fuel and weight">
      <div className="readout-grid readout-grid--tight">
        <Readout label="Fuel on board" value={`${Math.round(pct)}%`} sub={`${t.fuel.totalGal.toFixed(0)} gal, ${fmtWeight(t.fuel.totalLbs, settings?.units)}`} />
        <Readout label="Endurance" value={enduranceSec ? fmtDuration(enduranceSec) : '—'} sub={ff > 0 ? `at ${ff.toFixed(1)} gal/h` : 'engines off'} />
        <Readout label="Total weight" value={fmtWeight(t.weight.totalLbs, settings?.units)} sub={`max ${fmtWeight(t.weight.maxGrossLbs, settings?.units)}`} tone={t.weight.totalLbs > t.weight.maxGrossLbs ? 'amber' : undefined} />
      </div>
      <div className="fuel-set">
        <label htmlFor="fuel-target">Set fuel to</label>
        <input id="fuel-target" type="range" min={0} max={100} step={5} value={target} onChange={(e) => setTarget(Number(e.target.value))} />
        <output htmlFor="fuel-target">{target}%</output>
        <Button size="sm" onClick={() => act({ type: 'fuel.set', pct: target })}>
          Apply
        </Button>
      </div>
    </Section>
  );
}

export function AircraftPanel({ detail }: PanelProps) {
  const t = useTelemetry();
  if (!t) return <NoAircraft />;
  return (
    <div className={`panel-body aircraft ${detail ? 'aircraft--detail' : ''}`}>
      <p className="aircraft__title" title={t.aircraft.title}>
        {t.aircraft.title || 'Unknown aircraft'}
        {t.aircraft.atcId && <span className="muted"> ({t.aircraft.atcId})</span>}
      </p>
      <Lights t={t} />
      <Controls t={t} />
      <Engines t={t} detail={detail} />
      {detail && <Fuel t={t} />}
    </div>
  );
}
