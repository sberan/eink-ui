// Mechanical checks for docs/HIG.md: black text and black-or-white fills only, in every
// component, app and story shipped from this repository.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

const ROOTS = ['components', 'apps', 'stories', 'entry-kindle.ts'];

function sources(p: string): string[] {
  const st = statSync(p);
  if (st.isFile()) return /\.(tsx?|jsx?)$/.test(p) ? [p] : [];
  return readdirSync(p).flatMap((f) => sources(join(p, f)));
}

const files = ROOTS.flatMap((r) => sources(join(process.cwd(), r)));

describe('e-ink interface guidelines', () => {
  it('finds the sources', () => { expect(files.length).toBeGreaterThan(10); });

  it.each(files)('%s uses only black text', (file) => {
    const src = readFileSync(file, 'utf8');
    const greys = [...src.matchAll(/(?<!border_)color(?:=\{|:\s*)(\d+)/g)].map((m) => Number(m[1])).filter((n) => n !== 0 && n !== 255);
    expect(greys, 'grey text colour literals').toEqual([]);
  });

  it.each(files.filter((f) => !f.endsWith('View.stories.tsx')))('%s uses only black or white fills', (file) => {
    const src = readFileSync(file, 'utf8');
    const greys = [...src.matchAll(/\bbg(?:=\{|:\s*)(\d+)/g)].map((m) => Number(m[1])).filter((n) => n !== 0 && n !== 255);
    expect(greys, 'grey fill literals').toEqual([]);
  });
});
