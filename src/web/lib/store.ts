// Live application state fed by the SkyDeck server over a WebSocket.
import { useSyncExternalStore } from 'react';
import type { AtcState, AvionicsPlanState, Command, FlightPlan, GroundState, ServerMessage, ServerStatus, Settings, Telemetry } from '../../shared/types';
import { toast } from './toast';

export interface AppState {
  /** Whether the browser is connected to the SkyDeck server (not the sim). */
  online: boolean;
  status: ServerStatus | null;
  telemetry: Telemetry | null;
  plan: FlightPlan | null;
  settings: Settings | null;
  /** The flight plan the aircraft's avionics hold, when SkyDeck Link is connected. */
  avionics: AvionicsPlanState | null;
  ground: GroundState | null;
  atc: AtcState | null;
}

let state: AppState = { online: false, status: null, telemetry: null, plan: null, settings: null, avionics: null, ground: null, atc: null };
const listeners = new Set<() => void>();

function set(patch: Partial<AppState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export function getState() {
  return state;
}

export function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useApp<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}

export const useTelemetry = () => useApp((s) => s.telemetry);
export const usePlan = () => useApp((s) => s.plan);
export const useSettings = () => useApp((s) => s.settings);
export const useStatus = () => useApp((s) => s.status);
export const useAvionics = () => useApp((s) => s.avionics);
export const useGround = () => useApp((s) => s.ground);
export const useAtc = () => useApp((s) => s.atc);

export function setLocalPlan(plan: FlightPlan | null) {
  set({ plan });
}
export function setLocalSettings(settings: Settings) {
  set({ settings });
}
export function setLocalAtc(atc: AtcState) {
  set({ atc });
}

// ---------------------------------------------------------------- Socket

let socket: WebSocket | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();
let retry = 500;

export function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  socket = ws;
  ws.onopen = () => {
    retry = 500;
    set({ online: true });
  };
  ws.onclose = () => {
    if (socket !== ws) return;
    set({ online: false });
    for (const p of pending.values()) p.reject(new Error('Lost connection to SkyDeck.'));
    pending.clear();
    setTimeout(connect, retry);
    retry = Math.min(retry * 2, 5000);
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data)) as ServerMessage;
    switch (msg.type) {
      case 'status':
        set({ status: msg.status, ...(!msg.status.hasAircraft ? { telemetry: null } : {}) });
        break;
      case 'telemetry':
        set({ telemetry: msg.data });
        break;
      case 'plan':
        set({ plan: msg.plan });
        break;
      case 'settings':
        set({ settings: msg.settings });
        break;
      case 'avionics':
        set({ avionics: msg.state });
        break;
      case 'ground':
        set({ ground: msg.state });
        break;
      case 'atc':
        set({ atc: msg.state });
        break;
      case 'notice':
        toast(msg.message, msg.level);
        break;
      case 'result': {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (!p) break;
        if (msg.ok) p.resolve();
        else p.reject(new Error(msg.message ?? 'The simulator did not accept that.'));
        break;
      }
    }
  };
}

/** Sends a command to the simulator. Errors are shown as a toast and re-thrown. */
export function send(command: Command): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      const err = new Error('SkyDeck is reconnecting. Try again in a moment.');
      toast(err.message, 'error');
      reject(err);
      return;
    }
    const id = nextId++;
    pending.set(id, {
      resolve,
      reject: (e) => {
        toast(e.message, 'error');
        reject(e);
      },
    });
    socket.send(JSON.stringify({ type: 'command', id, command }));
  });
}

/** Fire-and-forget variant for buttons; failures already surface as toasts. */
export function act(command: Command) {
  send(command).catch(() => undefined);
}
