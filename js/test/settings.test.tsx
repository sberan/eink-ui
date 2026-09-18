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

// the harness resets modules per test, so the modules under test are imported after it
async function mods() {
  const files = await import('../files/index.js');
  const { Text } = await import('../components/index.js');
  function Home() {
    const home = files.settingsSection(files.useSettings(), 'app')['home'];
    return <Text>{typeof home === 'string' ? home : 'no home'}</Text>;
  }
  return { ...files, Home };
}

describe('settings: package.json eink + data/settings.json', () => {
  it('reads the eink section and its sections safely', async () => {
    const { readSettings, settingsSection } = await mods();
    const s = readSettings();
    expect(settingsSection(s, 'app')['home']).toBe('data/');
    expect(settingsSection(s, 'display')['frontlight']).toBe('auto');
    expect(settingsSection(s, 'nope')).toEqual({});
    expect(readSettings()).toBe(s);
  });

  it('data/settings.json overrides key by key', async () => {
    const { readSettings, settingsSection, mergeSettings } = await mods();
    h.host.files.set('data/settings.json', '{ "display": { "frontlight": "dark" } }');
    h.mock.emit({ type: 'files', changed: ['data/settings.json'] });
    const s = readSettings();
    expect(settingsSection(s, 'display')['frontlight']).toBe('dark');
    expect(settingsSection(s, 'display')['theme']).toBe('light');
    expect(mergeSettings({ a: 1 }, { a: { b: 2 } })).toEqual({ a: { b: 2 } });
  });

  it('a component follows a pull that changes either file', async () => {
    const { Home } = await mods();
    h.renderer.render(<Home />);
    expect(h.hasText('data/')).toBe(true);
    h.host.files.set('data/settings.json', '{ "app": { "home": "notes/" } }');
    h.mock.emit({ type: 'files', changed: ['data/settings.json'] });
    await tick();
    expect(h.hasText('notes/')).toBe(true);
    h.host.files.set('package.json', '{ "eink": { "app": { "home": "pages/" } } }');
    h.host.files.delete('data/settings.json');
    h.mock.emit({ type: 'files', changed: ['package.json', 'data/settings.json'] });
    await tick();
    expect(h.hasText('pages/')).toBe(true);
  });

  it('broken or missing files read as empty', async () => {
    const { Home, readSettings } = await mods();
    h.renderer.render(<Home />);
    h.host.files.set('package.json', 'not json');
    h.mock.emit({ type: 'files', changed: ['package.json'] });
    await tick();
    expect(readSettings()).toEqual({});
    expect(h.hasText('no home')).toBe(true);
  });
});
