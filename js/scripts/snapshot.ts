// Headless renders of the apps through the wasm core (Node), written as 8-bit PNGs.
// Used to produce the README hero image. Usage: node <bundled snapshot> <outdir> <path to eink_wasm.wasm>
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { createElement } from 'react';
import { render, unmount, handleEvent } from '../renderer/index.js';
import { TodoApp } from '../apps/todo/index.js';
import { SAMPLE } from '../apps/todo/sample.js';
import { CrosswordApp } from '../apps/crossword/index.js';
import { ReaderApp } from '../apps/reader/index.js';
import { SAMPLE_FILES } from '../files/sample.js';

const wasmBytes = readFileSync(process.argv[3] ?? new URL('../sim/pkg/eink_wasm.wasm', import.meta.url));
const { instance } = await WebAssembly.instantiate(wasmBytes, {});
const ex = instance.exports as any;
const enc = new TextEncoder();
const listeners: Array<(ev: any) => void> = [];
function withStr<T>(s: string, f: (p: number, n: number) => T): T {
  const bytes = enc.encode(s);
  const p = ex.alloc(bytes.length);
  new Uint8Array(ex.memory.buffer).set(bytes, p);
  try { return f(p, bytes.length); } finally { ex.dealloc(p, bytes.length); }
}
const api = {
  width: ex.screen_w() as number,
  height: ex.screen_h() as number,
  create: (kind: string) => ex.create(kind === 'text' ? 1 : 0),
  set_props: (id: number, json: string) => withStr(json, (p, n) => ex.set_props(id, p, n)),
  append: (a: number, b: number) => ex.append(a, b),
  insert_before: (a: number, b: number, c: number) => ex.insert_before(a, b, c),
  remove: (a: number, b: number) => ex.remove(a, b),
  set_root: (id: number) => ex.set_root(id),
  request_full: () => ex.request_full(),
  hit: (x: number, y: number) => ex.hit(x | 0, y | 0),
  commit: () => {
    const n = ex.commit();
    const v = new Int32Array(ex.memory.buffer, ex.damage_ptr(), n * 5);
    const out = [];
    for (let i = 0; i < n; i++) out.push({ x: v[i * 5], y: v[i * 5 + 1], w: v[i * 5 + 2], h: v[i * 5 + 3], mode: v[i * 5 + 4] ? 'gc16' : 'du' });
    return out;
  },
  fb: () => new Uint8Array(ex.memory.buffer, ex.fb_ptr(), ex.fb_len()),
  fb_len: () => ex.fb_len(),
  on: (cb: (ev: any) => void) => { listeners.push(cb); return () => { const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); }; },
  dispatch: (ev: any) => listeners.forEach((cb) => cb(ev)),
  log: (s: string) => console.error('[app]', s),
  battery: () => ({ percent: 82, charging: false }),
  charging: () => false,
  buzz: () => {},
  now: () => Date.UTC(2026, 8, 17, 9, 41),
  tz_offset: () => 0,
  storage_get: () => null,
  storage_set: () => {},
  storage_remove: () => {},
  storage_keys: () => [],
  read_file: (p: string) => SAMPLE_FILES[p] ?? null,
  write_file: () => {},
  list_files: (prefix: string) => Object.keys(SAMPLE_FILES).filter((p) => p.startsWith(prefix)).sort(),
  sync_state: () => ({ state: 'idle' as const, pending: 0, last_sync: null, error: null }),
  sync: () => {},
};
(globalThis as any).__eink = api;
(globalThis as any).setTimeout ??= setTimeout;

// ---- minimal PNG encoder (grayscale 8-bit)
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
function crc32(buf: Uint8Array) { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 0xff]! ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type: string, data: Uint8Array) {
  const t = enc.encode(type); const len = new Uint8Array(4); new DataView(len.buffer).setUint32(0, data.length);
  const body = new Uint8Array(t.length + data.length); body.set(t); body.set(data, t.length);
  const crc = new Uint8Array(4); new DataView(crc.buffer).setUint32(0, crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(gray: Uint8Array, w: number, h: number) {
  const ihdr = new Uint8Array(13); const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h); ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = new Uint8Array((w + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w + 1)] = 0; raw.set(gray.subarray(y * w, (y + 1) * w), y * (w + 1) + 1); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', new Uint8Array(deflateSync(raw))), chunk('IEND', new Uint8Array(0))]);
}
const out = process.argv[2] ?? '.';
function save(name: string) {
  const fb = api.fb();
  writeFileSync(`${out}/${name}.png`, png(fb.slice(), api.width, api.height));
  console.error('wrote', name, api.width, 'x', api.height);
}

// ---- todo: always the bundled sample (the published image must never show a real list)
render(createElement(TodoApp, { data: SAMPLE }));
save('todo');
unmount();

// ---- reader: the newest day file from the sample repository
render(createElement(ReaderApp));
save('reader');
unmount();

// ---- crossword: select the first cell and type a word
render(createElement(CrosswordApp));
api.commit();
const cellId = api.hit(90, 240);
if (cellId) handleEvent({ type: 'tap', id: cellId, x: 90, y: 240 } as any);
for (const k of ['C', 'H', 'A', 'T']) handleEvent({ type: 'key', key: k } as any);
save('crossword');
unmount();
