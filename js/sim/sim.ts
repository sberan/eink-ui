// Browser simulator and component gallery: real e-ink waveform timing over the
// same React bundle the Kindle runs. Uses the wasm build of eink-core when
// pkg/eink_wasm.js is present, otherwise the pure-TS host in mock-eink.ts.
import React from 'react';
import type { ReactElement } from 'react';
import type { DamageRect, SimulatedEinkHost, TextAlign } from '../host/eink.js';
import { render, unmount } from '../renderer/index.js';
import { createMockEink, type DrawText, type MeasureText } from './mock-eink.js';
import {
  EMPTY_STATS, commitStats, formatRects, isDone, overlayFor, type CommitStats,
} from './display.js';
import { GalleryApp, PAGES, findPage } from '../apps/gallery/index.js';

const W = 1072;
const H = 1448;

function must<T extends Element>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} is missing from index.html`);
  return el as unknown as T;
}

function context2d(canvas: HTMLCanvasElement, alpha: boolean): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d', { alpha });
  if (!ctx) throw new Error('2d canvas context unavailable');
  return ctx;
}

const canvas = must<HTMLCanvasElement>('screen');
const ctx = context2d(canvas, false);
const statusEl = must<HTMLDivElement>('status');
const hostEl = must<HTMLSpanElement>('host');
const stage = must<HTMLDivElement>('stage');
const sidebar = must<HTMLElement>('sidebar');
const titleEl = must<HTMLSpanElement>('title');

// ---- text backend for the mock (canvas metrics + glyph blitting) ----------

const textCanvas = document.createElement('canvas');
const tctx = (() => {
  const c = textCanvas.getContext('2d', { willReadFrequently: true });
  if (!c) throw new Error('2d canvas context unavailable');
  return c;
})();

const fontOf = (size: number, bold: boolean) =>
  `${bold ? '700 ' : '400 '}${size}px "Noto Serif", Georgia, serif`;
const lineHeight = (size: number) => Math.round(size * 1.28);

const measureText: MeasureText = (text, fontSize, bold, maxWidth) => {
  const lh = lineHeight(fontSize);
  tctx.font = fontOf(fontSize, bold);
  if (text === '') return { w: 0, h: lh, lines: [''] };
  const widthOf = (s: string) => tctx.measureText(s).width;
  if (maxWidth === null || !isFinite(maxWidth)) {
    return { w: widthOf(text), h: lh, lines: [text] };
  }
  const lines: string[] = [];
  let cur = '';
  for (const word of text.split(/\s+/)) {
    const next = cur ? `${cur} ${word}` : word;
    if (widthOf(next) > maxWidth && cur) { lines.push(cur); cur = word; }
    else cur = next;
  }
  if (cur || !lines.length) lines.push(cur);
  return { w: Math.min(maxWidth, Math.max(...lines.map(widthOf))), h: lines.length * lh, lines };
};

function alignX(align: TextAlign, boxWidth: number, textWidth: number): number {
  if (align === 'center') return (boxWidth - textWidth) / 2;
  if (align === 'right') return boxWidth - textWidth;
  return 0;
}

const drawText: DrawText = (fb, fbW, fbH, info) => {
  const cw = Math.max(1, Math.ceil(info.w));
  const chh = Math.max(1, Math.ceil(info.h));
  if (textCanvas.width < cw) textCanvas.width = cw;
  if (textCanvas.height < chh) textCanvas.height = chh;
  tctx.save();
  tctx.setTransform(1, 0, 0, 1, 0, 0);
  tctx.fillStyle = '#fff';
  tctx.fillRect(0, 0, cw, chh);
  tctx.fillStyle = '#000';
  tctx.font = fontOf(info.font_size, info.bold);
  tctx.textBaseline = 'alphabetic';
  const lh = lineHeight(info.font_size);
  const lines = info.lines.length ? info.lines : [info.text];
  const top = Math.max(0, (info.h - lines.length * lh) / 2);
  lines.forEach((line, i) => {
    tctx.fillText(line, alignX(info.align, info.w, tctx.measureText(line).width), top + i * lh + lh * 0.78);
  });
  const img = tctx.getImageData(0, 0, cw, chh).data;
  tctx.restore();

  const { clip } = info;
  const x0 = Math.max(clip.x, info.x);
  const y0 = Math.max(clip.y, info.y);
  const x1 = Math.min(clip.x + clip.w, info.x + cw, fbW);
  const y1 = Math.min(clip.y + clip.h, info.y + chh, fbH);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const cov = (255 - (img[((y - info.y) * cw + (x - info.x)) * 4] ?? 255)) / 255;
      if (cov <= 0) continue;
      const gray = Math.round(255 - cov * (255 - info.color));
      const di = y * fbW + x;
      if (gray < (fb[di] ?? 255)) fb[di] = gray;
    }
  }
};

// ---- host selection -------------------------------------------------------

interface WasmGlue { loadEink?: (url?: string | URL) => Promise<SimulatedEinkHost> }

async function loadHost(): Promise<SimulatedEinkHost> {
  try {
    // hidden from esbuild so pkg/ stays a runtime, page-relative dependency
    const dynImport = new Function('u', 'return import(u)') as (u: string) => Promise<unknown>;
    const mod = await dynImport('./pkg/eink_wasm.js') as WasmGlue;
    if (typeof mod.loadEink === 'function') {
      hostEl.textContent = 'host: wasm (eink-core)';
      return await mod.loadEink();
    }
  } catch (err) {
    console.warn('wasm host unavailable, using the JS mock:', err);
  }
  hostEl.textContent = 'host: JS mock';
  return createMockEink({ measureText, drawText });
}

// ---- e-ink display --------------------------------------------------------

const finalCanvas = document.createElement('canvas');
finalCanvas.width = W;
finalCanvas.height = H;
const fctx = context2d(finalCanvas, false);
const image = fctx.createImageData(W, H);

interface Flight extends DamageRect { t0: number }
const inFlight: Flight[] = [];
let stats: CommitStats = EMPTY_STATS;
let eink: SimulatedEinkHost;

function blitFramebuffer(fb: Uint8Array): void {
  const d = image.data;
  for (let i = 0, j = 0; i < fb.length; i++, j += 4) {
    const v = fb[i] ?? 255;
    d[j] = v; d[j + 1] = v; d[j + 2] = v; d[j + 3] = 255;
  }
  fctx.putImageData(image, 0, 0);
}

function onPaint(damage: DamageRect[]): void {
  const now = performance.now();
  for (const r of damage) inFlight.push({ ...r, t0: now });
  stats = commitStats(stats, damage, W, H);
  blitFramebuffer(eink.fb());
  updateStatus();
}

function updateStatus(): void {
  statusEl.innerHTML =
    `<span class="k">partials since full refresh:</span> ${stats.partialsSinceFull}`
    + `   <span class="k">last commit:</span> ${stats.rects.length} rect(s), `
    + `<span class="w">${stats.areaPct.toFixed(2)}%</span> of the panel\n`
    + formatRects(stats.rects);
}

function frame(): void {
  const now = performance.now();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(finalCanvas, 0, 0);
  for (let i = inFlight.length - 1; i >= 0; i--) {
    const r = inFlight[i];
    if (!r) continue;
    const dt = now - r.t0;
    if (isDone(r.mode, dt)) { inFlight.splice(i, 1); continue; }
    const fill = overlayFor(r.mode, dt);
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fillRect(r.x, r.y, r.w, r.h);
    }
  }
  requestAnimationFrame(frame);
}

function fitScale(): void {
  const s = Math.min((stage.clientWidth - 20) / W, (stage.clientHeight - 20) / H);
  canvas.style.width = `${Math.floor(W * s)}px`;
  canvas.style.height = `${Math.floor(H * s)}px`;
}

// ---- the gallery app + routing -------------------------------------------
// One app, the gallery, runs the whole time; the page shown is its `page` prop, which the URL
// hash, the sidebar, the keyboard and the app's own corner tabs all drive through show().

const DEFAULT_PAGE = PAGES[0]?.id ?? '';

/** `#/page/<id>`; the older `#/story/<id>` and `#/app/<name>` links still resolve. */
function parseRoute(hash: string): string {
  const m = /^#\/(page|story|app)\/(.+)$/.exec(hash);
  if (!m) return DEFAULT_PAGE;
  const id = m[1] === 'app' ? `apps--${m[2] ?? ''}` : (m[2] ?? '');
  return findPage(id) ? id : DEFAULT_PAGE;
}

