import { useEffect, useRef, useState } from 'react';
import type { Telemetry } from '../../shared/types';
import { act, useApp, useSettings, useStatus, useTelemetry } from '../lib/store';
import { fmtHeading, fmtInt, fmtVs } from '../lib/format';
import { openPanel } from '../lib/workspace';
import { PANELS } from '../panels/registry';
import { PRESETS, resetLayout, switchLayout } from './Workspace';
import { Icon, IconButton } from './ui';

/** Flight mode annunciator: which autopilot modes are engaged, like the strip at the top of a PFD. */
function Fma({ t }: { t: Telemetry }) {
  const ap = t.autopilot;
  if (!ap.available) return <div className="fma fma--none">No autopilot</div>;
  const lateral = ap.aprMode ? (ap.gpsDrivesNav ? 'GPS APR' : 'LOC') : ap.navMode ? (ap.gpsDrivesNav ? 'GPS' : 'VOR') : ap.bcMode ? 'BC' : ap.hdgMode ? 'HDG' : ap.levelMode ? 'LVL' : ap.master ? 'ROL' : '';
  const vertical = ap.glideslopeActive ? 'GS' : ap.flcMode ? `FLC ${fmtInt(ap.spd)}KT` : ap.vsMode ? `VS ${fmtVs(ap.vs)}FPM` : ap.altMode ? `ALT ${fmtInt(ap.alt)}FT` : ap.master ? 'PIT' : '';
  return (
    <div className="fma" aria-label="Engaged autopilot modes">
      <span className={`fma__cell fma__cell--ap ${ap.master ? 'is-on' : ''}`}>{ap.master ? 'AP' : 'AP off'}</span>
      {ap.yawDamper && <span className="fma__cell is-on">YD</span>}
      <span className={`fma__cell fma__cell--mode ${lateral ? 'is-on' : ''}`}>{lateral || '—'}</span>
      <span className={`fma__cell fma__cell--mode ${vertical ? 'is-on' : ''}`}>{vertical || '—'}</span>
      <span className="fma__cell fma__cell--sel" title="Selected altitude">
        {fmtInt(ap.alt)}
        <small>FT</small>
      </span>
    </div>
  );
}

function KeyReadouts({ t }: { t: Telemetry }) {
  return (
    <div className="glare-readouts">
      <span title="Indicated airspeed">
        <small>IAS</small>
        {fmtInt(t.speed.ias)}
      </span>
      <span title="Altitude">
        <small>ALT</small>
        {fmtInt(t.position.indicatedAltFt)}
      </span>
      <span title="Vertical speed">
        <small>VS</small>
        {fmtVs(t.speed.vsFpm)}
      </span>
      <span title="Heading">
        <small>HDG</small>
        {fmtHeading(t.attitude.hdgMag)}
      </span>
      <span title="Ground speed">
        <small>GS</small>
        {fmtInt(t.speed.gs)}
      </span>
    </div>
  );
}

function Menu({ label, icon, children }: { label: string; icon: Parameters<typeof Icon>[0]['name']; children: (close: () => void) => React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div className="menu" ref={ref}>
      <button type="button" className={`glare-btn ${open ? 'is-on' : ''}`} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name={icon} />
        <span>{label}</span>
        <Icon name="chevronDown" size={12} />
      </button>
      {open && <div className="menu__pop">{children(() => setOpen(false))}</div>}
    </div>
  );
}

export function Glareshield({ onCommand, onSettings }: { onCommand: () => void; onSettings: () => void }) {
  const status = useStatus();
  const t = useTelemetry();
  const online = useApp((s) => s.online);
  const settings = useSettings();
  const conn = !online ? 'offline' : status?.connection ?? 'searching';
  const connLabel =
    conn === 'offline' ? 'SkyDeck offline' : conn === 'connected' ? (t ? 'MSFS' : 'MSFS, no flight') : conn === 'demo' ? 'Demo aircraft' : 'Waiting for MSFS';

  return (
    <header className="glare">
      <div className="glare__left">
        <span className="brand" aria-label="SkyDeck">
          <svg viewBox="0 0 32 32" width="22" height="22" aria-hidden="true">
            <path d="M16 4l2.2 9.5L28 18v2.4l-9.8-2.6-.6 6.4 3 2.3V28L16 26.6 11.4 28v-1.5l3-2.3-.6-6.4L4 20.4V18l9.8-4.5z" fill="var(--cyan)" />
          </svg>
          SkyDeck
        </span>
        <span className={`conn conn--${conn}`} title={status?.message}>
          <span className="conn__dot" aria-hidden="true" />
          {connLabel}
        </span>
        {t && (
          <span className="glare__aircraft" title={t.aircraft.title}>
            {t.aircraft.title}
          </span>
        )}
      </div>

      <div className="glare__center">{t && <Fma t={t} />}</div>

      <div className="glare__right">
        {t && <KeyReadouts t={t} />}
        {t?.sim.paused && (
          <button type="button" className="pill pill--amber pill--button" onClick={() => act({ type: 'sim.pause', paused: false })} title="Click to resume">
            Paused
          </button>
        )}
        {t && t.sim.rate !== 1 && <span className="pill pill--amber">{t.sim.rate}× rate</span>}
        <Menu label={settings?.activeLayout ?? 'Layout'} icon="layout">
          {(close) => (
            <>
              <p className="menu__head">Layouts</p>
              {PRESETS.map((p) => (
                <button key={p} type="button" className={`menu__item ${settings?.activeLayout === p ? 'is-current' : ''}`} onClick={() => { switchLayout(p); close(); }}>
                  {p}
                </button>
              ))}
              <button type="button" className="menu__item menu__item--quiet" onClick={() => { resetLayout(); close(); }}>
                Reset “{settings?.activeLayout}” to default
              </button>
              <p className="menu__head">Show panel</p>
              {PANELS.map((p) => (
                <button key={p.id} type="button" className="menu__item" onClick={() => { openPanel(p.id, p.title); close(); }}>
                  {p.title}
                </button>
              ))}
            </>
          )}
        </Menu>
        <button type="button" className="glare-btn glare-btn--cmd" onClick={onCommand} title="Command bar (Ctrl+K)">
          <Icon name="keyboard" />
          <span>Command</span>
          <kbd>Ctrl K</kbd>
        </button>
        <IconButton icon="gear" label="Settings" onClick={onSettings} />
      </div>
    </header>
  );
}
