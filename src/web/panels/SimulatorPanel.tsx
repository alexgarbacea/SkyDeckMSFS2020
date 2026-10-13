import { useEffect, useState } from 'react';
import type { AirportDetails } from '../../shared/types';
import { act, useStatus, useTelemetry } from '../lib/store';
import { api } from '../lib/api';
import { fmtClock } from '../lib/format';
import { bestRunway, repositionCommand, runwayOptions } from '../lib/reposition';
import { toast } from '../lib/toast';
import { Button, Empty, ModeButton, Section, Segmented } from '../components/ui';
import { PlaceSearch } from '../components/PlaceSearch';
import { NoAircraft } from './common';
import type { PanelProps } from './registry';

const RATES = [0.25, 0.5, 1, 2, 4, 8, 16];
const TIMES = [
  { label: 'Dawn', h: 6 },
  { label: 'Morning', h: 9 },
  { label: 'Noon', h: 12 },
  { label: 'Evening', h: 18 },
  { label: 'Dusk', h: 20 },
  { label: 'Night', h: 23 },
];

function setLocalTime(hour: number, minute: number, localSeconds: number, zuluSeconds: number) {
  const offset = Math.round((localSeconds - zuluSeconds) / 60); // minutes
  let total = hour * 60 + minute - offset;
  total = ((total % 1440) + 1440) % 1440;
  act({ type: 'sim.time', zuluHour: Math.floor(total / 60), zuluMinute: total % 60 });
}

export function Reposition({ compact }: { compact?: boolean }) {
  const t = useTelemetry();
  const [airport, setAirport] = useState<AirportDetails | null>(null);
  const [runway, setRunway] = useState('');
  const [finalNm, setFinalNm] = useState(0);
  const [kts, setKts] = useState(90);

  useEffect(() => {
    if (!airport) return;
    const best = bestRunway(runwayOptions(airport), t?.environment.windDir);
    setRunway(best?.ident ?? '');
    // Only when a new airport is picked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [airport]);

  const options = airport ? runwayOptions(airport) : [];
  const selected = options.find((o) => o.ident === runway);
  return (
    <div className={`reposition ${compact ? 'reposition--compact' : ''}`}>
      <PlaceSearch
        placeholder="Airport, e.g. LGIR or Heraklion"
        kinds={['airport']}
        onPick={(r) => {
          api.airport(r.ident).then(setAirport).catch((e: Error) => toast(e.message, 'error'));
        }}
      />
      {airport && (
        <>
          <p className="reposition__airport">
            <strong>{airport.ident}</strong> {airport.name}
          </p>
          {options.length === 0 ? (
            <p className="muted">No runway data for this airport.</p>
          ) : (
            <div className="reposition__form">
              <label>
                Runway
                <select value={runway} onChange={(e) => setRunway(e.target.value)}>
                  {options.map((o) => (
                    <option key={o.ident} value={o.ident}>
                      {o.ident}
                      {o.lengthFt ? ` (${o.lengthFt.toLocaleString('en-US')} ft)` : ''}
                    </option>
                  ))}
                </select>
              </label>
              <Segmented
                label="Where"
                value={finalNm}
                onChange={setFinalNm}
                options={[
                  { value: 0, label: 'On the runway' },
                  { value: 3, label: '3 nm final' },
                  { value: 5, label: '5 nm final' },
                  { value: 10, label: '10 nm final' },
                ]}
              />
              {finalNm > 0 && (
                <label>
                  Approach speed
                  <input type="number" min={40} max={250} value={kts} onChange={(e) => setKts(Number(e.target.value) || 90)} />
                  <span className="muted">kt</span>
                </label>
              )}
              <Button
                variant="primary"
                icon="moveTo"
                disabled={!selected || !t}
                onClick={() => selected && act(repositionCommand(airport, selected, finalNm, kts))}
              >
                Move aircraft
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function SimulatorPanel({ detail }: PanelProps) {
  const t = useTelemetry();
  const status = useStatus();
  const [timeText, setTimeText] = useState('');
  if (!t) return <NoAircraft />;
  const s = t.sim;
  return (
    <div className={`panel-body sim ${detail ? 'sim--detail' : ''}`}>
      <div className="sim__row">
        <Button variant={s.paused ? 'primary' : 'default'} icon={s.paused ? 'play' : 'pause'} onClick={() => act({ type: 'sim.pause', paused: !s.paused })}>
          {s.paused ? 'Resume' : 'Pause'}
        </Button>
        <div className="sim-rate" aria-label="Simulation rate">
          <span className="sim-rate__label">Sim rate</span>
          <Segmented label="Simulation rate" value={s.rate} onChange={(rate) => act({ type: 'sim.rate', rate })} options={RATES.map((r) => ({ value: r, label: r < 1 ? `${r}×` : `${r}×` }))} />
        </div>
      </div>

      <Section title={`Time of day (local ${fmtClock(s.localSeconds)}, ${fmtClock(s.zuluSeconds)}Z)`}>
        <div className="chip-row">
          {TIMES.map((x) => (
            <Button key={x.label} size="sm" onClick={() => setLocalTime(x.h, 0, s.localSeconds, s.zuluSeconds)}>
              {x.label}
            </Button>
          ))}
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              const m = /^(\d{1,2})[:.h]?(\d{2})?$/.exec(timeText.trim());
              if (!m || Number(m[1]) > 23 || Number(m[2] ?? 0) > 59) {
                toast('Type a local time like 14:30.', 'warning');
                return;
              }
              setLocalTime(Number(m[1]), Number(m[2] ?? 0), s.localSeconds, s.zuluSeconds);
              setTimeText('');
            }}
          >
            <input value={timeText} onChange={(e) => setTimeText(e.target.value)} placeholder="14:30" aria-label="Local time" size={6} />
            <Button size="sm" type="submit">
              Set
            </Button>
          </form>
        </div>
      </Section>

      <Section title="Ground and position">
        <div className="key-grid">
          <ModeButton on={s.slew} tone="amber" label="Slew mode" onClick={() => act({ type: 'sim.slew', on: !s.slew })} title="Move the aircraft freely without flying it" />
          <ModeButton on={t.systems.pushbackState !== 3} tone="amber" label="Pushback" onClick={() => act({ type: 'pushback.toggle' })} title="Start or stop the pushback tug" />
          <ModeButton on={t.systems.parkingBrake} tone="amber" label="Parking brake" onClick={() => act({ type: 'parkingBrake.toggle' })} />
        </div>
      </Section>

      <Section title="Move the aircraft">
        <Reposition compact={!detail} />
      </Section>

      {status?.connection === 'demo' && (
        <Section title="Demo aircraft">
          <Empty title="You are flying the demo aircraft">
            <p>Nothing here reaches MSFS. When the simulator starts, SkyDeck switches over by itself.</p>
          </Empty>
          <Button onClick={() => act({ type: 'demo.stop' })}>Stop the demo</Button>
        </Section>
      )}
    </div>
  );
}
