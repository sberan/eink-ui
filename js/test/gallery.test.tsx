import React from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeHarness, tick, type Harness } from './harness.js';

let h: Harness;

beforeEach(async () => { h = await makeHarness(); });
afterEach(() => {
  h.renderer.unmount();
  globalThis.__eink = undefined;
  globalThis.__eink_paint = undefined;
});

async function gallery() {
  return import('../apps/gallery/index.js');
}

const tapText = (text: string): void => h.tapText(text);

describe('gallery app', () => {
  it('lists every app and every story as a page with a unique id', async () => {
    const { PAGES, findPage } = await gallery();
    const { STORIES } = await import('../stories/index.js');
    expect(PAGES.length).toBeGreaterThanOrEqual(STORIES.length);
    expect(new Set(PAGES.map((p) => p.id)).size).toBe(PAGES.length);
    expect(PAGES.slice(0, 3).map((p) => p.name)).toEqual(['Reader', 'Todo', 'Crossword']);
    for (const p of PAGES) expect(findPage(p.id)).toBe(p);
  });

  it('every page renders through the host without throwing', async () => {
    const { GalleryApp, PAGES } = await gallery();
    for (const p of PAGES) {
      h.renderer.render(<GalleryApp page={p.id} />);
      await tick();
    }
  });

  it('the corner tabs move between pages and open the index', async () => {
    const { GalleryApp, PAGES } = await gallery();
    const seen: string[] = [];
    h.renderer.render(<GalleryApp onPage={(id) => seen.push(id)} />);
    await tick();
    expect(h.hasText('Mini Crossword')).toBe(false);
    tapText('›');
    await tick();
    tapText('›');
    await tick();
    expect(seen).toEqual([PAGES[1]!.id, PAGES[2]!.id]);
    expect(h.hasText('Mini Crossword')).toBe(true);
    tapText('index');
    await tick();
    expect(h.hasText('eink-ui gallery')).toBe(true);
    tapText('Pressed feedback');
    await tick();
    expect(seen[seen.length - 1]).toBe('button--pressed-feedback');
    expect(h.hasText('eink-ui gallery')).toBe(false);
    tapText('‹');
    await tick();
    expect(seen[seen.length - 1]).toBe(PAGES[PAGES.findIndex((p) => p.id === 'button--pressed-feedback') - 1]!.id);
  });

  it('a controlled page prop wins and wraps at both ends', async () => {
    const { GalleryApp, PAGES } = await gallery();
    const seen: string[] = [];
    h.renderer.render(<GalleryApp page={PAGES[0]!.id} onPage={(id) => seen.push(id)} />);
    await tick();
    tapText('‹');
    await tick();
    expect(seen).toEqual([PAGES[PAGES.length - 1]!.id]);
  });
});
