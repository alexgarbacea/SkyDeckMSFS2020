import { useSyncExternalStore } from 'react';

export type ToastLevel = 'info' | 'success' | 'warning' | 'error';
export interface Toast {
  id: number;
  message: string;
  level: ToastLevel;
}

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function toast(message: string, level: ToastLevel = 'info') {
  // Collapse repeats of the same message (e.g. a key held down).
  if (toasts.some((t) => t.message === message)) return;
  const id = nextId++;
  toasts = [...toasts, { id, message, level }].slice(-4);
  emit();
  setTimeout(() => dismiss(id), level === 'error' ? 6000 : 3500);
}

export function dismiss(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

export function useToasts() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => toasts,
  );
}
