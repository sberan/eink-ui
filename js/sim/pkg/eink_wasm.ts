// Browser glue for eink_wasm.wasm (C-ABI exports, no wasm-bindgen). Exposes the
// host API documented in docs/ARCHITECTURE.md, typed by host/eink.ts.
// `npm run build:glue` compiles this to eink_wasm.js next to the .wasm.

import type {
  DamageRect, EinkInputEvent, EinkListener, NodeId, NodeKind,
  SimulatedEinkHost, Unsubscribe,
} from '../../host/eink.js';

/** The C-ABI surface exported by crates/eink-wasm. */
interface EinkWasmExports {
  memory: WebAssembly.Memory;
  alloc(n: number): number;
  dealloc(p: number, n: number): void;
  screen_w(): number;
  screen_h(): number;
  create(kind: number): number;
  set_props(id: number, ptr: number, len: number): void;
  append(parent: number, child: number): void;
  insert_before(parent: number, child: number, before: number): void;
  remove(parent: number, child: number): void;
  set_root(id: number): void;
  request_full(): void;
  hit(x: number, y: number): number;
  /** Returns the damage rect count; the rects live at damage_ptr(). */
  commit(): number;
  damage_ptr(): number;
  fb_ptr(): number;
  fb_len(): number;
}

async function instantiate(url: URL | string): Promise<EinkWasmExports> {
  try {
    const { instance } = await WebAssembly.instantiateStreaming(fetch(url), {});
    return instance.exports as unknown as EinkWasmExports;
  } catch {
    // a static host that serves .wasm with the wrong content type breaks
    // instantiateStreaming; fall back to the buffer form
    const buf = await (await fetch(url)).arrayBuffer();
    const { instance } = await WebAssembly.instantiate(buf, {});
    return instance.exports as unknown as EinkWasmExports;
  }
}

export async function loadEink(
  url: URL | string = new URL('./eink_wasm.wasm', import.meta.url),
): Promise<SimulatedEinkHost> {
  const ex = await instantiate(url);
  const enc = new TextEncoder();
  const listeners: EinkListener[] = [];

  function withStr<T>(s: string, f: (ptr: number, len: number) => T): T {
    const bytes = enc.encode(s);
    const p = ex.alloc(bytes.length);
    new Uint8Array(ex.memory.buffer).set(bytes, p);
    try {
      return f(p, bytes.length);
    } finally {
      ex.dealloc(p, bytes.length);
    }
  }

  const api: SimulatedEinkHost & { dispatch(ev: EinkInputEvent): void } = {
    width: ex.screen_w(),
    height: ex.screen_h(),

    create: (kind: NodeKind): NodeId => ex.create(kind === 'text' ? 1 : 0),
    set_props: (id, json) => withStr(json, (p, n) => ex.set_props(id, p, n)),
    append: (parent, child) => ex.append(parent, child),
    insert_before: (parent, child, before) => ex.insert_before(parent, child, before),
    remove: (parent, child) => ex.remove(parent, child),
    set_root: (id) => ex.set_root(id),
    request_full: () => ex.request_full(),
    hit: (x, y) => ex.hit(x | 0, y | 0),

    commit(): DamageRect[] {
      const n = ex.commit();
      const v = new Int32Array(ex.memory.buffer, ex.damage_ptr(), n * 5);
      const out: DamageRect[] = [];
      for (let i = 0; i < n; i++) {
        out.push({
          x: v[i * 5] ?? 0,
          y: v[i * 5 + 1] ?? 0,
          w: v[i * 5 + 2] ?? 0,
          h: v[i * 5 + 3] ?? 0,
          mode: v[i * 5 + 4] ? 'gc16' : 'du',
        });
      }
      return out;
    },

    // memory may grow, so the view is rebuilt on every read
    fb: () => new Uint8Array(ex.memory.buffer, ex.fb_ptr(), ex.fb_len()),

    on(cb: EinkListener): Unsubscribe {
      listeners.push(cb);
      return () => {
        const i = listeners.indexOf(cb);
        if (i !== -1) listeners.splice(i, 1);
      };
    },

    log: (msg: string) => { console.log(`[eink] ${msg}`); },
    buzz: () => { /* no haptics in the browser */ },
    charging: () => false,
    now: () => Date.now(),

    emit(ev: EinkInputEvent): void { for (const cb of listeners.slice()) cb(ev); },
    /** Older name for `emit`, kept for sim/smoke.html. */
    dispatch(ev: EinkInputEvent): void { api.emit(ev); },
  };

  // conformance with the documented host contract
  const _check: SimulatedEinkHost = api;
  void _check;

  globalThis.__eink = api;
  return api;
}
