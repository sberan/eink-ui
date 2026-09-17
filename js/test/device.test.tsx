import React from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeHarness, tick, type Harness } from './harness.js';
import { formatClock, pageButton } from '../device/index.js';
import { getStorage, installLocalStorage, readJson, useStoredState, writeJson } from '../storage/index.js';

let h: Harness;
beforeEach(async () => { h = await makeHarness(); });
afterEach(() => { h.renderer.unmount(); globalThis.__eink = undefined; });

describe('device', () => {
  it('maps the Voyage page zones to left and right', () => {
    expect(pageButton('PageUp')).toBe('left');
    expect(pageButton('PageDown')).toBe('right');
    expect(pageButton('Power')).toBeNull();
  });

  it('formats the clock in 12-hour form from UTC fields', () => {
    expect(formatClock(new Date(Date.UTC(2026, 8, 17, 9, 5)))).toBe('9:05');
    expect(formatClock(new Date(Date.UTC(2026, 8, 17, 0, 30)))).toBe('12:30');
    expect(formatClock(new Date(Date.UTC(2026, 8, 17, 13, 0)))).toBe('1:00');
  });

  it('StatusBar shows the battery, the clock and a title', async () => {
    const { StatusBar } = await import('../components/index.js');
    h.renderer.render(
      <StatusBar title="hello" battery={{ percent: 41, charging: true }} time={new Date(Date.UTC(2026, 8, 17, 9, 41))} />,
    );
    const texts = h.liveTexts();
    expect(texts).toContain('hello');
    expect(texts).toContain('9:41');
    expect(texts).toContain('41%');
    expect(texts).toContain('+');
  });

  it('StatusBar announces sleep when the host is about to suspend', async () => {
    const { StatusBar } = await import('../components/index.js');
    h.renderer.render(<StatusBar title="todo" />);
    h.mock.emit({ type: 'power', state: 'sleep' });
    await tick();
    expect(h.liveTexts().some((t) => t.startsWith('asleep'))).toBe(true);
    h.mock.emit({ type: 'power', state: 'wake' });
    await tick();
    expect(h.liveTexts()).toContain('todo');
  });

  it('StatusBar reads the host battery when none is given', async () => {
    const { StatusBar } = await import('../components/index.js');
    h.renderer.render(<StatusBar />);
    expect(h.liveTexts()).toContain('73%');
  });
});

describe('storage', () => {
  it('uses the host storage and round-trips JSON', () => {
    writeJson('ui', { tab: 2 });
    expect(readJson('ui', { tab: 0 })).toEqual({ tab: 2 });
    expect(getStorage().length).toBe(1);
    getStorage().removeItem('ui');
    expect(readJson('ui', { tab: 0 })).toEqual({ tab: 0 });
  });

  it('installs a localStorage global that hits the same store', () => {
    installLocalStorage();
    const ls = (globalThis as { localStorage?: { setItem(k: string, v: string): void } }).localStorage!;
    ls.setItem('k', 'v');
    expect(h.host.storage_get('k')).toBe('v');
  });

  it('useStoredState survives a remount', async () => {
    let setter: ((v: number) => void) | undefined;
    function Counter() {
      const [n, setN] = useStoredState('counter', 0);
      setter = setN;
      return <eink-text text={`n=${n}`} />;
    }
    h.renderer.render(<Counter />);
    expect(h.liveTexts()).toContain('n=0');
    setter!(5);
    expect(h.liveTexts()).toContain('n=5');
    h.renderer.unmount();
    h.renderer.render(<Counter />);
    expect(h.liveTexts()).toContain('n=5');
  });
});
