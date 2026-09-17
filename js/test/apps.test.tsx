import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { EinkFetchOptions } from '../host/eink.js';
import { SAMPLE } from '../apps/todo/sample.js';
import { formatHeader } from '../apps/todo/index.js';
import { BLACK, GRID, clueFor, numberGrid, startsEntry } from '../apps/crossword/puzzle.js';
import { fetchResponse, makeHarness, tick, type Harness } from './harness.js';

let h: Harness;

beforeEach(async () => { h = await makeHarness(); });
afterEach(() => { h.renderer.unmount(); globalThis.__eink = undefined; });

/** Only the 52px letters inside crossword cells (keyboard keys use other sizes). */
const cellLetters = () => h.nodes()
  .filter((n) => n.kind === 'text' && n.paint.font_size === 52)
  .map((n) => n.paint.text);

describe('todo app', () => {
  it('formats the header from an ISO date', () => {
    expect(formatHeader('2026-09-15')).toEqual({ day: 'Tuesday', date: 'September 15, 2026' });
  });

  it('the bundled sample has 21 items', () => {
    expect(SAMPLE.sections.reduce((a, s) => a + s.items.length, 0)).toBe(21);
  });

  it('renders every item and the done counter', async () => {
    const { TodoApp } = await import('../apps/todo/index.js');
    h.renderer.render(<TodoApp />);
    const texts = h.textNodes();
    expect(texts).toContain('MORNING');
    expect(texts).toContain('Call Mum');
    expect(texts).toContain('5/21 done');
  });

  it('tapping a row toggles it and updates the counter with a small diff', async () => {
    const { TodoApp } = await import('../apps/todo/index.js');
    h.renderer.render(<TodoApp />);
    const target = h.nodes().find((n) => n.paint.text.startsWith('Review the eink-core'));
    expect(target).toBeDefined();
    h.calls.length = 0;
    h.mock.emit({ type: 'tap', id: target!.parent, x: 0, y: 0 });
    expect(h.textNodes()).toContain('6/21 done');
    // the checkbox fill and the footer text: nothing else (done items keep black text, HIG rule 1)
    expect(h.propCalls().map(([, p]) => Object.keys(p).sort().join(','))).toEqual(
      expect.arrayContaining(['bg', 'text']),
    );
    expect(h.propCalls()).toHaveLength(2);
  });

  it('calls __eink.fetch with method and body when the host provides it', async () => {
    const fetchSpy = vi.fn((_url: string, _opts?: EinkFetchOptions) => fetchResponse(200, {}));
    h.host.fetch = fetchSpy;
    const { TodoApp } = await import('../apps/todo/index.js');
    h.renderer.render(<TodoApp api="https://example.test" />);
    const target = h.nodes().find((n) => n.paint.text === 'Call Mum');
    h.mock.emit({ type: 'tap', id: target!.parent, x: 0, y: 0 });
    await tick();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0] as unknown as [string, { method: string; body: string }];
    expect(url).toBe('https://example.test/api/toggle');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({ date: '2026-09-15', id: 'v1' });
    // the bug this guards: no key may be present-but-undefined on the host payload
    expect(Object.values(opts).every((v) => v !== undefined)).toBe(true);
  });

  it('rendering a different date replaces the sections', async () => {
    const { TodoApp } = await import('../apps/todo/index.js');
    const tuesday = {
      date: '2026-09-15',
      sections: [{ title: 'Tue', items: [{ id: 't1', text: 'tuesday task', done: false }] }],
    };
    const wednesday = {
      date: '2026-09-16',
      sections: [{ title: 'Wed', items: [{ id: 'w1', text: 'wednesday task', done: true }] }],
    };
    h.renderer.render(<TodoApp data={tuesday} />);
    expect(h.textNodes()).toContain('tuesday task');

    // the device bug: the same root re-rendered with new data kept the old day
    h.renderer.render(<TodoApp data={wednesday} />);
    expect(h.liveTexts()).toContain('wednesday task');
    expect(h.liveTexts()).not.toContain('tuesday task');
    expect(h.liveTexts()).toContain('Wednesday');
    expect(h.liveTexts()).toContain('1/1 done');

    // and back again: this direction is what PagePress could not do
    h.renderer.render(<TodoApp data={tuesday} />);
    expect(h.liveTexts()).toContain('tuesday task');
    expect(h.liveTexts()).not.toContain('wednesday task');
    expect(h.liveTexts()).toContain('Tuesday');
    expect(h.liveTexts()).toContain('0/1 done');
  });

  it('a local toggle survives a re-render with the same date', async () => {
    const { TodoApp } = await import('../apps/todo/index.js');
    const day = {
      date: '2026-09-15',
      sections: [{ title: 'Tue', items: [{ id: 't1', text: 'task', done: false }] }],
    };
    h.renderer.render(<TodoApp data={day} />);
    const row = h.nodes().find((n) => n.paint.text === 'task');
    h.mock.emit({ type: 'tap', id: row!.parent, x: 0, y: 0 });
    expect(h.textNodes()).toContain('1/1 done');
    h.renderer.render(<TodoApp data={{ ...day }} />);
    expect(h.liveTexts()).toContain('1/1 done');
  });

  it('works with no __eink.fetch at all', async () => {
    const { TodoApp } = await import('../apps/todo/index.js');
    h.renderer.render(
      <TodoApp data={{ date: '2026-01-01', sections: [{ title: 'A', items: [{ id: 'x', text: 'x', done: false }] }] }} />,
    );
    const t = h.nodes().find((n) => n.paint.text === 'x');
    expect(() => h.mock.emit({ type: 'tap', id: t!.parent, x: 0, y: 0 })).not.toThrow();
    expect(h.textNodes()).toContain('1/1 done');
  });
});

