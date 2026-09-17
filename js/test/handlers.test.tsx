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
