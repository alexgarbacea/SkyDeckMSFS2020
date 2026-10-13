import { useEffect, useRef, useState } from 'react';
import type { RadioName, Telemetry } from '../../shared/types';
import { act, useSettings, useTelemetry } from '../lib/store';
import { api, type NearbyAirport } from '../lib/api';
import { fmtBaro, fmtDistance, fmtFreq, fmtHeading, HPA_PER_INHG, parseFrequency } from '../lib/format';
import { Button, IconButton, Section, ValueField } from '../components/ui';
import { NoAircraft } from './common';
import type { PanelProps } from './registry';

const RADIO_LABEL: Record<RadioName, string> = { com1: 'COM 1', com2: 'COM 2', nav1: 'NAV 1', nav2: 'NAV 2' };

function RadioRow({ radio, t }: { radio: RadioName; t: Telemetry }) {
  const r = t.radios[radio];
  const com = radio.startsWith('com');
  return (
    <div className="radio-row">
      <span className="radio-row__name">{RADIO_LABEL[radio]}</span>
      <span className="radio-row__active" title="Active frequency">
        {fmtFreq(radio, r.active)}
      </span>
      <IconButton icon="swap" label={`Swap ${RADIO_LABEL[radio]} active and standby`} className="radio-row__swap" onClick={() => act({ type: 'radio.swap', radio })} />
      <ValueField
        label={`${RADIO_LABEL[radio]} standby`}
        value={r.standby}
        format={(v) => fmtFreq(radio, v)}
        parse={(s) => parseFrequency(radio, s)}
        step={com ? 0.025 : 0.05}
        bigStep={1}
        min={com ? 118 : 108}
        max={com ? 136.99 : 117.95}
        onCommit={(mhz) => act({ type: 'radio.set', radio, slot: 'standby', mhz })}
        hint="Type e.g. 121.5 or 1215 and press Enter, or scroll (Shift for whole MHz)."
      />
      <span className="radio-row__extra" title={com ? undefined : 'NAV signal / DME distance'}>
        {!com && 'dmeNm' in r ? (r.hasSignal ? (r.dmeNm != null ? `${fmtDistance(r.dmeNm)} nm` : 'signal') : 'no signal') : ''}
      </span>
    </div>
  );
}

function Transponder({ t }: { t: Telemetry }) {
  const modes = ['Off', 'Standby', 'Test', 'On', 'Alt'];
  return (
    <div className="xpdr">
      <ValueField
        label="Squawk"
        value={Number(t.radios.xpdrCode)}
        format={(v) => String(v).padStart(4, '0')}
        parse={(s) => (/^[0-7]{4}$/.test(s.trim()) ? Number(s.trim()) : null)}
        onCommit={(v) => act({ type: 'xpdr.set', code: String(v).padStart(4, '0') })}
        hint="Four digits, each 0 to 7"
      />
      <span className="xpdr__mode">{modes[t.radios.xpdrState] ?? '—'}</span>
      <div className="chip-row">
        <Button size="sm" onClick={() => act({ type: 'xpdr.ident' })}>
          Ident
        </Button>
        <Button size="sm" onClick={() => act({ type: 'xpdr.set', code: '7000' })} title="VFR code in Europe">
          7000
        </Button>
        <Button size="sm" onClick={() => act({ type: 'xpdr.set', code: '1200' })} title="VFR code in the US">
          1200
        </Button>
      </div>
    </div>
  );
}

function Altimeter({ t }: { t: Telemetry }) {
  const settings = useSettings();
  const hpa = settings?.units.pressure === 'hPa';
  return (
    <div className="baro">
      <ValueField
        label="Altimeter"
        value={hpa ? Math.round(t.environment.baroInHg * HPA_PER_INHG) : t.environment.baroInHg}
        format={(v) => (hpa ? String(Math.round(v)) : v.toFixed(2))}
        unit={hpa ? 'hPa' : 'inHg'}
        step={hpa ? 1 : 0.01}
        bigStep={hpa ? 10 : 0.1}
        min={hpa ? 900 : 26.6}
        max={hpa ? 1100 : 32.5}
        onCommit={(v) => act({ type: 'baro.set', inHg: hpa ? v / HPA_PER_INHG : v })}
      />
      <Button size="sm" onClick={() => act({ type: 'baro.std' })} title="Standard pressure (29.92 inHg / 1013 hPa)">
        STD
      </Button>
      <span className="baro__hint" title="Sea level pressure at the aircraft's position">
        Local {fmtBaro(t.environment.seaLevelPressureMb / HPA_PER_INHG, settings?.units)}
      </span>
    </div>
  );
}

