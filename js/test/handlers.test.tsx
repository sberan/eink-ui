import React from 'react';
import { it, expect, beforeEach, afterEach } from 'vitest';
import { makeHarness, tick, type Harness } from './harness.js';

let h: Harness;
beforeEach(async () => { h = await makeHarness(); });
afterEach(() => { h.renderer.unmount(); globalThis.__eink = undefined; });

// Regression: a re-render that changes only an onTap closure must reach the host instance,
// or the second tap acts on state from before the first.
it('two taps in a row keep both boxes ticked', async () => {
  const { ReaderApp } = await import('../apps/reader/index.js');
  h.renderer.render(<ReaderApp />);
  const tapOn = (label: string) => {
    const row = h.nodes().find((n) => n.paint.text === label);
    h.mock.emit({ type: 'tap', id: row!.parent, x: 0, y: 0 });
  };
  tapOn('Battery drain measurement overnight');
  await tick();
  tapOn('Post the return label');
  await tick();
  const last = h.host.writes[h.host.writes.length - 1]![1];
  expect(last).toContain('- [x] Battery drain measurement overnight');
  expect(last).toContain('- [x] Post the return label');
});

// Non-input changes share one paint per frame window; input paints at once (docs/HIG.md).
it('throttles non-input paints into one commit per frame window', async () => {
  const { StatusBar } = await import('../components/index.js');
  h.renderer.setFrameMs(30);
  h.renderer.render(<StatusBar title="a" />);
  h.calls.length = 0;
  h.mock.emit({ type: 'power', state: 'sleep' });
  h.mock.emit({ type: 'power', state: 'wake' });
  h.mock.emit({ type: 'power', state: 'sleep' });
  expect(h.calls.filter((c) => c[0] === 'commit')).toHaveLength(0);
  await new Promise((r) => setTimeout(r, 60));
  expect(h.calls.filter((c) => c[0] === 'commit')).toHaveLength(1);
  expect(h.liveTexts().some((t) => t.startsWith('asleep'))).toBe(true);
});

it('paints input events immediately', async () => {
  const { ReaderApp } = await import('../apps/reader/index.js');
  h.renderer.setFrameMs(1000);
  h.renderer.render(<ReaderApp />);
  h.calls.length = 0;
  const row = h.nodes().find((n) => n.paint.text === 'Post the return label');
  h.mock.emit({ type: 'tap', id: row!.parent, x: 0, y: 0 });
  await tick();
  // React commits after the event batch; the paint must still not wait for the frame window
  expect(h.calls.filter((c) => c[0] === 'commit')).toHaveLength(1);
});
