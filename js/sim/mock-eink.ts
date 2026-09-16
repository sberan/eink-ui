// Pure-TS stand-in for the eink-core wasm module.
// Same function names and return shapes as eink_core::Scene, with a small
// flexbox subset (row/column, gap, padding, margin, justify/align, flex_grow,
// absolute) and a pluggable text backend so it runs in node and in the browser.

import type {
  DamageRect, EinkListener, EinkProps, EinkStyle, NodeId, NodeKind,
  RefreshMode, Sides, SimulatedEinkHost, TextAlign, Unsubscribe,
} from '../host/eink.js';

export const SCREEN_W = 1072;
export const SCREEN_H = 1448;

export interface Rect { x: number; y: number; w: number; h: number }
interface Insets { t: number; r: number; b: number; l: number }
interface Size { w: number; h: number }

export interface TextMetrics {
  readonly w: number;
  readonly h: number;
  readonly lines: readonly string[];
}

export type MeasureText = (
  text: string, fontSize: number, bold: boolean, maxWidth: number | null,
) => TextMetrics;

export interface DrawTextInfo {
  readonly lines: readonly string[];
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly font_size: number;
  readonly bold: boolean;
  readonly color: number;
  readonly align: TextAlign;
  readonly clip: Rect;
}

export type DrawText = (fb: Uint8Array, fbW: number, fbH: number, info: DrawTextInfo) => void;

interface Paint {
  bg: number | null;
  border: number;
  border_color: number;
  color: number;
  text: string;
  font_size: number;
  bold: boolean;
  align: TextAlign;
  hit: boolean;
  radius: number;
}

function defaultPaint(): Paint {
  return {
    bg: null, border: 0, border_color: 0, color: 0, text: '',
    font_size: 32, bold: false, align: 'left', hit: false, radius: 0,
  };
}

export interface MockNode {
  readonly id: NodeId;
  readonly kind: NodeKind;
  paint: Paint;
  style: EinkStyle;
  parent: NodeId;
  children: NodeId[];
  dirty: boolean;
  rect: Rect | null;
  lastRect: Rect | null;
  lines: readonly string[] | null;
  measured: Size | null;
}

const NO_INSETS: Insets = { t: 0, r: 0, b: 0, l: 0 };

function sides(v: Sides | undefined): Insets | null {
  if (v === undefined) return null;
  if (typeof v === 'number') return { t: v, r: v, b: v, l: v };
  return { t: v[0], r: v[1], b: v[2], l: v[3] };
}

function dim(v: EinkStyle['width'], basis: number | null): number | null {
  if (v === undefined || v === 'auto') return null;
  if (typeof v === 'number') return v;
  if (v.endsWith('%')) {
    const p = parseFloat(v) / 100;
    return basis === null ? null : basis * p;
  }
  const n = parseFloat(v);
  return Number.isNaN(n) ? null : n;
}

function clampSize(v: number, min: number | null, max: number | null): number {
  let out = v;
  if (min !== null && out < min) out = min;
  if (max !== null && out > max) out = max;
  return out;
}

/** Fallback measurer: no canvas, serif-ish metrics. Good enough for layout in tests. */
export const approxMeasure: MeasureText = (text, fontSize, bold, maxWidth) => {
  const adv = fontSize * (bold ? 0.54 : 0.5);
  const lineHeight = Math.round(fontSize * 1.28);
  const str = text;
  if (str === '') return { w: 0, h: lineHeight, lines: [''] };
  if (maxWidth === null || !isFinite(maxWidth)) {
    return { w: str.length * adv, h: lineHeight, lines: [str] };
  }
  const lines: string[] = [];
  let cur = '';
  for (const word of str.split(/\s+/)) {
    const next = cur ? `${cur} ${word}` : word;
    if (next.length * adv > maxWidth && cur) { lines.push(cur); cur = word; }
    else cur = next;
  }
  if (cur || !lines.length) lines.push(cur);
  const w = Math.min(maxWidth, Math.max(...lines.map((l) => l.length * adv)));
  return { w, h: lines.length * lineHeight, lines };
};

function rect(x: number, y: number, w: number, h: number): Rect {
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}
function rectEq(a: Rect | null, b: Rect | null): boolean {
  return !!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}
