import { useEffect, useRef, useState } from 'react';
import type { AtcMessage, AtcState, Telemetry } from '../../shared/types';
import { act, getState, send, useAtc, useSettings, useTelemetry } from '../lib/store';
import { api } from '../lib/api';
import { toast } from '../lib/toast';
import { Button, Empty, Section } from '../components/ui';
import { NoAircraft } from './common';
import type { PanelProps } from './registry';

const fmtMhz = (mhz: number) => mhz.toFixed(3);

async function call(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e) {
    toast((e as Error).message, 'error');
  }
}

const onFreq = (a: number, b: number) => Math.abs(a - b) < 0.004;

/**
 * Tunes COM 1. When the simulator's own ATC holds COM 1 on its frequency (its auto-tune assistance does that),
 * COM 2 is used instead.
 */
async function tune(mhz: number) {
  await send({ type: 'radio.set', radio: 'com1', slot: 'active', mhz }).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 1500));
  const radios = getState().telemetry?.radios;
  if (!radios || onFreq(radios.com1.active, mhz) || onFreq(radios.com2.active, mhz)) return;
  await send({ type: 'radio.set', radio: 'com2', slot: 'active', mhz }).catch(() => undefined);
  toast("MSFS keeps COM 1 on its own ATC frequency, so SkyDeck tuned COM 2. To use COM 1, turn off the simulator's ATC auto-tune assistance.", 'warning');
}

function StartAtc({ t }: { t: Telemetry }) {
  const settings = useSettings();
  const [callsign, setCallsign] = useState(settings?.atcCallsign ?? '');
  const [starting, setStarting] = useState(false);
  return (
    <div className="panel-body atc atc--off">
      <Empty title="Text ATC">
        <p>
          Talk to controllers from the gate to the gate: clearance, ground, tower, departure, area control, approach and back
          to your stand. Pick what to say from the buttons; ATC answers in the log.
        </p>
        <p>SkyDeck uses your flight plan for the departure and destination. Without one, it sets up a local VFR flight from the airport you are at.</p>
        <p className="muted small">Turn off the simulator's own ATC voice so the two don't talk over each other.</p>
      </Empty>
      <form
        className="atc__start"
        onSubmit={(e) => {
          e.preventDefault();
          setStarting(true);
          void call(async () => {
            if ((settings?.atcCallsign ?? '') !== callsign.trim()) await api.saveSettings({ atcCallsign: callsign.trim() });
            await api.atcStart();
          }).finally(() => setStarting(false));
        }}
      >
        <label className="field">
          <span>Callsign</span>
          <input value={callsign} onChange={(e) => setCallsign(e.target.value.toUpperCase())} placeholder={t.aircraft.atcId || 'N123AB'} maxLength={10} aria-describedby="atc-callsign-hint" />
        </label>
        <Button variant="primary" type="submit" disabled={starting}>
          {starting ? 'Starting…' : 'Start ATC'}
        </Button>
      </form>
      <p id="atc-callsign-hint" className="muted small">Leave the callsign empty to use the aircraft's registration ({t.aircraft.atcId || 'none set'}).</p>
    </div>
  );
}

function StationBar({ atc, t }: { atc: AtcState; t: Telemetry }) {
  const st = atc.station;
  if (!st) {
    return (
      <div className="atc-station atc-station--none">
        <span className="atc-station__name">No controller</span>
        <span className="muted">Monitoring</span>
      </div>
    );
  }
  return (
    <div className={`atc-station ${atc.tuned ? 'is-tuned' : 'is-untuned'}`}>
      <div className="atc-station__who">
        <span className="atc-station__role">{st.role === 'unicom' ? 'Self-announce' : 'Talking to'}</span>
        <span className="atc-station__name">{st.name}</span>
      </div>
      <span className="atc-station__freq" title={atc.tuned ? 'Tuned' : `COM 1 is on ${fmtMhz(t.radios.com1.active)}`}>
        {fmtMhz(st.mhz)}
      </span>
      {atc.tuned ? (
        <span className="pill pill--green">Tuned</span>
      ) : (
        <Button size="sm" variant="primary" onClick={() => void tune(st.mhz)} title="Put this frequency in COM 1 active (COM 2 if the simulator holds COM 1)">
          Tune
        </Button>
      )}
    </div>
  );
}

