import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { DamageRect } from '../host/eink.js';
import { STORIES, STORY_MODULES, findStory } from '../stories/index.js';
import { makeHarness, type Harness } from './harness.js';

let h: Harness;

beforeEach(async () => { h = await makeHarness(); });
afterEach(() => {
  h.renderer.unmount();
  globalThis.__eink = undefined;
  globalThis.__eink_paint = undefined;
});

describe('story registry', () => {
  it('every story module exports at least one story', () => {
    const empty = STORY_MODULES
      .filter((m) => !Object.entries(m).some(([k, v]) => k !== 'default' && typeof v === 'function'))
      .map((m) => m.default.title);
    expect(empty).toEqual([]);
  });

  it('every module has a title and every story a unique id', () => {
    for (const m of STORY_MODULES) expect(m.default.title).toMatch(/\S/);
    const ids = STORIES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => /^[a-z0-9-]+--[a-z0-9-]+$/.test(id))).toBe(true);
  });

  it('findStory resolves every registered id and nothing else', () => {
    for (const s of STORIES) expect(findStory(s.id)).toBe(s);
    expect(findStory('nope--nope')).toBeUndefined();
  });

  it('keeps word boundaries in ids, so deep links read naturally', () => {
    // '#/story/button--withstate' is not something anyone would type
    const ids = STORIES.map((s) => s.id);
    expect(ids).toContain('button--with-state');
    expect(ids).toContain('button--pressed-feedback');
    expect(ids).toContain('grid--nine-by-nine');
    expect(ids).toContain('grid--with-gap');
    expect(ids).toContain('view--padding-and-gap');
    expect(ids).toContain('keyboard--above-a-clue-line');
    expect(ids).toContain('row--align-items');
  });

  it('ids come from the export name, not the display label', () => {
    // AboveAClueLine sets storyName; renaming that label must not move the link
    const clue = STORIES.find((s) => s.id === 'keyboard--above-a-clue-line');
    expect(clue?.name).toBe('Above a clue line');
  });

  it('covers every story group', () => {
    expect([...new Set(STORIES.map((s) => s.group))].sort()).toEqual(
      ['Button', 'Checkbox', 'Column', 'Grid', 'Keyboard', 'Markdown', 'Reader', 'Row', 'StatusBar', 'Text', 'View'],
    );
  });
});

describe('mounting every story through the mock host', () => {
  it.each(STORIES.map((s) => [s.id, s] as const))('%s paints a non-empty first commit', (_id, story) => {
    let damage: DamageRect[] = [];
    globalThis.__eink_paint = (d) => { damage = d; };

    h.renderer.render(story.render());

    // the scene must actually contain something beyond the renderer's root box
    expect(h.nodes().length).toBeGreaterThan(1);
    expect(damage.length).toBeGreaterThan(0);
    expect(damage.every((r) => r.w > 0 && r.h > 0)).toBe(true);

    h.renderer.unmount();
  });

  it('a second story mounts cleanly after the first is unmounted', () => {
    const [first, second] = STORIES;
    expect(first && second).toBeTruthy();
    h.renderer.render(first!.render());
    const afterFirst = h.nodes().length;
    h.renderer.unmount();
    h.renderer.render(second!.render());
    expect(h.nodes().length).toBeGreaterThan(afterFirst);
    expect(h.renderer.instances.size).toBeGreaterThan(1);
  });
});