function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}
function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}
function area(r: Rect): number { return Math.max(0, r.w) * Math.max(0, r.h); }

/** Merge rects that overlap or whose union wastes little area. */
export function coalesce(list: readonly Rect[]): Rect[] {
  const rects = list.filter((r) => r.w > 0 && r.h > 0);
  let merged = true;
  while (merged && rects.length > 1) {
    merged = false;
    outer:
    for (let i = 0; i < rects.length; i++) {
      const a = rects[i];
      if (!a) continue;
      for (let j = i + 1; j < rects.length; j++) {
        const b = rects[j];
        if (!b) continue;
        const u = union(a, b);
        if (intersects(a, b) || area(u) <= (area(a) + area(b)) * 1.35) {
          rects.splice(j, 1);
          rects.splice(i, 1, u);
          merged = true;
          break outer;
        }
      }
    }
  }
  return rects;
}

export interface MockOptions {
  width?: number;
  height?: number;
  measureText?: MeasureText;
  drawText?: DrawText | null;
  /** Force a gc16 flash after this many partials; 0 disables. */
  fullEvery?: number;
}

export interface MockEinkHost extends SimulatedEinkHost {
  /** The mock can always unsubscribe, unlike the Kindle host. */
  on(cb: EinkListener): Unsubscribe;
  fb_len(): number;
  size(): Size;
  stats(): { creates: number; setProps: number; commits: number; partials: number };
  readonly _nodes: ReadonlyMap<NodeId, MockNode>;
  _root(): NodeId;
}