describe('crossword puzzle data', () => {
  it('numbers the grid in reading order', () => {
    const n = numberGrid();
    expect(n[0]?.[0]).toBe(1);
    expect(n[4]?.every((v) => v === 0)).toBe(true);
    const flat = n.flat().filter(Boolean);
    expect(flat).toEqual([...flat].sort((a, b) => a - b));
  });

  it('has a clue for every entry', () => {
    const missing: string[] = [];
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        for (const dir of ['across', 'down'] as const) {
          if (startsEntry(r, c, dir) && !clueFor(r, c, dir).text) missing.push(`${r},${c},${dir}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('every entry in the solution is four letters', () => {
    for (const row of GRID) {
      for (const word of row.split('#')) if (word) expect(word).toHaveLength(4);
    }
    for (let c = 0; c < 9; c++) {
      const col = GRID.map((r) => r[c] ?? '#').join('');
      for (const word of col.split('#')) if (word) expect(word).toHaveLength(4);
    }
  });

  it('the black mask matches the solution', () => {
    expect(BLACK[4]?.every(Boolean)).toBe(true);
    expect(BLACK[0]?.[4]).toBe(true);
    expect(BLACK[0]?.[0]).toBe(false);
  });
});

describe('crossword app', () => {
  async function mountCrossword(): Promise<void> {
    const { CrosswordApp } = await import('../apps/crossword/index.js');
    h.renderer.render(<CrosswordApp />);
  }

  it('shows the clue for the initial selection', async () => {
    await mountCrossword();
    expect(h.textNodes().some((t) => t.startsWith('1A') && t.includes('Informal talk'))).toBe(true);
  });

  it('typing a letter fills the cell, advances, and touches few nodes', async () => {
    await mountCrossword();
    h.calls.length = 0;
    h.mock.emit({ type: 'key', key: 'C' });
    expect(cellLetters()).toContain('C');
    // letter written, old cell unhighlighted, new cell highlighted; clue unchanged
    const keys = h.propCalls().map(([, p]) => Object.keys(p).sort().join(','));
    expect(keys.sort()).toEqual(['bg', 'bg', 'text']);
  });

  it('backspace clears the current cell, then walks back', async () => {
    await mountCrossword();
    h.mock.emit({ type: 'key', key: 'C' });
    h.mock.emit({ type: 'key', key: 'H' });
    expect(cellLetters().filter((t) => t === 'H')).toHaveLength(1);
    h.mock.emit({ type: 'key', key: 'BACKSPACE' });
    expect(cellLetters().filter((t) => t === 'H')).toHaveLength(0);
    h.mock.emit({ type: 'key', key: 'BACKSPACE' });
    expect(cellLetters().filter((t) => t === 'C')).toHaveLength(0);
  });

  it('the cursor stops at the end of an entry', async () => {
    await mountCrossword();
    for (const key of ['C', 'H', 'A', 'T', 'X']) h.mock.emit({ type: 'key', key });
    // 1-Across is four cells wide; the fifth key overwrites the last one
    expect(cellLetters().filter((t) => t !== '')).toEqual(['C', 'H', 'A', 'X']);
  });

  it('ENTER flips the direction and the clue line follows', async () => {
    await mountCrossword();
    h.calls.length = 0;
    h.mock.emit({ type: 'key', key: 'ENTER' });
    expect(h.textNodes().some((t) => t.startsWith('1D') && t.includes('Kitchen boss'))).toBe(true);
    expect(h.propCalls()).toHaveLength(1);
    expect(Object.keys(h.propCalls()[0]![1])).toEqual(['text']);
  });

  it('tapping the selected cell flips direction; tapping another moves the cursor', async () => {
    await mountCrossword();
    h.mock.commit();
    const first = h.mock.hit(70, 130);
    expect(first).toBeGreaterThan(0);
    h.mock.emit({ type: 'tap', id: first, x: 70, y: 130 });
    const clue = h.textNodes().find((t) => /^\d+[AD] /.test(t));
    expect(clue).toBeTruthy();
    h.mock.emit({ type: 'tap', id: first, x: 70, y: 130 });
    expect(h.textNodes().find((t) => /^\d+[AD] /.test(t))).not.toBe(clue);
  });

  it('black squares are not tappable', async () => {
    await mountCrossword();
    h.mock.commit();
    // column 4 of the grid is the black cross
    expect(h.mock.hit(60 + 4 * 96 + 48, 78 + 48)).toBe(0);
  });
});