function Assigned({ atc, t }: { atc: AtcState; t: Telemetry }) {
  const a = atc.assigned;
  const wrongSquawk = a.squawk && t.radios.xpdrCode !== a.squawk;
  const items: Array<[string, string]> = [];
  if (a.runway) items.push(['Runway', a.runway]);
  if (a.altitudeFt != null) items.push(['Altitude', a.altitudeFt >= 18000 || (a.altitudeFt > 6000 && !/^[KCP]/.test(atc.departure ?? '')) ? `FL${String(Math.round(a.altitudeFt / 100)).padStart(3, '0')}` : `${a.altitudeFt.toLocaleString('en-US')} ft`]);
  if (a.stand) items.push(['Stand', a.stand]);
  if (!items.length && !a.squawk) return null;
  return (
    <div className="atc-assigned">
      {items.map(([k, v]) => (
        <span key={k} className="atc-assigned__item">
          <small>{k}</small>
          {v}
        </span>
      ))}
      {a.squawk && (
        <span className={`atc-assigned__item ${wrongSquawk ? 'is-wrong' : ''}`}>
          <small>Squawk</small>
          {a.squawk}
          {wrongSquawk && (
            <Button size="sm" onClick={() => act({ type: 'xpdr.set', code: a.squawk! })} title={`The transponder shows ${t.radios.xpdrCode}`}>
              Set
            </Button>
          )}
        </span>
      )}
    </div>
  );
}

function Message({ m }: { m: AtcMessage }) {
  return (
    <li className={`atc-msg atc-msg--${m.from} ${m.level === 'warning' ? 'atc-msg--warning' : ''}`}>
      <span className="atc-msg__meta">
        {m.from === 'atc' ? m.station : m.from === 'pilot' ? 'You' : m.level === 'warning' ? 'Warning' : 'SkyDeck'}
        {m.mhz != null && <span className="atc-msg__freq">{fmtMhz(m.mhz)}</span>}
        <time dateTime={new Date(m.time).toISOString()}>{new Date(m.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
      </span>
      <span className="atc-msg__text">{m.text}</span>
    </li>
  );
}

function Transcript({ messages }: { messages: AtcMessage[] }) {
  const ref = useRef<HTMLOListElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages.length]);
  return (
    <ol
      ref={ref}
      className="atc-log"
      aria-live="polite"
      aria-label="Radio log"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
    >
      {messages.map((m) => (
        <Message key={m.id} m={m} />
      ))}
    </ol>
  );
}

export function AtcPanel({ detail }: PanelProps) {
  const atc = useAtc();
  const t = useTelemetry();
  const [sending, setSending] = useState(false);
  if (!t && !atc?.active) return <NoAircraft />;
  if (!atc?.active) return t ? <StartAtc t={t} /> : <NoAircraft />;
  if (!t) return <NoAircraft />;

  const primary = atc.requests.find((r) => r.primary);
  const say = (id: string) => {
    setSending(true);
    void call(() => api.atcRequest(id)).finally(() => setSending(false));
  };
  return (
    <div className={`panel-body atc ${detail ? 'atc--detail' : ''}`}>
      <StationBar atc={atc} t={t} />
      <div className="atc-phase">
        <strong>{atc.phaseLabel}</strong>
        <span className="atc-phase__route">
          {atc.callsign} · {atc.rules} {atc.departure}
          {atc.destination && atc.destination !== atc.departure ? ` → ${atc.destination}` : ''}
        </span>
      </div>
      {atc.hint && <p className="atc-hint">{atc.hint}</p>}
      <Assigned atc={atc} t={t} />

      <div className="atc-requests" role="group" aria-label="What to say">
        {atc.requests.map((r) => (
          <Button
            key={r.id}
            variant={r.primary ? 'primary' : 'default'}
            size={r.primary ? 'md' : 'sm'}
            disabled={atc.busy || sending || (!!atc.station && !atc.tuned)}
            onClick={() => say(r.id)}
            title={r.text}
          >
            {r.label}
          </Button>
        ))}
        {atc.busy && <span className="atc-requests__wait muted">ATC is answering…</span>}
      </div>
      {primary && (
        <p className="atc-say">
          <small>You will say</small>
          {primary.text}
        </p>
      )}

      <Transcript messages={atc.transcript} />

      {atc.atis && (detail || ['preflight', 'approach', 'vfr-enroute', 'enroute'].includes(atc.phase)) && (
        <Section title={`ATIS ${atc.atis.airport} · information ${atc.atis.letter}${atc.atis.mhz ? ` · ${fmtMhz(atc.atis.mhz)}` : ''}`} className="atc-atis">
          <p>{atc.atis.text}</p>
        </Section>
      )}
      <div className="atc__foot">
        <Button size="sm" variant="ghost" onClick={() => void call(() => api.atcStop())}>
          Stop ATC
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void call(() => api.atcStart())} title="Start over from the current position and flight plan">
          Restart
        </Button>
      </div>
    </div>
  );
}
