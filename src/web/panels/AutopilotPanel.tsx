import type { ApToggle, Telemetry } from '../../shared/types';
import { act, usePlan, useTelemetry } from '../lib/store';
import { fmtHeading, fmtInt, fmtVs, parseAltitude } from '../lib/format';
import { Button, Empty, ModeButton, Section, ValueField } from '../components/ui';
import { NoAircraft } from './common';
import type { PanelProps } from './registry';

const toggle = (mode: ApToggle) => act({ type: 'ap.toggle', mode });

function ModeKeys({ ap }: { ap: Telemetry['autopilot'] }) {
  return (
    <div className="ap-modes">
      <div className="ap-modes__group" aria-label="Lateral modes">
        <ModeButton on={ap.hdgMode} label="HDG" onClick={() => toggle('hdg')} title="Heading: follow the heading bug" />
        <ModeButton on={ap.navMode} label="NAV" onClick={() => toggle('nav')} title="Navigation: follow the GPS route or a VOR, depending on the CDI source" />
        <ModeButton on={ap.aprMode} label="APR" onClick={() => toggle('apr')} title="Approach: track the localizer / glidepath" />
        <ModeButton on={ap.bcMode} label="BC" onClick={() => toggle('bc')} title="Back course" />
        <ModeButton on={ap.levelMode} label="LVL" onClick={() => toggle('level')} title="Wing leveler" />
      </div>
      <div className="ap-modes__group" aria-label="Vertical modes">
        <ModeButton on={ap.altMode} label="ALT" onClick={() => toggle('alt')} title="Altitude hold" />
        <ModeButton on={ap.vsMode} label="VS" onClick={() => toggle('vs')} title="Vertical speed: climb or descend at the selected rate" />
        <ModeButton on={ap.flcMode} label="FLC" onClick={() => toggle('flc')} title="Flight level change: climb or descend holding the selected speed" />
        <ModeButton on={ap.spdMode} label="SPD" onClick={() => toggle('spd')} title="Airspeed hold" />
      </div>
    </div>
  );
}

function Selectors({ t, size }: { t: Telemetry; size: 'md' | 'lg' }) {
  const ap = t.autopilot;
  return (
    <div className={`ap-selectors ap-selectors--${size}`}>
      <ValueField
        label="Heading"
        value={ap.hdg}
        format={fmtHeading}
        unit="°"
        step={1}
        bigStep={10}
        wrap={360}
        size={size}
        onCommit={(v) => act({ type: 'ap.set', key: 'hdg', value: v })}
        hint="Scroll or use −/+ (hold Shift for 10°). Click to type."
      />
      <ValueField
        label="Altitude"
        value={ap.alt}
        format={(v) => fmtInt(v)}
        parse={parseAltitude}
        unit="ft"
        step={100}
        bigStep={1000}
        min={0}
        max={60000}
        size={size}
        onCommit={(v) => act({ type: 'ap.set', key: 'alt', value: v })}
        hint="Scroll or use −/+ (hold Shift for 1,000 ft). Type FL120 for flight levels."
      />
      <ValueField
        label="Vertical speed"
        value={ap.vs}
        format={fmtVs}
        unit="fpm"
        step={100}
        bigStep={500}
        min={-6000}
        max={6000}
        size={size}
        onCommit={(v) => act({ type: 'ap.set', key: 'vs', value: v })}
      />
      <ValueField
        label="Speed"
        value={ap.spd}
        format={(v) => fmtInt(v)}
        unit="kt"
        step={1}
        bigStep={10}
        min={0}
        max={999}
        size={size}
        onCommit={(v) => act({ type: 'ap.set', key: 'spd', value: v })}
      />
    </div>
  );
}

export function AutopilotPanel({ detail }: PanelProps) {
  const t = useTelemetry();
  const plan = usePlan();
  if (!t) return <NoAircraft />;
  const ap = t.autopilot;
  if (!ap.available) {
    return (
      <Empty title="This aircraft has no autopilot">
        <p>Pick an aircraft with an autopilot in MSFS (most G1000 and airliner models have one) to use this panel.</p>
      </Empty>
    );
  }
  const hdgNow = Math.round(t.attitude.hdgMag);
  return (
    <div className={`panel-body ap ${detail ? 'ap--detail' : ''}`}>
      <div className="ap-engage">
        <ModeButton wide on={ap.master} label="AP" onClick={() => toggle('master')} title="Autopilot master" />
        <ModeButton on={ap.flightDirector} label="FD" onClick={() => toggle('flightDirector')} title="Flight director" />
        <ModeButton on={ap.yawDamper} label="YD" onClick={() => toggle('yawDamper')} title="Yaw damper" />
        <ModeButton on={ap.autothrottle} label="A/THR" onClick={() => toggle('autothrottle')} title="Autothrottle arm" />
        <ModeButton
          tone="cyan"
          on={ap.gpsDrivesNav}
          label={ap.gpsDrivesNav ? 'CDI GPS' : 'CDI NAV'}
          onClick={() => toggle('cdiSource')}
          title="What NAV mode follows: the GPS flight plan or the NAV1 radio"
        />
      </div>
      <Selectors t={t} size={detail ? 'lg' : 'md'} />
      <ModeKeys ap={ap} />
      {detail && (
        <div className="ap-detail">
          <Section title="Quick targets">
            <div className="chip-row">
              <Button size="sm" icon="sync" onClick={() => act({ type: 'ap.set', key: 'hdg', value: hdgNow })}>
                Heading bug to current ({fmtHeading(hdgNow)}°)
              </Button>
              {t.gps.hasPlan && (
                <Button size="sm" onClick={() => act({ type: 'ap.set', key: 'hdg', value: t.gps.bearingMag })}>
                  Heading bug to {t.gps.nextId || 'next waypoint'} ({fmtHeading(t.gps.bearingMag)}°)
                </Button>
              )}
              <Button size="sm" onClick={() => act({ type: 'ap.set', key: 'alt', value: Math.round(t.position.indicatedAltFt / 100) * 100 })}>
                Altitude to current
              </Button>
              {plan && (
                <Button size="sm" onClick={() => act({ type: 'ap.set', key: 'alt', value: plan.cruiseAltFt })}>
                  Altitude to cruise ({fmtInt(plan.cruiseAltFt)} ft)
                </Button>
              )}
              {[-1000, -500, 500, 1000].map((vs) => (
                <Button key={vs} size="sm" onClick={() => act({ type: 'ap.set', key: 'vs', value: vs })}>
                  VS {fmtVs(vs)}
                </Button>
              ))}
              <Button size="sm" onClick={() => act({ type: 'ap.set', key: 'spd', value: Math.round(t.speed.ias) })}>
                Speed to current ({fmtInt(t.speed.ias)} kt)
              </Button>
            </div>
          </Section>
          <Section title="How the modes work">
            <dl className="explain">
              <dt>HDG</dt>
              <dd>Turns to and holds the cyan heading bug.</dd>
              <dt>NAV</dt>
              <dd>Follows the magenta GPS route when the CDI is on GPS, or the NAV1 radio course when it is on NAV.</dd>
              <dt>APR</dt>
              <dd>Captures the localizer and glideslope (or RNAV glidepath) of the loaded approach.</dd>
              <dt>VS / FLC</dt>
              <dd>Climb or descend to the selected altitude, at a fixed rate (VS) or a fixed speed (FLC). ALT holds it when reached.</dd>
            </dl>
          </Section>
        </div>
      )}
    </div>
  );
}
