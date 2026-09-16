import React, { useState } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SimulatedEinkHost } from '../host/eink.js';
import { diffProps, initialPayload } from '../renderer/host.js';
import { makeHarness, type Harness } from './harness.js';

let h: Harness;

beforeEach(async () => { h = await makeHarness(); });
afterEach(() => {
  h.renderer.unmount();
  globalThis.__eink = undefined;
  globalThis.__eink_paint = undefined;
});

describe('mounting', () => {
  it('creates host nodes and sets the root', () => {
    h.renderer.render(
      <eink-box style={{ padding: 10 }}>
        <eink-text font_size={40}>hello</eink-text>
      </eink-box>,
    );
    expect(h.calls.some((c) => c[0] === 'set_root')).toBe(true);
    expect(h.tree()).toBe('box\n  box\n    text("hello")\n');
  });

  it('sends only the props that are present on create', () => {
    const p = initialPayload('eink-text', { children: 'hi', bold: true, onTap: () => {} });
    expect(p).toEqual({ bold: true, text: 'hi' });
  });

  it('a string child of eink-text becomes its text prop, not a child node', () => {
    h.renderer.render(<eink-text>abc</eink-text>);
    const texts = h.nodes().filter((n) => n.kind === 'text');
    expect(texts).toHaveLength(1);
    expect(texts[0]?.paint.text).toBe('abc');
    expect(texts[0]?.children).toHaveLength(0);
  });

  it('commits once per render and paints the damage', () => {
    const paint = vi.fn();
    globalThis.__eink_paint = paint;
    h.renderer.render(<eink-box bg={255} />);
    expect(h.calls.filter((c) => c[0] === 'commit')).toHaveLength(1);
    expect(paint).toHaveBeenCalledTimes(1);
    expect(paint.mock.calls[0]?.[0]?.[0]).toMatchObject({ x: 0, y: 0, mode: 'gc16' });
  });
});

describe('prop diffing', () => {
  it('returns null when nothing changed', () => {
    expect(diffProps('eink-box', { bg: 255, style: { width: 10 } }, { bg: 255, style: { width: 10 } })).toBe(null);
  });

  it('contains only the changed keys', () => {
    const d = diffProps('eink-box',
      { bg: 255, border: 2, color: 0, style: { width: 10, height: 20 } },
      { bg: 0, border: 2, color: 0, style: { width: 10, height: 30 } });
    expect(d).toEqual({ bg: 0, style: { height: 30 } });
  });

  it('treats a text child like the text prop', () => {
    expect(diffProps('eink-text', { children: 'a' }, { children: 'b' })).toEqual({ text: 'b' });
    expect(diffProps('eink-text', { children: 'a' }, { children: 'a', onTap: () => {} })).toBe(null);
  });

  it('resends all four inset sides when one changes', () => {
    const d = diffProps('eink-box', { style: { top: 1, left: 2 } }, { style: { top: 5, left: 2 } });
    expect(d).toEqual({ style: { top: 5, left: 2, right: null, bottom: null } });
  });

  it('restores paint defaults when a prop is removed', () => {
    expect(diffProps('eink-box', { bg: 10, border: 3 }, {})).toEqual({ bg: null, border: 0 });
  });

  it('a re-render that changes one prop emits one set_props with one key', () => {
    let setN: ((n: number) => void) | null = null;
    function App() {
      const [n, s] = useState(0);
      setN = s;
      return <eink-box bg={255}><eink-text font_size={32}>{`n=${n}`}</eink-text></eink-box>;
    }
    h.renderer.render(<App />);
    h.calls.length = 0;
    h.renderer.batch(() => setN?.(1));
    expect(h.propCalls()).toEqual([[expect.any(Number), { text: 'n=1' }]]);
  });
});

describe('insert / remove ordering', () => {
  function List({ ids }: { ids: string[] }) {
    return <eink-box>{ids.map((i) => <eink-text key={i}>{i}</eink-text>)}</eink-box>;
  }
  const texts = (): (string | undefined)[] => {
    const root = h.mock._nodes.get(h.mock._root());
    const boxId = root?.children[0];
    const box = boxId === undefined ? undefined : h.mock._nodes.get(boxId);
    return (box?.children ?? []).map((c) => h.mock._nodes.get(c)?.paint.text);
  };

  it('inserts in the right place', () => {
    h.renderer.render(<List ids={['a', 'c']} />);
    expect(texts()).toEqual(['a', 'c']);
    h.renderer.render(<List ids={['a', 'b', 'c']} />);
    expect(texts()).toEqual(['a', 'b', 'c']);
    expect(h.calls.some((c) => c[0] === 'insert_before')).toBe(true);
  });

  it('reorders without recreating nodes', () => {
    h.renderer.render(<List ids={['a', 'b', 'c']} />);
    const before = h.calls.filter((c) => c[0] === 'create').length;
    h.renderer.render(<List ids={['c', 'a', 'b']} />);
    expect(texts()).toEqual(['c', 'a', 'b']);
    expect(h.calls.filter((c) => c[0] === 'create').length).toBe(before);
  });

  it('removes the right child and leaves the rest ordered', () => {
    h.renderer.render(<List ids={['a', 'b', 'c']} />);
    h.renderer.render(<List ids={['a', 'c']} />);
    expect(texts()).toEqual(['a', 'c']);
    expect(h.calls.filter((c) => c[0] === 'remove')).toHaveLength(1);
  });

  it('drops the instance record for a removed node', () => {
    h.renderer.render(<List ids={['a', 'b']} />);
    const n = h.renderer.instances.size;
    h.renderer.render(<List ids={['a']} />);
    expect(h.renderer.instances.size).toBe(n - 1);
  });
});

