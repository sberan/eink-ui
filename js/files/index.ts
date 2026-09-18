// The synced repository as seen by the app: cached reads, optimistic writes, live updates.
// Reads are synchronous against the host's checkout; a pull raises a `files` event that drops
// the affected cache entries and re-renders subscribers.
import { useSyncExternalStore } from 'react';
import type { SyncState } from '../host/eink.js';
import { subscribeHostEvents } from '../renderer/index.js';

const texts = new Map<string, string | null>();
const lists = new Map<string, readonly string[]>();
const subscribers = new Set<() => void>();
const NO_SYNC: SyncState = { state: 'idle', pending: 0, last_sync: null, error: null };
let sync: SyncState = NO_SYNC;
let syncRead = false;

function host() {
  return globalThis.__eink;
}

function notify(): void {
  for (const s of subscribers) s();
}

// listen from module load: an event that lands before the first hook subscribes must not be lost
subscribeHostEvents((ev) => {
  if (ev.type === 'files') {
    for (const p of ev.changed) texts.delete(p);
    lists.clear();
  } else if (ev.type === 'sync') {
    sync = ev.sync;
    syncRead = true;
  } else {
    return;
  }
  notify();
});

function subscribe(cb: () => void): () => void {
  subscribers.add(cb);
  return () => { subscribers.delete(cb); };
}

export function readFile(path: string): string | null {
  if (!texts.has(path)) {
    const h = host();
    texts.set(path, typeof h?.read_file === 'function' ? h.read_file(path) : null);
  }
  return texts.get(path) ?? null;
}

/** Sorted paths under `prefix`, optionally filtered by extension. Stable until the repo changes. */
export function listFiles(prefix: string, ext?: string): readonly string[] {
  const key = `${prefix}\0${ext ?? ''}`;
  let l = lists.get(key);
  if (!l) {
    const h = host();
    const all = typeof h?.list_files === 'function' ? h.list_files(prefix) : [];
    l = (ext ? all.filter((p) => p.endsWith(ext)) : all.slice()).sort();
    lists.set(key, l);
  }
  return l;
}

/** Saves at once (the UI updates immediately); the host commits and pushes in the background. */
export function writeFile(path: string, text: string): void {
  // only a new file changes directory listings; keeping them lets useFiles callers skip a render
  const isNew = (texts.get(path) ?? null) === null;
  texts.set(path, text);
  if (isNew) lists.clear();
  const h = host();
  if (typeof h?.write_file === 'function') h.write_file(path, text);
  notify();
}

export function syncState(): SyncState {
  if (!syncRead) {
    const h = host();
    if (typeof h?.sync_state === 'function') sync = h.sync_state();
    syncRead = true;
  }
  return sync;
}

export function requestSync(): void {
  const h = host();
  if (typeof h?.sync === 'function') h.sync();
}

export function useFile(path: string): string | null {
  return useSyncExternalStore(subscribe, () => readFile(path));
}

export function useFiles(prefix: string, ext?: string): readonly string[] {
  return useSyncExternalStore(subscribe, () => listFiles(prefix, ext));
}

export function useSync(): SyncState {
  return useSyncExternalStore(subscribe, () => syncState());
}

/**
 * The device's settings: the `eink` section of the repository's `package.json`, with
 * `data/settings.json` (what was changed from the device) merged over it key by key. See
 * docs/DEBUGGING.md.
 */
export type Settings = Readonly<Record<string, unknown>>;

const EMPTY_SETTINGS: Settings = Object.freeze({});
let settingsKey: string | undefined;
let settingsValue: Settings = EMPTY_SETTINGS;

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function parseObject(text: string | null): Record<string, unknown> {
  if (text === null) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Objects merge key by key; anything else on the right replaces the left. */
export function mergeSettings(base: unknown, over: unknown): unknown {
  if (!isObject(base) || !isObject(over)) return over;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = mergeSettings(base[k], v);
  return out;
}

/** Parsed once per pair of texts, so the snapshot stays the same object until a pull changes them. */
export function readSettings(): Settings {
  const pkg = readFile('package.json');
  const over = readFile('data/settings.json');
  const key = `${pkg ?? ''}\0${over ?? ''}`;
  if (key !== settingsKey) {
    settingsKey = key;
    const base = parseObject(pkg)['eink'];
    const merged = mergeSettings(isObject(base) ? base : {}, parseObject(over));
    settingsValue = isObject(merged) ? merged : EMPTY_SETTINGS;
  }
  return settingsValue;
}

export function useSettings(): Settings {
  return useSyncExternalStore(subscribe, readSettings);
}

/** One section of the settings as an object, `{}` when absent: `settingsSection(s, 'app')`. */
export function settingsSection(s: Settings, key: string): Readonly<Record<string, unknown>> {
  const v = s[key];
  return isObject(v) ? v : EMPTY_SETTINGS;
}

/** Tests and the simulator reset the module between hosts. */
export function resetFiles(): void {
  texts.clear();
  lists.clear();
  sync = NO_SYNC;
  syncRead = false;
  settingsKey = undefined;
  settingsValue = EMPTY_SETTINGS;
}
