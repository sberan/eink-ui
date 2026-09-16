import { describe, it, expect } from 'vitest';
import { approxMeasure, coalesce, createMockEink, type MockEinkHost } from '../sim/mock-eink.js';
import type { EinkProps, NodeId } from '../host/eink.js';

function box(e: MockEinkHost, props: EinkProps, parent?: NodeId): NodeId {
  const id = e.create('box');
  e.set_props(id, JSON.stringify(props));
  if (parent !== undefined) e.append(parent, id);
  return id;
}

function root(e: MockEinkHost): NodeId {
  const r = box(e, { style: { width: 1072, height: 1448, flex_direction: 'column' }, bg: 255 });
  e.set_root(r);
  return r;
}

const rectOf = (e: MockEinkHost, id: NodeId) => e._nodes.get(id)?.lastRect;

describe('mock layout', () => {
  it('stacks a column and sizes a row', () => {
    const e = createMockEink();
    const r = root(e);
    const a = box(e, { style: { height: 100 }, bg: 200 }, r);
    const b = box(e, { style: { height: 50 }, bg: 100 }, r);
    e.commit();
    expect(rectOf(e, a)).toEqual({ x: 0, y: 0, w: 1072, h: 100 });
    expect(rectOf(e, b)).toEqual({ x: 0, y: 100, w: 1072, h: 50 });
  });

  it('honours padding, gap and flex_direction row', () => {
    const e = createMockEink();
    const r = root(e);
    const row = box(e, { style: { flex_direction: 'row', padding: 10, gap: 20, height: 80 } }, r);
    const a = box(e, { style: { width: 100 } }, row);
    const b = box(e, { style: { width: 100 } }, row);
    e.commit();
    expect(rectOf(e, a)).toMatchObject({ x: 10, y: 10, w: 100 });
    expect(rectOf(e, b)).toMatchObject({ x: 130, y: 10, w: 100 });
  });

  it('distributes free space with flex_grow', () => {
    const e = createMockEink();
    const r = root(e);
    const row = box(e, { style: { flex_direction: 'row', height: 40, width: 300 } }, r);
    const a = box(e, { style: { flex_grow: 1 } }, row);
    const b = box(e, { style: { flex_grow: 3 } }, row);
    e.commit();
    expect(rectOf(e, a)?.w).toBe(75);
    expect(rectOf(e, b)?.w).toBe(225);
  });

  it('offsets children by their margin', () => {
    const e = createMockEink();
    const r = root(e);
    const a = box(e, { style: { height: 40, margin: [10, 0, 0, 25] } }, r);
    const b = box(e, { style: { height: 40 } }, r);
    e.commit();
    expect(rectOf(e, a)).toEqual({ x: 25, y: 10, w: 1047, h: 40 });
    expect(rectOf(e, b)?.y).toBe(50);
  });

  it('skips display:none subtrees', () => {
    const e = createMockEink();
    const r = root(e);
    const a = box(e, { style: { height: 100, display: 'none' } }, r);
    const b = box(e, { style: { height: 50 } }, r);
    e.commit();
    expect(rectOf(e, a)).toBe(null);
    expect(rectOf(e, b)?.y).toBe(0);
  });

  it('places absolute children against the padding box', () => {
    const e = createMockEink();
    const r = root(e);
    const a = box(e, { style: { position: 'absolute', left: 40, bottom: 0, width: 200, height: 60 } }, r);
    e.commit();
    expect(rectOf(e, a)).toEqual({ x: 40, y: 1388, w: 200, h: 60 });
  });
});

describe('mock damage + refresh policy', () => {
  it('first commit is a full gc16 flash', () => {
    const e = createMockEink();
    root(e);
    expect(e.commit()).toEqual([{ x: 0, y: 0, w: 1072, h: 1448, mode: 'gc16' }]);
  });

  it('an unchanged commit produces no damage', () => {
    const e = createMockEink();
    root(e);
    e.commit();
    expect(e.commit()).toEqual([]);
  });

  it('a changed node produces a du rect covering it', () => {
    const e = createMockEink();
    const r = root(e);
    const a = box(e, { style: { height: 100 }, bg: 200 }, r);
    e.commit();
    e.set_props(a, JSON.stringify({ bg: 20 }));
    expect(e.commit()).toEqual([{ x: 0, y: 0, w: 1072, h: 100, mode: 'du' }]);
    expect(e.fb()[0]).toBe(20);
  });

  it('a removed node leaves a hole that is repainted', () => {
    const e = createMockEink();
    const r = root(e);
    const a = box(e, { style: { height: 100 }, bg: 0 }, r);
    e.commit();
    e.remove(r, a);
    expect(e.commit()[0]?.mode).toBe('du');
    expect(e.fb()[0]).toBe(255);
  });

  it('forces a full flash every N partials', () => {
    const e = createMockEink({ fullEvery: 3 });
    const r = root(e);
    const a = box(e, { style: { height: 10 }, bg: 200 }, r);
    e.commit();
    const modes: (string | undefined)[] = [];
    for (let i = 0; i < 5; i++) {
      e.set_props(a, JSON.stringify({ bg: 100 + i }));
      modes.push(e.commit()[0]?.mode);
    }
    expect(modes).toEqual(['du', 'du', 'du', 'gc16', 'du']);
  });

  it('request_full makes the next commit gc16', () => {
    const e = createMockEink();
    const r = root(e);
    const a = box(e, { style: { height: 10 }, bg: 1 }, r);
    e.commit();
    e.set_props(a, JSON.stringify({ bg: 2 }));
    e.request_full();
    expect(e.commit()[0]).toMatchObject({ w: 1072, h: 1448, mode: 'gc16' });
  });
});

describe('mock hit testing', () => {
  it('returns the deepest node with hit:true', () => {
    const e = createMockEink();
    const r = root(e);
    const outer = box(e, { style: { height: 200 }, hit: true }, r);
    const inner = box(e, { style: { height: 100 }, hit: true }, outer);
    e.commit();
    expect(e.hit(5, 5)).toBe(inner);
    expect(e.hit(5, 150)).toBe(outer);
  });

  it('returns 0 where nothing opts in', () => {
    const e = createMockEink();
    const r = root(e);
    box(e, { style: { height: 200 } }, r);
    e.commit();
    expect(e.hit(5, 5)).toBe(0);
    expect(e.hit(5000, 5)).toBe(0);
  });
});

describe('helpers', () => {
  it('coalesce merges overlapping rects', () => {
    expect(coalesce([{ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 }]))
      .toEqual([{ x: 0, y: 0, w: 15, h: 15 }]);
  });

  it('coalesce keeps far-apart rects separate', () => {
    expect(coalesce([{ x: 0, y: 0, w: 10, h: 10 }, { x: 900, y: 1400, w: 10, h: 10 }])).toHaveLength(2);
  });

  it('approxMeasure wraps at the given width', () => {
    const m = approxMeasure('one two three four five', 32, false, 120);
    expect(m.lines.length).toBeGreaterThan(1);
    expect(m.w).toBeLessThanOrEqual(120);
  });

  it('on() returns an unsubscribe', () => {
    const e = createMockEink();
    let n = 0;
    const off = e.on(() => { n++; });
    e.emit({ type: 'key', key: 'a' });
    off();
    e.emit({ type: 'key', key: 'b' });
    expect(n).toBe(1);
  });
});
