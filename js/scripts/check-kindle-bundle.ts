// Fails the build if the Kindle bundle reaches for anything QuickJS lacks.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'dist/app.js');
const src = fs.readFileSync(file, 'utf8');

// bare references that would throw in QuickJS; `typeof` guards are fine
const banned: readonly [RegExp, string][] = [
  [/(^|[^.\w$"'])process\s*\./, 'process.*'],
  [/(^|[^.\w$"'])document\s*\./, 'document.*'],
  [/(^|[^.\w$"'])window\s*\./, 'window.*'],
  [/(^|[^.\w$"'])requestAnimationFrame\s*\(/, 'requestAnimationFrame()'],
  [/new\s+MessageChannel\s*\(/, 'new MessageChannel()'],
];

let bad = false;
for (const [re, name] of banned) {
  if (re.test(src)) {
    console.error(`  FAIL: bundle references ${name}`);
    bad = true;
  }
}
console.log(`  size: ${(src.length / 1024).toFixed(1)} KiB`);
console.log(bad ? '  NOT QuickJS-safe' : '  ok: no unguarded DOM/node globals');
process.exit(bad ? 1 : 0);
