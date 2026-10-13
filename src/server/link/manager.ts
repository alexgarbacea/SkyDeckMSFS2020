// The connection to SkyDeck Link running inside the aircraft's avionics.
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import type { AvionicsPlanState } from '../../shared/types.js';
import type { LinkPlan, LinkWaypoint } from './payload.js';
import { log } from '../log.js';

type LinkMessage =
  | { type: 'hello'; avionics: string; version: string; ready: boolean }
  | { type: 'state'; state: AvionicsPlanState }
  | { type: 'result'; id: number; ok: boolean; message?: string; result?: unknown }
  | { type: 'log'; level: string; message: string };

export class LinkError extends Error {}

export class LinkManager extends EventEmitter {
  private socket: WebSocket | null = null;
  avionics: string | undefined;
  version: string | undefined;
  state: AvionicsPlanState | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN && this.avionics != null;
  }

  /** True when the avionics accepted edits are possible right now. */
  get ready(): boolean {
    return this.connected && this.state?.ready !== false;
  }

  attach(ws: WebSocket) {
    // Only one aircraft at a time: a new link replaces the old one (e.g. after an aircraft reload).
    this.socket?.close(1000, 'Replaced by a newer link');
    this.socket = ws;
    ws.on('message', (raw) => {
      let msg: LinkMessage;
      try {
        msg = JSON.parse(String(raw)) as LinkMessage;
      } catch {
        return;
      }
      this.onMessage(msg);
    });
    ws.on('close', () => {
      if (this.socket !== ws) return;
      this.socket = null;
      const was = this.avionics;
      this.avionics = undefined;
      this.version = undefined;
      this.state = null;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new LinkError('The aircraft link disconnected.'));
      }
      this.pending.clear();
      if (was) log.info(`SkyDeck Link disconnected (${was}).`);
      this.emit('change');
      this.emit('state', null);
    });
  }

  private onMessage(msg: LinkMessage) {
    switch (msg.type) {
      case 'hello':
        this.avionics = msg.avionics;
        this.version = msg.version;
        log.info(`SkyDeck Link connected: ${msg.avionics} (link version ${msg.version}).`);
        this.emit('change');
        break;
      case 'log':
        (msg.level === 'error' ? log.warn : log.debug)(`[link] ${msg.message}`);
        break;
      case 'state':
        if (this.state?.ready !== msg.state.ready) log.debug(`[link] avionics ready: ${msg.state.ready}`);
        this.state = msg.state;
        this.emit('state', msg.state);
        break;
      case 'result': {
        const p = this.pending.get(msg.id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(msg.id);
        log.debug(`[link] result ${msg.id}: ${msg.ok ? JSON.stringify(msg.result) : msg.message}`);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new LinkError(msg.message ?? 'The avionics rejected the request.'));
        break;
      }
    }
  }

  private request<T>(payload: Record<string, unknown>, timeoutMs = 20000): Promise<T> {
    const socket = this.socket;
    if (!socket || !this.connected) return Promise.reject(new LinkError('SkyDeck Link is not connected.'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new LinkError('The avionics did not answer in time.'));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      log.debug(`[link] request ${id}: ${JSON.stringify(payload)}`);
      socket.send(JSON.stringify({ ...payload, id }));
    });
  }

  loadPlan(plan: LinkPlan) {
    return this.request<{ legs: number; warnings: string[] }>({ type: 'loadPlan', plan });
  }

  directTo(target: LinkWaypoint) {
    return this.request<{ inPlan: boolean }>({ type: 'directTo', target });
  }
}
