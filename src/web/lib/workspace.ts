// Controls the dock layout from anywhere (menus, command bar) without prop drilling.
import { useSyncExternalStore } from 'react';
import type { DockviewApi } from 'dockview';

let dock: DockviewApi | null = null;
let detail: string | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function setDockApi(api: DockviewApi | null) {
  dock = api;
}

export function getDockApi() {
  return dock;
}

export function showDetail(id: string | null) {
  detail = id;
  emit();
}

export function useDetail() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => detail,
  );
}

/** Focuses a panel, adding it to the layout if it is not there. */
export function openPanel(id: string, title: string) {
  if (!dock) return;
  const existing = dock.getPanel(id);
  if (existing) {
    existing.api.setActive();
    return;
  }
  const reference = dock.activePanel ?? dock.panels[0];
  dock.addPanel({
    id,
    component: id,
    title,
    renderer: id === 'map' ? 'always' : undefined,
    ...(reference ? { position: { referencePanel: reference.id, direction: 'right' as const } } : {}),
  });
}
