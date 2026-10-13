import type { FC } from 'react';
import { MapPanel } from './MapPanel';
import { FlightPlanPanel } from './FlightPlanPanel';
import { AutopilotPanel } from './AutopilotPanel';
import { RadiosPanel } from './RadiosPanel';
import { FlightDataPanel } from './FlightDataPanel';
import { AircraftPanel } from './AircraftPanel';
import { SimulatorPanel } from './SimulatorPanel';

export interface PanelProps {
  /** True when shown in the large "detail" view. */
  detail?: boolean;
}

export interface PanelDef {
  id: string;
  title: string;
  /** What the detail view adds, shown as the expand button's tooltip. */
  detailHint: string;
  component: FC<PanelProps>;
}

export const PANELS: PanelDef[] = [
  { id: 'map', title: 'Map', detailHint: 'Full-screen map', component: MapPanel },
  { id: 'plan', title: 'Flight plan', detailHint: 'Runways, SIDs, STARs, approaches and the vertical profile', component: FlightPlanPanel },
  { id: 'autopilot', title: 'Autopilot', detailHint: 'Quick targets and mode explanations', component: AutopilotPanel },
  { id: 'radios', title: 'Radios', detailHint: 'Courses, ADF and nearby airport frequencies', component: RadiosPanel },
  { id: 'flight', title: 'Flight data', detailHint: 'Attitude indicator, GPS and time', component: FlightDataPanel },
  { id: 'aircraft', title: 'Aircraft', detailHint: 'Engine details, fuel and weight', component: AircraftPanel },
  { id: 'sim', title: 'Simulator', detailHint: 'Larger repositioning tools', component: SimulatorPanel },
];

export const panelById = (id: string) => PANELS.find((p) => p.id === id);
