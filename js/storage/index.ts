// Persistent UI state with the Web Storage shape. On the device it is the host's JSON file,
// in the browser it is localStorage, in tests it is memory.
import { useCallback, useState } from 'react';

export interface UiStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
  key(index: number): string | null;
  readonly length: number;
}

function memoryStorage(): UiStorage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    clear: () => map.clear(),
    key: (i) => [...map.keys()][i] ?? null,
    get length() { return map.size; },
  };
}

function hostStorage(): UiStorage | null {
  const host = globalThis.__eink;
  if (!host || typeof host.storage_get !== 'function') return null;
  return {
    getItem: (k) => host.storage_get(String(k)),
    setItem: (k, v) => host.storage_set(String(k), String(v)),
    removeItem: (k) => host.storage_remove(String(k)),
    clear: () => { for (const k of host.storage_keys()) host.storage_remove(k); },
    key: (i) => host.storage_keys()[i] ?? null,
    get length() { return host.storage_keys().length; },
  };
}

let fallback: UiStorage | null = null;

/** The storage for this host, chosen once per host. */
export function getStorage(): UiStorage {
  const fromHost = hostStorage();
  if (fromHost) return fromHost;
  const w = globalThis as { localStorage?: UiStorage; document?: unknown };
  if (w.document && w.localStorage) return w.localStorage;
  return (fallback ??= memoryStorage());
}

/** Defines `globalThis.localStorage` on hosts without one, so ordinary web code works. */
export function installLocalStorage(): void {
  const g = globalThis as { localStorage?: UiStorage };
  if (g.localStorage === undefined) g.localStorage = getStorage();
}

export function readJson<T>(key: string, initial: T): T {
  const raw = getStorage().getItem(key);
  if (raw === null) return initial;
  try { return JSON.parse(raw) as T; } catch { return initial; }
}

export function writeJson(key: string, value: unknown): void {
  getStorage().setItem(key, JSON.stringify(value));
}

/** useState that survives restarts: read once at mount, written through on every set. */
export function useStoredState<T>(key: string, initial: T): [T, (next: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => readJson(key, initial));
  const set = useCallback((next: T | ((prev: T) => T)) => {
    setValue((prev) => {
      const v = typeof next === 'function' ? (next as (p: T) => T)(prev) : next;
      writeJson(key, v);
      return v;
    });
  }, [key]);
  return [value, set];
}
