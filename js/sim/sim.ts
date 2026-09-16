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
import { TodoApp } from '../apps/todo/index.js';
import { CrosswordApp } from '../apps/crossword/index.js';
import { STORIES, findStory } from '../stories/index.js';

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

// ---- gallery + routing ---------------------------------------------------

type AppName = 'todo' | 'crossword';

const APPS: readonly { readonly name: AppName; readonly label: string; readonly render: () => ReactElement }[] = [
  { name: 'todo', label: 'Todo', render: () => React.createElement(TodoApp) },
  { name: 'crossword', label: 'Crossword', render: () => React.createElement(CrosswordApp) },
];

type Route =
  | { readonly kind: 'app'; readonly name: AppName }
  | { readonly kind: 'story'; readonly id: string };

const DEFAULT_ROUTE: Route = { kind: 'story', id: STORIES[0]?.id ?? '' };

function parseRoute(hash: string): Route {
  const m = /^#\/(app|story)\/(.+)$/.exec(hash);
  if (!m) return DEFAULT_ROUTE;
  if (m[1] === 'app') {
    const name = m[2];
    if (name === 'todo' || name === 'crossword') return { kind: 'app', name };
    return DEFAULT_ROUTE;
  }
  return findStory(m[2] ?? '') ? { kind: 'story', id: m[2] ?? '' } : DEFAULT_ROUTE;
}

function hrefOf(route: Route): string {
  return route.kind === 'app' ? `#/app/${route.name}` : `#/story/${route.id}`;
}

function sameRoute(a: Route, b: Route): boolean {
  return hrefOf(a) === hrefOf(b);
}

/** Plain-DOM sidebar: an anchor per entry, so deep links and back/forward just work. */
function buildSidebar(): void {
  const add = (text: string): void => {
    const el = document.createElement('div');
    el.className = 'group';
    el.textContent = text;
    sidebar.append(el);
  };
  const link = (route: Route, text: string): void => {
    const a = document.createElement('a');
    a.href = hrefOf(route);
    a.textContent = text;
    a.dataset['route'] = hrefOf(route);
    sidebar.append(a);
  };

  add('Apps');
  for (const app of APPS) link({ kind: 'app', name: app.name }, app.label);

  let group = '';
  for (const s of STORIES) {
    if (s.group !== group) { group = s.group; add(group); }
    link({ kind: 'story', id: s.id }, s.name);
  }
}

function markActive(route: Route): void {
  const want = hrefOf(route);
  for (const a of sidebar.querySelectorAll('a')) {
    a.classList.toggle('on', a.dataset['route'] === want);
  }
}

function elementFor(route: Route): { element: ReactElement; title: string } | null {
  if (route.kind === 'app') {
    const app = APPS.find((a) => a.name === route.name);
    return app ? { element: app.render(), title: `Apps / ${app.label}` } : null;
  }
  const story = findStory(route.id);
  return story ? { element: story.render(), title: `${story.group} / ${story.name}` } : null;
}

let current: Route | null = null;

function show(route: Route, force = false): void {
  if (!force && current && sameRoute(current, route)) return;
  const picked = elementFor(route);
  if (!picked) return;
  current = route;
  markActive(route);
  titleEl.textContent = picked.title;
  // the renderer and the host are singletons: unmount before mounting the next
  unmount();
  inFlight.length = 0;
  stats = EMPTY_STATS;
  eink.request_full();
  render(picked.element);
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
    host.emit({ type: 'tap', id: host.hit(x, y), x, y });
  });

  window.addEventListener('keydown', (ev) => {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    let key = ev.key;
    if (key === 'Backspace') key = 'BACKSPACE';
    else if (key === 'Enter') key = 'ENTER';
    else if (key.length !== 1) return;
    ev.preventDefault();
    host.emit({ type: 'key', key });
  });

  must<HTMLButtonElement>('full').onclick = () => {
    host.request_full();
    onPaint(host.commit());
  };
  window.addEventListener('resize', fitScale);
  window.addEventListener('hashchange', () => { show(parseRoute(location.hash)); });

  buildSidebar();
  show(parseRoute(location.hash), true);
  fitScale();
  requestAnimationFrame(frame);
});