function useNearby(t: Telemetry | null) {
  const [list, setList] = useState<NearbyAirport[]>([]);
  const last = useRef<{ lat: number; lon: number; at: number } | null>(null);
  const lat = t?.position.lat;
  const lon = t?.position.lon;
  useEffect(() => {
    if (lat == null || lon == null) return;
    const prev = last.current;
    const moved = !prev || Math.abs(prev.lat - lat) > 0.08 || Math.abs(prev.lon - lon) > 0.1;
    if (!moved && Date.now() - prev.at < 60000) return;
    last.current = { lat, lon, at: Date.now() };
    api.nearest(lat, lon).then(setList).catch(() => undefined);
  }, [lat, lon]);
  return list;
}

const TUNE_PRIORITY = ['ATIS', 'AWOS', 'ASOS', 'CLD', 'CLEARANCE', 'DEL', 'GND', 'GROUND', 'TWR', 'TOWER', 'CTAF', 'UNIC', 'UNICOM', 'APP', 'APPROACH', 'DEP', 'DEPARTURE'];

function Nearby({ t }: { t: Telemetry }) {
  const list = useNearby(t);
  if (!list.length) return <p className="muted">Looking for nearby airports…</p>;
  return (
    <div className="nearby">
      {list.slice(0, 6).map((a) => {
        const freqs = [...a.frequencies].sort((x, y) => {
          const ix = TUNE_PRIORITY.indexOf(x.type);
          const iy = TUNE_PRIORITY.indexOf(y.type);
          return (ix < 0 ? 99 : ix) - (iy < 0 ? 99 : iy);
        });
        return (
          <div key={a.ident} className="nearby__airport">
            <div className="nearby__head">
              <strong>{a.ident}</strong>
              <span>{a.name}</span>
              <span className="muted">{fmtDistance(a.distNm)} nm</span>
            </div>
            {freqs.length ? (
              <div className="chip-row">
                {freqs.slice(0, 8).map((f, i) => (
                  <button
                    key={i}
                    type="button"
                    className="freq-chip"
                    title={`Put ${f.mhz.toFixed(3)} in COM 1 standby`}
                    onClick={() => act({ type: 'radio.set', radio: 'com1', slot: 'standby', mhz: f.mhz })}
                  >
                    <span>{f.type}</span>
                    {f.mhz.toFixed(3)}
                  </button>
                ))}
              </div>
            ) : (
              <p className="muted">No published frequencies.</p>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function RadiosPanel({ detail }: PanelProps) {
  const t = useTelemetry();
  if (!t) return <NoAircraft />;
  return (
    <div className={`panel-body radios ${detail ? 'radios--detail' : ''}`}>
      <div className="radio-list">
        {(['com1', 'com2', 'nav1', 'nav2'] as RadioName[]).map((r) => (
          <RadioRow key={r} radio={r} t={t} />
        ))}
      </div>
      <div className="radios__misc">
        <Transponder t={t} />
        <Altimeter t={t} />
      </div>
      {detail && (
        <div className="radios__detail">
          <Section title="Courses and ADF">
            <div className="row-wrap">
              <ValueField label="NAV 1 course (OBS)" value={t.radios.nav1.obs} format={fmtHeading} unit="°" step={1} bigStep={10} wrap={360} onCommit={(deg) => act({ type: 'obs.set', nav: 1, deg })} />
              <ValueField label="NAV 2 course (OBS)" value={t.radios.nav2.obs} format={fmtHeading} unit="°" step={1} bigStep={10} wrap={360} onCommit={(deg) => act({ type: 'obs.set', nav: 2, deg })} />
              <ValueField label="ADF" value={t.radios.adfKhz} format={(v) => v.toFixed(1)} unit="kHz" step={1} bigStep={10} min={190} max={1799} onCommit={(khz) => act({ type: 'adf.set', khz })} />
            </div>
          </Section>
          <Section title="Nearby frequencies">
            <p className="muted">Click a frequency to put it in COM 1 standby, then swap it in.</p>
            <Nearby t={t} />
          </Section>
        </div>
      )}
    </div>
  );
}