const hrefOf = (id: string): string => `#/page/${id}`;

/** Plain-DOM sidebar: an anchor per page, so deep links and back/forward just work. */
function buildSidebar(): void {
  const add = (text: string): void => {
    const el = document.createElement('div');
    el.className = 'group';
    el.textContent = text;
    sidebar.append(el);
  };
  let group = '';
  for (const p of PAGES) {
    if (p.group !== group) { group = p.group; add(group); }
    const a = document.createElement('a');
    a.href = hrefOf(p.id);
    a.textContent = p.name;
    a.dataset['page'] = p.id;
    sidebar.append(a);
  }
}

function markActive(id: string): void {
  for (const a of sidebar.querySelectorAll('a')) {
    a.classList.toggle('on', a.dataset['page'] === id);
  }
}

let current = '';

function show(id: string): void {
  const page = findPage(id);
  if (!page || id === current) return;
  current = id;
  markActive(id);
  titleEl.textContent = `${page.group} / ${page.name}`;
  if (location.hash !== hrefOf(id)) history.replaceState(null, '', hrefOf(id));
  inFlight.length = 0;
  stats = EMPTY_STATS;
  // a page change repaints most of the panel: a full refresh, as the device would do
  eink.request_full();
  render(React.createElement(GalleryApp, { page: id, onPage: show }));
}

