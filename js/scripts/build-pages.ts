// Static build of the simulator for GitHub Pages -> js/pages/
// Every path it emits is relative, so the site works under https://<user>.github.io/<repo>/.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'pages');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

// the runtime-loaded glue must exist next to the .wasm before pkg/ is copied
await build({
  entryPoints: [path.join(root, 'sim/pkg/eink_wasm.ts')],
  format: 'esm',
  target: 'es2020',
  outfile: path.join(root, 'sim/pkg/eink_wasm.js'),
});

await build({
  entryPoints: [path.join(root, 'sim/sim.ts')],
  bundle: true,
  format: 'iife',
  target: 'es2020',
  jsx: 'automatic',
  minify: true,
  legalComments: 'none',
  define: { 'process.env.NODE_ENV': '"production"' },
  outfile: path.join(out, 'app.js'),
});

fs.copyFileSync(path.join(root, 'sim/index.html'), path.join(out, 'index.html'));
fs.cpSync(path.join(root, 'sim/pkg'), path.join(out, 'pkg'), {
  recursive: true,
  filter: (src) => !src.endsWith('.ts'),
});

const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
const absolute = [...html.matchAll(/(?:src|href)="(\/[^"]*)"/g)].map((m) => m[1]);
if (absolute.length) {
  console.error(`  FAIL: absolute asset paths in index.html: ${absolute.join(', ')}`);
  process.exit(1);
}

const bytes = (p: string) => fs.statSync(p).size;
console.log(`  pages/: ${fs.readdirSync(out).sort().join(', ')}`);
console.log(`  pages/pkg/: ${fs.readdirSync(path.join(out, 'pkg')).sort().join(', ')}`);
console.log(`  app.js ${(bytes(path.join(out, 'app.js')) / 1024).toFixed(1)} KiB`);
console.log('  ok: all asset paths are relative');