describe('tap events', () => {
  it('calls onTap on the hit node', () => {
    const hit = vi.fn();
    h.renderer.render(<eink-box hit onTap={hit} style={{ width: 100, height: 100 }} />);
    const id = h.mock.hit(10, 10);
    expect(id).toBeGreaterThan(0);
    h.mock.emit({ type: 'tap', id, x: 10, y: 10 });
    expect(hit).toHaveBeenCalledTimes(1);
  });

  it('bubbles to the nearest ancestor handler', () => {
    const outer = vi.fn();
    h.renderer.render(
      <eink-box onTap={outer} style={{ width: 200, height: 200 }}>
        <eink-box hit style={{ width: 100, height: 100 }} />
      </eink-box>,
    );
    const id = h.mock.hit(10, 10);
    h.mock.emit({ type: 'tap', id, x: 10, y: 10 });
    expect(outer).toHaveBeenCalledTimes(1);
    expect(outer.mock.calls[0]?.[0]).toMatchObject({ target: id });
  });

  it('stops at a handler that calls stopPropagation', () => {
    const outer = vi.fn();
    const inner = vi.fn((e: { stopPropagation(): void }) => e.stopPropagation());
    h.renderer.render(
      <eink-box onTap={outer} style={{ width: 200, height: 200 }}>
        <eink-box hit onTap={inner} style={{ width: 100, height: 100 }} />
      </eink-box>,
    );
    h.mock.emit({ type: 'tap', id: h.mock.hit(10, 10), x: 10, y: 10 });
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });

  it('does not double-dispatch after a remount on a host whose on() returns nothing', () => {
    // the wasm and Kindle hosts return void from on(); only one listener may survive
    const listeners: ((ev: { type: 'tap'; id: number; x: number; y: number }) => void)[] = [];
    // model the weaker contract: SimulatedEinkHost.on may return nothing
    const weakHost: SimulatedEinkHost = h.host;
    weakHost.on = (cb) => { listeners.push(cb as (typeof listeners)[number]); };
    const hit = vi.fn();
    h.renderer.render(<eink-box hit onTap={hit} style={{ width: 100, height: 100 }} />);
    h.renderer.unmount();
    h.renderer.render(<eink-box hit onTap={hit} style={{ width: 100, height: 100 }} />);
    expect(listeners).toHaveLength(1);
    const id = h.mock.hit(10, 10);
    for (const cb of listeners) cb({ type: 'tap', id, x: 10, y: 10 });
    expect(hit).toHaveBeenCalledTimes(1);
  });

  it('ignores a tap on an unknown id', () => {
    const hit = vi.fn();
    h.renderer.render(<eink-box hit onTap={hit} style={{ width: 10, height: 10 }} />);
    h.mock.emit({ type: 'tap', id: 9999, x: 0, y: 0 });
    expect(hit).not.toHaveBeenCalled();
  });
});

describe('key events', () => {
  it('routes keys to the most recently mounted useKeys owner', async () => {
    const { useKeys } = await import('../renderer/useKeys.js');
    const first = vi.fn();
    const second = vi.fn();
    function A() { useKeys(first); return <eink-box />; }
    function B() { useKeys(second); return <eink-box />; }
    h.renderer.render(<eink-box><A /><B /></eink-box>);
    h.mock.emit({ type: 'key', key: 'Q' });
    expect(second).toHaveBeenCalledWith('Q');
    expect(first).not.toHaveBeenCalled();
  });

  it('falls back to the previous owner after the top one unmounts', async () => {
    const { useKeys } = await import('../renderer/useKeys.js');
    const first = vi.fn();
    const second = vi.fn();
    function A() { useKeys(first); return <eink-box />; }
    function B() { useKeys(second); return <eink-box />; }
    function App({ two }: { two: boolean }) { return <eink-box><A />{two ? <B /> : null}</eink-box>; }
    h.renderer.render(<App two />);
    h.renderer.render(<App two={false} />);
    h.mock.emit({ type: 'key', key: 'Z' });
    expect(first).toHaveBeenCalledWith('Z');
    expect(second).not.toHaveBeenCalled();
  });
});
