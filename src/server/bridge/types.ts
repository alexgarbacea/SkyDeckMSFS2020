import type { EventEmitter } from 'node:events';
import type { AirportDetails, Command, FlightPlan, Telemetry } from '../../shared/types.js';
import type { AirportProcedureLegs } from '../flightplan/procedures.js';

export interface BridgeEvents {
  telemetry: (t: Telemetry) => void;
  /** Connection-level change (connected, lost, in menu / in flight). */
  state: () => void;
  /** The simulator activated a flight plan file (e.g. from the World Map). */
  simFlightPlan: (path: string) => void;
}

/** A source of aircraft data and a sink for commands: the real simulator or the demo aircraft. */
export interface SimBridge extends EventEmitter {
  readonly kind: 'sim' | 'demo';
  readonly connected: boolean;
  /** True when the user is in an actual flight (not the main menu / world map). */
  readonly inFlight: boolean;
  readonly simName: string;
  start(): void;
  stop(): void;
  command(cmd: Command): Promise<void>;
  /** Loads a flight plan into the aircraft's GPS/FMS. `plnPath` is a file already written to disk. */
  loadFlightPlan(plan: FlightPlan, plnPath: string): Promise<void>;
  /** Procedures and frequencies straight from the simulator's navigation database. */
  airportFromSim(icao: string): Promise<Partial<AirportDetails> | null>;
  /** SID/STAR/approach fixes from the simulator's database (null when unavailable, e.g. in the demo). */
  procedureLegs(icao: string): Promise<AirportProcedureLegs | null>;
  /** Looks up a named fix / navaid in the simulator database. */
  findFix(ident: string, near?: { lat: number; lon: number }, regions?: string[]): Promise<{ ident: string; lat: number; lon: number; region: string; type: 'fix' | 'vor' | 'ndb' } | null>;
}

export class CommandError extends Error {}
