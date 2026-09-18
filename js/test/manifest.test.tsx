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
    const home = files.manifestSection(files.useManifest(), 'app')['home'];
    return <Text>{typeof home === 'string' ? home : 'no home'}</Text>;
  }
  return { ...files, Home };
}

describe('manifest.json', () => {
  it('is parsed from the repository and its sections read safely', async () => {
    const { readManifest, manifestSection } = await mods();
    const m = readManifest();
    expect(manifestSection(m, 'app')['home']).toBe('days/');
    expect(manifestSection(m, 'display')['frontlight']).toBe('auto');
    expect(manifestSection(m, 'nope')).toEqual({});
    expect(readManifest()).toBe(m);
  });

  it('a component follows a pull that changes it', async () => {
    const { Home } = await mods();
    h.renderer.render(<Home />);
    expect(h.hasText('days/')).toBe(true);
    h.host.files.set('manifest.json', '{ "app": { "home": "notes/" } }');
    h.mock.emit({ type: 'files', changed: ['manifest.json'] });
    await tick();
    expect(h.hasText('notes/')).toBe(true);
  });

  it('a broken or missing file reads as empty', async () => {
    const { Home, readManifest } = await mods();
    h.renderer.render(<Home />);
    h.host.files.set('manifest.json', 'not json');
    h.mock.emit({ type: 'files', changed: ['manifest.json'] });
    await tick();
    expect(readManifest()).toEqual({});
    expect(h.hasText('no home')).toBe(true);
    h.host.files.delete('manifest.json');
    h.mock.emit({ type: 'files', changed: ['manifest.json'] });
    await tick();
    expect(readManifest()).toEqual({});
  });
});