function step(by: number): void {
  const n = PAGES.length;
  const i = Math.max(0, PAGES.findIndex((p) => p.id === current));
  const next = PAGES[(((i + by) % n) + n) % n];
  if (next) show(next.id);
}

// ---- boot -----------------------------------------------------------------

void loadHost().then((host) => {
  eink = host;
  globalThis.__eink = host;
  globalThis.__eink_paint = onPaint;

  canvas.addEventListener('mousedown', (ev) => {
    const b = canvas.getBoundingClientRect();
    const x = Math.round((ev.clientX - b.left) * (W / b.width));
    const y = Math.round((ev.clientY - b.top) * (H / b.height));
    const line = host.hit_line(x, y);
    host.emit(line >= 0 ? { type: 'tap', id: host.hit(x, y), x, y, line } : { type: 'tap', id: host.hit(x, y), x, y });
  });

  window.addEventListener('keydown', (ev) => {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    let key = ev.key;
    // arrows walk the gallery; Page Up/Down are the device's page buttons and go to the page shown
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      ev.preventDefault();
      step(key === 'ArrowLeft' ? -1 : 1);
      return;
    }
    if (key === 'Backspace') key = 'BACKSPACE';
    else if (key === 'Enter') key = 'ENTER';
    else if (key !== 'PageUp' && key !== 'PageDown' && key.length !== 1) return;
    ev.preventDefault();
    host.emit({ type: 'key', key });
  });

  must<HTMLButtonElement>('full').onclick = () => {
    host.request_full();
    onPaint(host.commit());
  };
  must<HTMLButtonElement>('prev').onclick = () => step(-1);
  must<HTMLButtonElement>('next').onclick = () => step(1);
  must<HTMLButtonElement>('pageup').onclick = () => host.emit({ type: 'key', key: 'PageUp' });
  must<HTMLButtonElement>('pagedown').onclick = () => host.emit({ type: 'key', key: 'PageDown' });
  window.addEventListener('resize', fitScale);
  window.addEventListener('hashchange', () => { show(parseRoute(location.hash)); });

  // for the DevTools console: the host and the gallery
  Object.assign(globalThis, { eink: host, gallery: { pages: PAGES.map((p) => p.id), show, step } });
  console.info('eink-ui: `eink` is the host (eink.hit(x, y), eink.commit()), `gallery.show(id)` and `gallery.pages` drive the pages');

  buildSidebar();
  show(parseRoute(location.hash));
  fitScale();
  requestAnimationFrame(frame);
});
