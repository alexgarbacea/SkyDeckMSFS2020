// Thin wrappers around SkyDeck's HTTP API.
import type { AirportDetails, FlightPlan, LinkInstallStatus, MsfsInstallCandidate, PlanWaypoint, SearchResult, Settings } from '../../shared/types';
import { setLocalPlan, setLocalSettings } from './store';

export class ApiError extends Error {}

async function request<T>(method: string, url: string, body?: unknown, type = 'application/json'): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: body !== undefined ? { 'Content-Type': type } : undefined,
      body: body === undefined ? undefined : type === 'application/json' ? JSON.stringify(body) : (body as string),
    });
  } catch {
    throw new ApiError('SkyDeck is not responding. Is the SkyDeck window still open?');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError((data as { error?: string } | null)?.error ?? `Request failed (${res.status}).`);
  return data as T;
}

export interface FolderListing {
  path: string;
  parent: string | null;
  folders: string[];
  isMsfs: boolean;
}

export interface SendResult {
  ok: true;
  /** avionics: edited through SkyDeck Link; sim: loaded into MSFS; preflight: loaded before the flight started. */
  via: 'avionics' | 'sim' | 'preflight' | 'demo';
  avionics?: string;
  warnings?: string[];
}

export interface NearbyAirport extends AirportDetails {
  distNm: number;
}

const withPlan = async (p: Promise<FlightPlan>) => {
  const plan = await p;
  setLocalPlan(plan);
  return plan;
};

export const api = {
  saveSettings: async (patch: Partial<Settings>) => {
    const s = await request<Settings>('PUT', '/api/settings', patch);
    setLocalSettings(s);
    return s;
  },
  detectInstalls: () => request<MsfsInstallCandidate[]>('GET', '/api/setup/detect'),
  listFolders: (path: string | null) => request<FolderListing>('GET', `/api/setup/folders?path=${encodeURIComponent(path ?? '')}`),
  inspectFolder: (path: string) => request<MsfsInstallCandidate>('POST', '/api/setup/inspect', { path }),

  search: (q: string) => request<SearchResult[]>('GET', `/api/search?q=${encodeURIComponent(q)}`),
  airport: (ident: string) => request<AirportDetails>('GET', `/api/airport/${encodeURIComponent(ident)}`),
  nearest: (lat: number, lon: number) => request<NearbyAirport[]>('GET', `/api/nearest?lat=${lat}&lon=${lon}`),
  resolve: (ident: string) => request<PlanWaypoint>('POST', '/api/resolve', { ident }),

  savePlan: (plan: FlightPlan | null) => {
    setLocalPlan(plan); // optimistic: the UI should not wait for the round trip
    return request<FlightPlan | null>('PUT', '/api/plan', plan);
  },
  sendPlan: () => request<SendResult>('POST', '/api/plan/send'),
  linkStatus: () => request<LinkInstallStatus>('GET', '/api/link'),
  installLink: () => request<LinkInstallStatus>('POST', '/api/link/install'),
  uninstallLink: () => request<LinkInstallStatus>('POST', '/api/link/uninstall'),
  directTo: (target: { waypoint?: PlanWaypoint; ident?: string }) => withPlan(request<FlightPlan>('POST', '/api/plan/direct', target)),
  importSimbrief: (user?: string) => withPlan(request<FlightPlan>('POST', '/api/plan/import/simbrief', { user })),
  importMsfs: () => withPlan(request<FlightPlan>('POST', '/api/plan/import/msfs')),
  importPln: (xml: string) => withPlan(request<FlightPlan>('POST', '/api/plan/import/pln', xml, 'text/plain')),
  route: async (route: string, cruiseAltFt?: number) => {
    const res = await request<{ plan: FlightPlan; skipped: string[] }>('POST', '/api/plan/route', { route, cruiseAltFt });
    setLocalPlan(res.plan);
    return res;
  },
};

let airportsCache: Promise<unknown[][]> | null = null;
let navaidsCache: Promise<unknown[][]> | null = null;
export const loadAirportsData = () => (airportsCache ??= fetch('/api/navdata/airports.json').then((r) => r.json()));
export const loadNavaidsData = () => (navaidsCache ??= fetch('/api/navdata/navaids.json').then((r) => r.json()));
