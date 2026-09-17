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
let wired = false;

function host() {
  return globalThis.__eink;
}

function notify(): void {
  for (const s of subscribers) s();
}

function wire(): void {
  if (wired) return;
  wired = true;
  const h = host();
  if (typeof h?.sync_state === 'function') sync = h.sync_state();
  subscribeHostEvents((ev) => {
    if (ev.type === 'files') {
      for (const p of ev.changed) texts.delete(p);
      lists.clear();
    } else if (ev.type === 'sync') {
      sync = ev.sync;
    } else {
      return;
    }
    notify();
  });
}

function subscribe(cb: () => void): () => void {
  wire();
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
  texts.set(path, text);
  lists.clear();
  const h = host();
  if (typeof h?.write_file === 'function') h.write_file(path, text);
  notify();
}

export function syncState(): SyncState {
  wire();
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

/** Tests and the simulator reset the module between hosts. */
export function resetFiles(): void {
  texts.clear();
  lists.clear();
  sync = NO_SYNC;
}
