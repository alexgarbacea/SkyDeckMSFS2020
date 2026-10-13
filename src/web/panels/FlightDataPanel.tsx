import type { Telemetry } from '../../shared/types';
import { angleDiff } from '../../shared/geo';
import { useSettings, useTelemetry } from '../lib/store';
import { fmtBaro, fmtClock, fmtDistance, fmtDuration, fmtHeading, fmtInt, fmtVs } from '../lib/format';
import { Readout, Section } from '../components/ui';
import { NoAircraft } from './common';
import type { PanelProps } from './registry';

/** Simple attitude indicator: sky/ground horizon with pitch ladder and bank pointer. */
export function Attitude({ pitch, bank, size = 220 }: { pitch: number; bank: number; size?: number }) {
  const pxPerDeg = 4;
  const p = Math.max(-30, Math.min(30, pitch));
  return (
    <svg className="attitude" width={size} height={size} viewBox="-110 -110 220 220" role="img" aria-label={`Pitch ${pitch.toFixed(0)} degrees, bank ${bank.toFixed(0)} degrees`}>
      <defs>
        <clipPath id="att-clip">
          <circle r="100" />
        </clipPath>
      </defs>
      <g clipPath="url(#att-clip)">
        <g transform={`rotate(${-bank}) translate(0 ${p * pxPerDeg})`}>
          <rect x="-300" y="-600" width="600" height="600" fill="#2c6fa6" />
          <rect x="-300" y="0" width="600" height="600" fill="#6b4a2b" />
          <line x1="-300" x2="300" y1="0" y2="0" stroke="#fff" strokeWidth="1.5" />
          {[-20, -15, -10, -5, 5, 10, 15, 20].map((d) => (
            <g key={d}>
              <line x1={d % 10 === 0 ? -24 : -12} x2={d % 10 === 0 ? 24 : 12} y1={-d * pxPerDeg} y2={-d * pxPerDeg} stroke="#fff" strokeWidth="1.2" />
              {d % 10 === 0 && (
                <text x="30" y={-d * pxPerDeg + 4} fill="#fff" fontSize="10" fontFamily="var(--font-display)">
                  {Math.abs(d)}
                </text>
              )}
            </g>
          ))}
        </g>
      </g>
      {/* Bank scale */}
      {[-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60].map((d) => (
        <line key={d} x1="0" x2="0" y1="-100" y2={d % 30 === 0 ? -90 : -94} stroke="#fff" strokeWidth="1.5" transform={`rotate(${d})`} />
      ))}
      <path d="M0 -88 l-6 10 h12z" fill="var(--amber)" transform={`rotate(${-bank})`} />
      {/* Aircraft symbol */}
      <path d="M-60 0 h36 l8 8 l8 -8 h0 M24 0 h36" stroke="var(--amber)" strokeWidth="4" fill="none" strokeLinejoin="round" />
      <circle r="3" fill="var(--amber)" />
      <circle r="100" fill="none" stroke="var(--glass-edge)" strokeWidth="2" />
    </svg>
  );
}

function WindArrow({ t }: { t: Telemetry }) {
  // Arrow shows where the wind blows relative to the nose (pointing down = headwind).
  const rel = angleDiff(t.environment.windDir, t.attitude.hdgTrue);
  return (
    <svg width="18" height="18" viewBox="-13 -13 26 26" aria-hidden="true" className="wind-arrow">
      <g transform={`rotate(${rel + 180})`}>
        <path d="M0 -10 L0 10 M0 -10 L-4 -4 M0 -10 L4 -4" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" />
      </g>
    </svg>
  );
}

export function FlightDataPanel({ detail }: PanelProps) {
  const t = useTelemetry();
  const settings = useSettings();
  if (!t) return <NoAircraft />;
  const jet = t.engines.type === 1 || t.speed.mach > 0.4;
  const headwind = Math.round(t.environment.windKt * Math.cos(((t.environment.windDir - t.attitude.hdgTrue) * Math.PI) / 180));
  const tiles = (
    <div className="readout-grid">
      <Readout label="Indicated airspeed" value={fmtInt(t.speed.ias)} unit="kt" />
      <Readout label="Ground speed" value={fmtInt(t.speed.gs)} unit="kt" sub={`TAS ${fmtInt(t.speed.tas)}${jet ? `, Mach ${t.speed.mach.toFixed(2)}` : ''}`} />
      <Readout label="Altitude" value={fmtInt(t.position.indicatedAltFt)} unit="ft" sub={`${fmtInt(t.position.aglFt)} ft above ground`} />
      <Readout label="Vertical speed" value={fmtVs(t.speed.vsFpm)} unit="fpm" />
      <Readout label="Heading" value={fmtHeading(t.attitude.hdgMag)} unit="°" sub={`Track ${fmtHeading(t.attitude.trackTrue - t.attitude.magVar)}°`} />
      <Readout
        compact
        label="Wind"
        value={
          <span className="wind">
            <WindArrow t={t} />
            {fmtHeading(t.environment.windDir)}°/{fmtInt(t.environment.windKt)}
          </span>
        }
        unit="kt"
        sub={headwind >= 0 ? `${headwind} kt headwind` : `${-headwind} kt tailwind`}
      />
      <Readout label="Outside air" value={t.environment.oatC.toFixed(0)} unit="°C" />
      <Readout label="Altimeter" value={fmtBaro(t.environment.baroInHg, settings?.units)} unit={settings?.units.pressure ?? 'inHg'} />
    </div>
  );
  if (!detail) return <div className="panel-body flight-data">{tiles}</div>;
  return (
    <div className="panel-body flight-data flight-data--detail">
      <div className="flight-data__primary">
        <Attitude pitch={t.attitude.pitch} bank={t.attitude.bank} size={260} />
        {tiles}
      </div>
      <div className="flight-data__secondary">
        <Section title="GPS">
          {t.gps.hasPlan ? (
            <div className="readout-grid readout-grid--tight">
              <Readout tone="magenta" label="Next waypoint" value={t.gps.nextId || '—'} />
              <Readout tone="magenta" label="Distance" value={fmtDistance(t.gps.distNm)} unit="nm" />
              <Readout tone="magenta" label="Bearing" value={fmtHeading(t.gps.bearingMag)} unit="°" />
              <Readout tone="magenta" label="Time to waypoint" value={fmtDuration(t.gps.eteSec)} />
              <Readout tone="magenta" label="Time to destination" value={fmtDuration(t.gps.destEteSec)} />
              <Readout label="Cross-track" value={Math.abs(t.gps.xtkNm).toFixed(2)} unit="nm" />
            </div>
          ) : (
            <p className="muted">No flight plan is active in the aircraft's GPS.</p>
          )}
        </Section>
        <Section title="Time">
          <div className="readout-grid readout-grid--tight">
            <Readout label="Local" value={fmtClock(t.sim.localSeconds)} />
            <Readout label="UTC" value={fmtClock(t.sim.zuluSeconds)} unit="Z" />
          </div>
        </Section>
        <Section title="Attitude">
          <div className="readout-grid readout-grid--tight">
            <Readout label="Pitch" value={t.attitude.pitch.toFixed(1)} unit="°" />
            <Readout label="Bank" value={Math.abs(t.attitude.bank).toFixed(1)} unit={`° ${t.attitude.bank > 0.5 ? 'right' : t.attitude.bank < -0.5 ? 'left' : ''}`} />
          </div>
        </Section>
      </div>
    </div>
  );
}
