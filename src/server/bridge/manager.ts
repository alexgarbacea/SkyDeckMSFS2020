// Decides which source feeds the UI: the real simulator when it is connected, otherwise the demo aircraft (if requested).
import { EventEmitter } from 'node:events';
import type { Command, ConnectionState, Telemetry } from '../../shared/types.js';
import { DemoBridge } from './demo.js';
import { SimConnectBridge } from './simconnect.js';
import { CommandError, type SimBridge } from './types.js';
import { log } from '../log.js';

export class BridgeManager extends EventEmitter {
  readonly sim = new SimConnectBridge();
  private demo: DemoBridge | null = null;
  latest: Telemetry | null = null;

  constructor() {
    super();
    this.sim.on('telemetry', (t: Telemetry) => {
      if (this.sim.inFlight) this.publish(t);
    });
    this.sim.on('state', () => {
      if (this.sim.connected && this.demo) {
        this.stopDemo();
        this.emit('notice', 'success', 'Microsoft Flight Simulator connected. The demo aircraft has been switched off.');
      }
      if (!this.sim.inFlight) this.latest = null;
      this.emit('status');
    });
    this.sim.on('simFlightPlan', (path: string) => this.emit('simFlightPlan', path));
  }

  start() {
    // SKYDECK_NO_SIM=1 ignores a running simulator (for testing the demo aircraft).
    if (process.env.SKYDECK_NO_SIM !== '1') this.sim.start();
  }

  /** The bridge commands go to, or null when nothing is available. */
  get active(): SimBridge | null {
    if (this.sim.connected) return this.sim;
    return this.demo;
  }

  get state(): ConnectionState {
    if (this.sim.connected) return 'connected';
    return this.demo ? 'demo' : 'searching';
  }

  get message(): string {
    if (this.sim.connected) {
      return this.sim.inFlight
        ? 'Connected to Microsoft Flight Simulator.'
        : 'Connected to Microsoft Flight Simulator. Start a flight to see your aircraft.';
    }
    if (this.demo) return 'Demo mode: you are controlling a simulated aircraft, not MSFS.';
    return 'Waiting for Microsoft Flight Simulator. Start the sim and SkyDeck will connect by itself.';
  }

  private publish(t: Telemetry) {
    this.latest = t;
    this.emit('telemetry', t);
  }

  startDemo() {
    if (this.sim.connected) throw new CommandError('The simulator is connected, so the demo aircraft is not needed.');
    if (this.demo) return;
    log.info('Demo aircraft started.');
    this.demo = new DemoBridge();
    this.demo.on('telemetry', (t: Telemetry) => this.publish(t));
    this.demo.start();
    this.emit('status');
  }

  stopDemo() {
    if (!this.demo) return;
    this.demo.stop();
    this.demo.removeAllListeners();
    this.demo = null;
    this.latest = null;
    log.info('Demo aircraft stopped.');
    this.emit('status');
  }

  async command(cmd: Command): Promise<void> {
    if (cmd.type === 'demo.start') return this.startDemo();
    if (cmd.type === 'demo.stop') return this.stopDemo();
    const bridge = this.active;
    if (!bridge) throw new CommandError('Microsoft Flight Simulator is not connected yet.');
    if (bridge.kind === 'sim' && !this.sim.inFlight) throw new CommandError('Start a flight in MSFS first.');
    await bridge.command(cmd);
  }
}