export function createMockEink(options: MockOptions = {}): MockEinkHost {
  const W = options.width ?? SCREEN_W;
  const H = options.height ?? SCREEN_H;
  const measureText = options.measureText ?? approxMeasure;
  const drawText = options.drawText ?? null;
  const fullEvery = options.fullEvery ?? 8;

  const nodes = new Map<NodeId, MockNode>();
  let nextId = 1;
  let rootId = 0;
  const fb = new Uint8Array(W * H).fill(255);
  let fullRequested = true;
  let committedOnce = false;
  let partials = 0;
  let pendingHoles: Rect[] = [];
  let listener: EinkListener | null = null;
  const log = { creates: 0, setProps: 0, commits: 0 };

  const node = (id: NodeId): MockNode | undefined => nodes.get(id);
  const kids = (n: MockNode): MockNode[] =>
    n.children.map(node).filter((c): c is MockNode => c !== undefined);

  function fill(r: Rect, gray: number): void {
    const x0 = Math.max(0, r.x);
    const y0 = Math.max(0, r.y);
    const x1 = Math.min(W, r.x + r.w);
    const y1 = Math.min(H, r.y + r.h);
    for (let y = y0; y < y1; y++) fb.fill(gray, y * W + x0, y * W + x1);
  }

  function clip(r: Rect, c: Rect): Rect {
    const x0 = Math.max(r.x, c.x);
    const y0 = Math.max(r.y, c.y);
    return { x: x0, y: y0, w: Math.min(r.x + r.w, c.x + c.w) - x0, h: Math.min(r.y + r.h, c.y + c.h) - y0 };
  }

  // ---- layout -------------------------------------------------------------

  const marginOf = (n: MockNode): Insets => sides(n.style.margin) ?? NO_INSETS;

  function measure(n: MockNode, availW: number | null, availH: number | null): Size {
    const s = n.style;
    if (s.display === 'none') return { w: 0, h: 0 };
    const pad = sides(s.padding) ?? NO_INSETS;
    const bw = n.paint.border;
    const insetW = pad.l + pad.r + bw * 2;
    const insetH = pad.t + pad.b + bw * 2;

    const defW = dim(s.width, availW);
    const defH = dim(s.height, availH);
    const minW = dim(s.min_width, availW);
    const maxW = dim(s.max_width, availW);
    const minH = dim(s.min_height, availH);
    const maxH = dim(s.max_height, availH);

    const innerAvailW = defW !== null ? defW - insetW : (availW === null ? null : availW - insetW);
    const innerAvailH = defH !== null ? defH - insetH : (availH === null ? null : availH - insetH);

    let contentW = 0;
    let contentH = 0;

    if (n.kind === 'text') {
      const m = measureText(n.paint.text, n.paint.font_size, n.paint.bold, innerAvailW);
      n.lines = m.lines;
      contentW = m.w;
      contentH = m.h;
    } else {
      const dir = s.flex_direction === 'row' ? 'row' : 'column';
      const gap = s.gap ?? 0;
      const visible = kids(n).filter((c) => c.style.display !== 'none');
      const flow = visible.filter((c) => c.style.position !== 'absolute');
      let main = 0;
      let cross = 0;
      for (const c of flow) {
        const m = measure(c, innerAvailW, innerAvailH);
        c.measured = m;
        const mg = marginOf(c);
        if (dir === 'row') {
          main += m.w + mg.l + mg.r;
          cross = Math.max(cross, m.h + mg.t + mg.b);
        } else {
          main += m.h + mg.t + mg.b;
          cross = Math.max(cross, m.w + mg.l + mg.r);
        }
      }
      if (flow.length > 1) main += gap * (flow.length - 1);
      contentW = dir === 'row' ? main : cross;
      contentH = dir === 'row' ? cross : main;
      for (const c of visible) {
        if (c.style.position === 'absolute') c.measured = measure(c, innerAvailW, innerAvailH);
      }
    }

    return {
      w: clampSize(defW !== null ? defW : contentW + insetW, minW, maxW),
      h: clampSize(defH !== null ? defH : contentH + insetH, minH, maxH),
    };
  }

  function place(n: MockNode, x: number, y: number, w: number, h: number): void {
    const s = n.style;
    if (s.display === 'none') { n.rect = null; return; }
    n.rect = rect(x, y, w, h);
    if (n.kind === 'text') return;

    const pad = sides(s.padding) ?? NO_INSETS;
    const bw = n.paint.border;
    const cx = x + pad.l + bw;
    const cy = y + pad.t + bw;
    const cw = w - pad.l - pad.r - bw * 2;
    const ch = h - pad.t - pad.b - bw * 2;
    const dir = s.flex_direction === 'row' ? 'row' : 'column';
    const gap = s.gap ?? 0;
    const visible = kids(n).filter((c) => c.style.display !== 'none');

    const items = visible
      .filter((c) => c.style.position !== 'absolute')
      .map((c) => ({ node: c, size: c.measured ?? measure(c, cw, ch), margin: marginOf(c) }));

    let used = items.reduce((a, it) => a + (dir === 'row'
      ? it.size.w + it.margin.l + it.margin.r
      : it.size.h + it.margin.t + it.margin.b), 0);
    if (items.length > 1) used += gap * (items.length - 1);
    let free = (dir === 'row' ? cw : ch) - used;

    const growTotal = items.reduce((a, it) => a + (it.node.style.flex_grow ?? 0), 0);
    if (free > 0 && growTotal > 0) {
      for (const it of items) {
        const g = it.node.style.flex_grow ?? 0;
        if (!g) continue;
        const add = free * (g / growTotal);
        it.size = dir === 'row'
          ? { w: it.size.w + add, h: it.size.h }
          : { w: it.size.w, h: it.size.h + add };
      }
      free = 0;
    }

    const justify = s.justify_content ?? 'start';
    let cursor = 0;
    let between = gap;
    if (free > 0 && items.length) {
      if (justify === 'center') cursor = free / 2;
      else if (justify === 'end' || justify === 'flex-end') cursor = free;
      else if (justify === 'space-between' && items.length > 1) between = gap + free / (items.length - 1);
      else if (justify === 'space-around') {
        cursor = free / items.length / 2;
        between = gap + free / items.length;
      } else if (justify === 'space-evenly') {
        cursor = free / (items.length + 1);
        between = gap + free / (items.length + 1);
      }
    }

    for (const it of items) {
      const c = it.node;
      const mg = it.margin;
      const align = c.style.align_self ?? s.align_items ?? 'stretch';
      const crossMargin = dir === 'row' ? mg.t + mg.b : mg.l + mg.r;
      const crossAvail = (dir === 'row' ? ch : cw) - crossMargin;
      let crossSize = dir === 'row' ? it.size.h : it.size.w;
      const explicit = dir === 'row'
        ? dim(c.style.height, ch) !== null
        : dim(c.style.width, cw) !== null;
      if (align === 'stretch' && !explicit) crossSize = crossAvail;
      let crossPos = dir === 'row' ? mg.t : mg.l;
      if (align === 'center') crossPos += (crossAvail - crossSize) / 2;
      else if (align === 'end' || align === 'flex-end') crossPos += crossAvail - crossSize;

      if (dir === 'row') place(c, cx + cursor + mg.l, cy + crossPos, it.size.w, crossSize);
      else place(c, cx + crossPos, cy + cursor + mg.t, crossSize, it.size.h);
      cursor += (dir === 'row' ? it.size.w + mg.l + mg.r : it.size.h + mg.t + mg.b) + between;
    }

    for (const c of visible) {
      if (c.style.position !== 'absolute') continue;
      const m = c.measured ?? measure(c, cw, ch);
      const cs = c.style;
      const left = cs.left ?? null;
      const right = cs.right ?? null;
      const top = cs.top ?? null;
      const bottom = cs.bottom ?? null;
      const dw = dim(cs.width, cw);
      const dh = dim(cs.height, ch);
      const aw = dw !== null ? dw : (left !== null && right !== null ? cw - left - right : m.w);
      const ah = dh !== null ? dh : (top !== null && bottom !== null ? ch - top - bottom : m.h);
      const ax = left !== null ? cx + left : (right !== null ? cx + cw - right - aw : cx);
      const ay = top !== null ? cy + top : (bottom !== null ? cy + ch - bottom - ah : cy);
      place(c, ax, ay, aw, ah);
    }
  }

  // ---- paint --------------------------------------------------------------

  function paintNode(n: MockNode, clipRect: Rect): void {
    const r = n.rect;
    if (!r) return;
    const p = n.paint;
    if (n.kind === 'box') {
      if (p.bg !== null) fill(clip(r, clipRect), p.bg);
      const bw = p.border;
      if (bw > 0) {
        const c = p.border_color;
        fill(clip({ x: r.x, y: r.y, w: r.w, h: bw }, clipRect), c);
        fill(clip({ x: r.x, y: r.y + r.h - bw, w: r.w, h: bw }, clipRect), c);
        fill(clip({ x: r.x, y: r.y, w: bw, h: r.h }, clipRect), c);
        fill(clip({ x: r.x + r.w - bw, y: r.y, w: bw, h: r.h }, clipRect), c);
      }
      return;
    }
    if (p.bg !== null) fill(clip(r, clipRect), p.bg);
    if (!p.text || !drawText) return;
    drawText(fb, W, H, {
      lines: n.lines ?? [p.text],
      text: p.text,
      x: r.x, y: r.y, w: r.w, h: r.h,
      font_size: p.font_size, bold: p.bold, color: p.color, align: p.align,
      clip: clip(r, clipRect),
    });
  }

  function detachNode(child: NodeId): void {
    const cn = node(child);
    if (!cn || !cn.parent) return;
    const pn = node(cn.parent);
    if (pn) {
      const i = pn.children.indexOf(child);
      if (i !== -1) pn.children.splice(i, 1);
      pn.dirty = true;
    }
    cn.parent = 0;
  }

  function collectHoles(id: NodeId): void {
    const n = node(id);
    if (!n) return;
    if (n.lastRect) pendingHoles.push(n.lastRect);
    for (const c of n.children) collectHoles(c);
  }

  function applyProps(n: MockNode, p: EinkProps): void {
    if (p.style) { Object.assign(n.style, p.style); n.dirty = true; }
    const before = n.paint;
    const next: Paint = {
      bg: p.bg !== undefined ? p.bg : before.bg,
      border: p.border ?? before.border,
      border_color: p.border_color ?? before.border_color,
      color: p.color ?? before.color,
      text: p.text ?? before.text,
      font_size: p.font_size ?? before.font_size,
      bold: p.bold ?? before.bold,
      align: p.align ?? before.align,
      hit: p.hit ?? before.hit,
      radius: p.radius ?? before.radius,
    };
    for (const k of Object.keys(next) as (keyof Paint)[]) {
      if (next[k] !== before[k]) { n.paint = next; n.dirty = true; return; }
    }
  }

  const api: MockEinkHost = {
    width: W,
    height: H,

    create(kind: NodeKind): NodeId {
      const id = nextId++;
      log.creates++;
      nodes.set(id, {
        id, kind: kind === 'text' ? 'text' : 'box',
        paint: defaultPaint(), style: {},
        parent: 0, children: [], dirty: true,
        rect: null, lastRect: null, lines: null, measured: null,
      });
      return id;
    },

    set_props(id: NodeId, json: string): void {
      log.setProps++;
      const n = node(id);
      if (!n) return;
      // JSON boundary: the payload was produced by renderer/host.ts
      applyProps(n, JSON.parse(json) as EinkProps);
    },

    append(parent: NodeId, child: NodeId): void {
      detachNode(child);
      const pn = node(parent);
      const cn = node(child);
      if (!pn || !cn) return;
      pn.children.push(child);
      cn.parent = parent;
      cn.dirty = true;
      pn.dirty = true;
    },

    insert_before(parent: NodeId, child: NodeId, before: NodeId): void {
      detachNode(child);
      const pn = node(parent);
      const cn = node(child);
      if (!pn || !cn) return;
      const i = pn.children.indexOf(before);
      if (i === -1) pn.children.push(child);
      else pn.children.splice(i, 0, child);
      cn.parent = parent;
      cn.dirty = true;
      pn.dirty = true;
    },

    remove(parent: NodeId, child: NodeId): void {
      const cn = node(child);
      if (!cn || cn.parent !== parent) return;
      collectHoles(child);
      detachNode(child);
    },

    set_root(id: NodeId): void { rootId = id; fullRequested = true; },

    request_full(): void { fullRequested = true; },

    hit(x: number, y: number): NodeId {
      const walk = (id: NodeId): NodeId => {
        const n = node(id);
        const r = n?.lastRect;
        if (!n || !r) return 0;
        if (x < r.x || y < r.y || x >= r.x + r.w || y >= r.y + r.h) return 0;
        for (let i = n.children.length - 1; i >= 0; i--) {
          const child = n.children[i];
          const h = child === undefined ? 0 : walk(child);
          if (h) return h;
        }
        return n.paint.hit ? id : 0;
      };
      return rootId ? walk(rootId) : 0;
    },

    commit(): DamageRect[] {
      log.commits++;
      const root = node(rootId);
      if (!root) return [];
      const m = measure(root, W, H);
      const rw = dim(root.style.width, W);
      const rh = dim(root.style.height, H);
      place(root, 0, 0, rw ?? (m.w || W), rh ?? (m.h || H));

      const order: MockNode[] = [];
      const collect = (id: NodeId): void => {
        const n = node(id);
        if (!n || !n.rect) return;
        order.push(n);
        for (const c of n.children) collect(c);
      };
      collect(rootId);

      const changed: Rect[] = [];
      for (const n of order) {
        if (n.dirty || !rectEq(n.lastRect, n.rect)) {
          if (n.lastRect) changed.push(n.lastRect);
          if (n.rect) changed.push(n.rect);
          n.dirty = false;
        }
        n.lastRect = n.rect;
      }

      const full = fullRequested || !committedOnce || (fullEvery > 0 && partials >= fullEvery);
      const mode: RefreshMode = full ? 'gc16' : 'du';
      let damage: Rect[];
      if (full) {
        fullRequested = false;
        partials = 0;
        committedOnce = true;
        pendingHoles = [];
        damage = [{ x: 0, y: 0, w: W, h: H }];
      } else {
        damage = coalesce(pendingHoles.concat(changed));
        pendingHoles = [];
        if (!damage.length) return [];
        partials++;
      }

      for (const d of damage) {
        fill(d, 255);
        for (const n of order) {
          if (n.rect && intersects(n.rect, d)) paintNode(n, d);
        }
      }
      return damage.map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h, mode }));
    },

    on(cb: EinkListener): Unsubscribe {
      listener = cb;
      return () => { if (listener === cb) listener = null; };
    },

    log(msg: string): void { console.log(`[eink] ${msg}`); },
    buzz(): void { /* no haptics in the simulator */ },
    charging(): boolean { return false; },
    now(): number { return Date.now(); },

    emit(ev): void { listener?.(ev); },
    fb(): Uint8Array { return fb; },
    fb_len(): number { return fb.length; },
    size(): Size { return { w: W, h: H }; },
    stats() { return { ...log, partials }; },
    _nodes: nodes,
    _root: () => rootId,
  };

  // conformance with the documented host contract
  const _check: SimulatedEinkHost = api;
  void _check;

  return api;
}
