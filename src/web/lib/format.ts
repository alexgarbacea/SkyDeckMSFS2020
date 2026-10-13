// Number formatting in the conventions pilots expect.
import type { RadioName, Settings } from '../../shared/types';

export const HPA_PER_INHG = 33.8639;

export function fmtInt(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return Math.round(n).toLocaleString('en-US');
}

export function fmtHeading(deg: number | null | undefined): string {
  if (deg == null || !Number.isFinite(deg)) return '—';
  const d = Math.round(((deg % 360) + 360) % 360);
  return String(d === 0 ? 360 : d).padStart(3, '0');
}

export function fmtVs(fpm: number): string {
  const r = Math.round(fpm / 10) * 10;
  return `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r).toLocaleString('en-US')}`;
}

export function fmtFreq(radio: RadioName, mhz: number): string {
  if (!mhz) return '———.——';
  return mhz.toFixed(radio.startsWith('com') ? 3 : 2);
}

export function fmtDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m} min`;
}

export function fmtClock(seconds: number): string {
  const s = ((Math.round(seconds) % 86400) + 86400) % 86400;
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
}

export function fmtDistance(nm: number | null | undefined): string {
  if (nm == null || !Number.isFinite(nm)) return '—';
  return nm < 10 ? nm.toFixed(1) : Math.round(nm).toLocaleString('en-US');
}

export function fmtLat(lat: number): string {
  return `${lat >= 0 ? 'N' : 'S'}${Math.abs(lat).toFixed(4)}°`;
}
export function fmtLon(lon: number): string {
  return `${lon >= 0 ? 'E' : 'W'}${Math.abs(lon).toFixed(4)}°`;
}

export function fmtBaro(inHg: number, units: Settings['units'] | undefined): string {
  return units?.pressure === 'hPa' ? `${Math.round(inHg * HPA_PER_INHG)}` : inHg.toFixed(2);
}

export function fmtWeight(lbs: number, units: Settings['units'] | undefined): string {
  return units?.weight === 'kg' ? `${fmtInt(lbs * 0.4536)} kg` : `${fmtInt(lbs)} lb`;
}

/** Altitude with flight levels above a transition altitude. */
export function fmtAltitude(ft: number, transition = 18000): string {
  if (ft >= transition) return `FL${String(Math.round(ft / 100)).padStart(3, '0')}`;
  return `${fmtInt(ft)} ft`;
}

/**
 * Accepts what pilots type for a frequency: "121.5", "1215", "121500", "12155" → MHz.
 * Returns null when the input cannot be a frequency for this radio.
 */
export function parseFrequency(radio: RadioName, text: string): number | null {
  const t = text.trim().replace(',', '.');
  if (!t) return null;
  let mhz: number;
  if (t.includes('.')) mhz = Number(t);
  else if (/^\d{3,6}$/.test(t)) mhz = Number(`${t.slice(0, 3)}.${t.slice(3) || '0'}`);
  else return null;
  if (!Number.isFinite(mhz)) return null;
  const com = radio.startsWith('com');
  if (com ? mhz < 118 || mhz >= 137 : mhz < 108 || mhz >= 118) return null;
  return Math.round(mhz * 1000) / 1000;
}

export function parseAltitude(text: string): number | null {
  const t = text.trim().toUpperCase().replace(/[,\s]/g, '');
  const fl = /^FL(\d{2,3})$/.exec(t);
  if (fl) return Number(fl[1]) * 100;
  const n = Number(t.replace(/FT$/, ''));
  return Number.isFinite(n) && t !== '' ? Math.round(n) : null;
}
