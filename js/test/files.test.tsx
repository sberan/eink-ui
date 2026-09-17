import React from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeHarness, tick, type Harness } from './harness.js';
import { inlineText, parseMarkdown, toggleTaskLine } from '../components/markdown.js';
import { SAMPLE_FILES } from '../files/sample.js';

let h: Harness;
beforeEach(async () => { h = await makeHarness(); });
afterEach(() => { h.renderer.unmount(); globalThis.__eink = undefined; });

describe('markdown', () => {
  it('parses the block subset with source lines', () => {
    const blocks = parseMarkdown('# Title\n\ntext one\ntext two\n\n- [ ] open\n- [x] done\n  - nested\n1. first\n> why\n---\n');
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'para', 'task', 'task', 'bullet', 'number', 'quote', 'hr']);
    expect(blocks[1]).toMatchObject({ text: 'text one text two', line: 2 });
    expect(blocks[2]).toMatchObject({ checked: false, text: 'open', line: 5 });
    expect(blocks[3]).toMatchObject({ checked: true, line: 6 });
    expect(blocks[4]).toMatchObject({ indent: 1 });
  });

  it('skips frontmatter and flattens inline markup', () => {
    expect(parseMarkdown('---\ntags: [a]\n---\n# H')[0]).toMatchObject({ kind: 'heading', text: 'H' });
    expect(inlineText('**bold** and *it* with `code`, [[Note|alias]], [[Page]] and [link](http://x) 📅 2026-09-17')).toBe(
      'bold and it with code, alias, Page and link 2026-09-17',
    );
  });

  it('flips exactly one task line', () => {
    const t = '- [ ] a\n- [x] b\n';
    expect(toggleTaskLine(t, 0)).toBe('- [x] a\n- [x] b\n');
    expect(toggleTaskLine(t, 1)).toBe('- [ ] a\n- [ ] b\n');
    expect(toggleTaskLine(t, 5)).toBe(t);
  });
});

describe('task rows as touch targets', () => {
  it('tile the column with no gap and a finger-sized height', async () => {
    const { Markdown, TASK_ROW } = await import('../components/index.js');
    h.renderer.render(<Markdown text={'# T\n- [ ] one\n- [ ] two\n- [x] three\n'} onToggleTask={() => {}} />);
    const rows = ['one', 'two', 'three'].map((t) => {
      const text = h.nodes().find((n) => n.paint.text === t)!;
      return h.nodes().find((n) => n.id === text.parent)!.rect!;
    });
    for (const r of rows) expect(r.h).toBeGreaterThanOrEqual(TASK_ROW);
    expect(rows[1]!.y).toBe(rows[0]!.y + rows[0]!.h);
    expect(rows[2]!.y).toBe(rows[1]!.y + rows[1]!.h);
  });
});

describe('reader app over the mock repository', () => {
  it('opens the newest day and lists its tasks', async () => {
    const { ReaderApp } = await import('../apps/reader/index.js');
    h.renderer.render(<ReaderApp />);
    const texts = h.liveTexts();
    expect(texts).toContain('Wednesday, September 16');
    expect(texts).toContain('Battery drain measurement overnight');
  });

  it('a tap on a task writes the flipped file back to the host', async () => {
    const { ReaderApp } = await import('../apps/reader/index.js');
    h.renderer.render(<ReaderApp />);
    const row = h.nodes().find((n) => n.paint.text === 'Post the return label');
    h.mock.emit({ type: 'tap', id: row!.parent, x: 0, y: 0 });
    await tick();
    expect(h.host.writes).toHaveLength(1);
    const [path, text] = h.host.writes[0]!;
    expect(path).toBe('days/2026-09-16.md');
    expect(text).toContain('- [x] Post the return label');
    expect(text.split('\n').length).toBe(SAMPLE_FILES[path]!.split('\n').length);
  });

  it('page buttons move between day files', async () => {
    const { ReaderApp } = await import('../apps/reader/index.js');
    h.renderer.render(<ReaderApp />);
    h.mock.emit({ type: 'key', key: 'PageUp' });
    await tick();
    expect(h.liveTexts()).toContain('Tuesday, September 15');
    h.mock.emit({ type: 'key', key: 'PageDown' });
    await tick();
    expect(h.liveTexts()).toContain('Wednesday, September 16');
  });

  it('re-reads a file when the host reports a pull', async () => {
    const { ReaderApp } = await import('../apps/reader/index.js');
    h.renderer.render(<ReaderApp />);
    h.host.files.set('days/2026-09-16.md', '# Wednesday, September 16\n- [ ] Something new\n');
    h.mock.emit({ type: 'files', changed: ['days/2026-09-16.md'] });
    await tick();
    expect(h.liveTexts()).toContain('Something new');
  });
});

describe('reader keyboard', () => {
  const open = async () => {
    const { ReaderApp } = await import('../apps/reader/index.js');
    h.renderer.render(<ReaderApp />);
    const add = h.nodes().find((n) => n.paint.text === '+ task');
    h.mock.emit({ type: 'tap', id: add!.parent, x: 0, y: 0 });
    await tick();
  };

  it('is an overlay pinned to the bottom edge, not a flow item after the list', async () => {
    await open();
    expect(h.liveTexts()).toContain('New task…');
    const field = h.nodes().find((n) => n.paint.text === 'New task…')!;
    let box = h.nodes().find((n) => n.id === field.parent)!;
    while (box && box.style.position !== 'absolute') box = h.nodes().find((n) => n.id === box.parent)!;
    expect(box?.style).toMatchObject({ position: 'absolute', bottom: 0, left: 0, right: 0 });
  });

  it('closes on a page turn', async () => {
    await open();
    h.mock.emit({ type: 'key', key: 'PageUp' });
    await tick();
    expect(h.liveTexts()).not.toContain('New task…');
    expect(h.liveTexts()).toContain('Tuesday, September 15');
  });

  it('closes on the cancel key', async () => {
    await open();
    const x = h.nodes().find((n) => n.paint.text === '×');
    h.mock.emit({ type: 'tap', id: x!.parent, x: 0, y: 0 });
    await tick();
    expect(h.liveTexts()).not.toContain('New task…');
  });
});
