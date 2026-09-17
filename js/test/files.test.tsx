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
  it('tile the column with no gap and a finger-sized height, and taps report the line', async () => {
    const { Markdown, TASK_ROW } = await import('../components/index.js');
    const seen: number[] = [];
    h.renderer.render(<Markdown text={'# T\n- [ ] one\n- [ ] two\n- [x] three\n'} onToggleTask={(line) => seen.push(line)} />);
    const md = h.nodes().find((n) => n.kind === 'markdown')!;
    const rows = (md.md ?? []).filter((b) => b.kind === 'task');
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r.rect.h).toBeGreaterThanOrEqual(TASK_ROW);
    expect(rows[1]!.rect.y).toBe(rows[0]!.rect.y + rows[0]!.rect.h);
    expect(rows[2]!.rect.y).toBe(rows[1]!.rect.y + rows[1]!.rect.h);
    h.tapTask('two');
    await tick();
    expect(seen).toEqual([2]);
  });
});

describe('reader app over the mock repository', () => {
  it('opens the newest day and lists its tasks', async () => {
    const { ReaderApp } = await import('../apps/reader/index.js');
    h.renderer.render(<ReaderApp />);
    expect(h.hasText('Wednesday, September 16')).toBe(true);
    expect(h.hasText('Battery drain measurement overnight')).toBe(true);
  });

  it('a tap on a task writes the flipped file back to the host', async () => {
    const { ReaderApp } = await import('../apps/reader/index.js');
    h.renderer.render(<ReaderApp />);
    h.tapTask('Post the return label');
    await tick();
    expect(h.host.writes).toHaveLength(1);
    const [path, text] = h.host.writes[0]!;
    expect(path).toBe('days/2026-09-16.md');
    expect(text).toContain('- [x] Post the return label');
    expect(text.split('\n').length).toBe(SAMPLE_FILES[path]!.split('\n').length);
  });

  it('a tap re-renders only the page node, not the whole app', async () => {
    const { ReaderApp } = await import('../apps/reader/index.js');
    h.renderer.render(<ReaderApp />);
    await tick();
    const eink = globalThis.__eink!;
    const touched: number[] = [];
    let listed = 0;
    const origSet = eink.set_props.bind(eink);
    const origList = eink.list_files.bind(eink);
    eink.set_props = (id, json) => { touched.push(id); origSet(id, json); };
    eink.list_files = (prefix) => { listed += 1; return origList(prefix); };
    try {
      h.tapTask('Post the return label');
      await tick();
    } finally {
      eink.set_props = origSet;
      eink.list_files = origList;
    }
    expect(touched).toHaveLength(1);
    // the app's own hooks (file list, sync state) must not be re-read for an edit of an open file
    expect(listed).toBe(0);
    expect(h.host.writes).toHaveLength(1);
  });

  it('page buttons move between day files', async () => {
    const { ReaderApp } = await import('../apps/reader/index.js');
    h.renderer.render(<ReaderApp />);
    h.mock.emit({ type: 'key', key: 'PageUp' });
    await tick();
    expect(h.hasText('Tuesday, September 15')).toBe(true);
    h.mock.emit({ type: 'key', key: 'PageDown' });
    await tick();
    expect(h.hasText('Wednesday, September 16')).toBe(true);
  });

  it('re-reads a file when the host reports a pull', async () => {
    const { ReaderApp } = await import('../apps/reader/index.js');
    h.renderer.render(<ReaderApp />);
    h.host.files.set('days/2026-09-16.md', '# Wednesday, September 16\n- [ ] Something new\n');
    h.mock.emit({ type: 'files', changed: ['days/2026-09-16.md'] });
    await tick();
    expect(h.hasText('Something new')).toBe(true);
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
    expect(h.hasText('Tuesday, September 15')).toBe(true);
  });

  it('closes on the cancel key', async () => {
    await open();
    const x = h.nodes().find((n) => n.paint.text === '×');
    h.mock.emit({ type: 'tap', id: x!.parent, x: 0, y: 0 });
    await tick();
    expect(h.liveTexts()).not.toContain('New task…');
  });
});
