import { useCallback, useEffect, useMemo, useRef } from 'react';
import { DockviewReact, type DockviewApi, type DockviewReadyEvent, type IDockviewHeaderActionsProps, type IDockviewPanelProps, type SerializedDockview } from 'dockview';
import 'dockview/dist/styles/dockview.css';
import { PANELS, panelById } from '../panels/registry';
import { getDockApi, openPanel, setDockApi, showDetail } from '../lib/workspace';
import { api } from '../lib/api';
import { getState } from '../lib/store';
import { Button, Icon } from './ui';

export const PRESETS = ['Cruise', 'Planning', 'Approach'] as const;

type Add = (id: string, position?: { referencePanel: string; direction: 'right' | 'left' | 'above' | 'below' | 'within' }, size?: { w?: number; h?: number }) => void;

function builder(dock: DockviewApi): Add {
  return (id, position, size) => {
    const def = panelById(id)!;
    dock.addPanel({
      id,
      component: id,
      title: def.title,
      renderer: id === 'map' ? 'always' : undefined,
      ...(position ? { position } : {}),
      ...(size?.w ? { initialWidth: size.w } : {}),
      ...(size?.h ? { initialHeight: size.h } : {}),
      inactive: position?.direction === 'within',
    });
  };
}

/** Built-in layouts, sized for a 1920×1080 second monitor but proportional on anything else. */
export function applyPreset(dock: DockviewApi, name: string) {
  dock.clear();
  const add = builder(dock);
  const w = window.innerWidth;
  const h = window.innerHeight;
  switch (name) {
    case 'Planning':
      add('plan');
      add('map', { referencePanel: 'plan', direction: 'right' }, { w: Math.round(w * 0.58) });
      add('sim', { referencePanel: 'plan', direction: 'within' });
      add('flight', { referencePanel: 'map', direction: 'below' }, { h: Math.round(h * 0.22) });
      dock.getPanel('plan')?.api.setActive();
      break;
    case 'Approach':
      add('map');
      add('autopilot', { referencePanel: 'map', direction: 'right' }, { w: Math.round(w * 0.3) });
      add('radios', { referencePanel: 'autopilot', direction: 'below' });
      add('flight', { referencePanel: 'map', direction: 'below' }, { h: Math.round(h * 0.24) });
      add('aircraft', { referencePanel: 'radios', direction: 'within' });
      dock.getPanel('radios')?.api.setActive();
      break;
    case 'Cruise':
    default:
      add('map');
      add('autopilot', { referencePanel: 'map', direction: 'right' }, { w: Math.round(w * 0.3) });
      add('radios', { referencePanel: 'autopilot', direction: 'below' });
      add('plan', { referencePanel: 'map', direction: 'below' }, { h: Math.round(h * 0.32) });
      add('sim', { referencePanel: 'plan', direction: 'within' });
      add('flight', { referencePanel: 'plan', direction: 'right' }, { w: Math.round(w * 0.3) });
      add('aircraft', { referencePanel: 'flight', direction: 'within' });
      dock.getPanel('flight')?.api.setActive();
      dock.getPanel('plan')?.api.setActive();
      break;
  }
}

/** Loads the user's saved version of a layout, or the built-in preset. */
export function loadLayout(dock: DockviewApi, name: string) {
  const saved = getState().settings?.layouts[name] as SerializedDockview | undefined;
  if (saved) {
    try {
      dock.fromJSON(saved);
      // Drop panels from older versions that no longer exist.
      for (const p of [...dock.panels]) if (!panelById(p.id)) dock.removePanel(p);
      if (dock.panels.length) return;
    } catch {
      /* fall back to the preset */
    }
  }
  applyPreset(dock, name);
}

function PanelHost(props: IDockviewPanelProps) {
  const def = panelById(props.api.id);
  if (!def) return null;
  const C = def.component;
  return (
    <div className="dock-panel">
      <C />
    </div>
  );
}

function HeaderActions({ activePanel }: IDockviewHeaderActionsProps) {
  const def = activePanel ? panelById(activePanel.id) : undefined;
  if (!def) return null;
  return (
    <div className="dock-actions">
      <button type="button" className="dock-actions__btn" title={`Open ${def.title} in the large view: ${def.detailHint}`} aria-label={`Expand ${def.title}`} onClick={() => showDetail(def.id)}>
        <Icon name="expand" size={14} />
      </button>
    </div>
  );
}

function Watermark() {
  return (
    <div className="dock-empty">
      <p>All panels are closed.</p>
      <div className="chip-row">
        {PANELS.map((p) => (
          <Button key={p.id} size="sm" icon="plus" onClick={() => openPanel(p.id, p.title)}>
            {p.title}
          </Button>
        ))}
      </div>
    </div>
  );
}

export function Workspace() {
  const components = useMemo(() => Object.fromEntries(PANELS.map((p) => [p.id, PanelHost])), []);
  const saveTimer = useRef<number>();
  const loading = useRef(false);

  const onReady = useCallback((event: DockviewReadyEvent) => {
    const dock = event.api;
    setDockApi(dock);
    loading.current = true;
    loadLayout(dock, getState().settings?.activeLayout ?? 'Cruise');
    loading.current = false;
    dock.onDidLayoutChange(() => {
      if (loading.current) return;
      window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        const s = getState().settings;
        if (!s) return;
        void api.saveSettings({ layouts: { ...s.layouts, [s.activeLayout]: dock.toJSON() } }).catch(() => undefined);
      }, 1000);
    });
  }, []);

  useEffect(() => () => setDockApi(null), []);

  return (
    <DockviewReact
      className="dockview-theme-skydeck"
      components={components}
      onReady={onReady}
      rightHeaderActionsComponent={HeaderActions}
      watermarkComponent={Watermark}
      singleTabMode="default"
    />
  );
}

/** Switches to another named layout. */
export function switchLayout(name: string) {
  const dock = getDockApi();
  const s = getState().settings;
  if (!dock || !s) return;
  void api.saveSettings({ activeLayout: name }).then(() => loadLayout(dock, name));
}

/** Throws away the user's changes to the current layout. */
export function resetLayout() {
  const dock = getDockApi();
  const s = getState().settings;
  if (!dock || !s) return;
  const layouts = { ...s.layouts };
  delete layouts[s.activeLayout];
  void api.saveSettings({ layouts }).then(() => applyPreset(dock, s.activeLayout));
}
