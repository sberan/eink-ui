#!/usr/bin/env node
// eink-ui: the workflow for an app repository.
//   init [dir]  the repository and the example app
//   dev         the app in the browser on the real core, rebuilt as you save
//   build       dist/app.js and bin/eink-host for the device
//   sync        commit, push, and tell a reachable device to pull now
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const kit = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const kitPackage = JSON.parse(fs.readFileSync(path.join(kit, 'package.json'), 'utf8'));
const cwd = process.cwd();

const [, , command = 'help', ...args] = process.argv;

function fail(msg) {
  console.error(`eink-ui: ${msg}`);
  process.exit(1);
}

function readPackage(dir = cwd) {
  const p = path.join(dir, 'package.json');
  if (!fs.existsSync(p)) fail(`no package.json in ${dir}; run "npx eink-ui init" first`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function entryOf(pkg) {
  const src = pkg.eink?.entry ?? 'src/app.tsx';
  if (!fs.existsSync(path.join(cwd, src))) fail(`${src} is missing (eink.entry in package.json names the app's source)`);
  return src;
}

function run(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, { stdio: 'inherit', cwd, ...opts });
  if (r.status !== 0) fail(`${cmd} ${cmdArgs.join(' ')} failed`);
  return r;
}

function esbuild() {
  // from the kit's own node_modules, else from the app's
  for (const from of [import.meta.url, path.join(cwd, 'package.json')]) {
    try {
      return createRequire(from)('esbuild');
    } catch {
      // try the next
    }
  }
  return fail('esbuild is not installed; run "npm install"');
}

const DEFAULT_SETTINGS = {
  app: { home: 'data/' },
  display: { theme: 'light', frontlight: 'auto', dark_lux: 15, dark_level: 8 },
  clock: { tz: 'auto' },
  ssh: { enabled: true },
  power: {
    stages: [
      { name: 'on', minutes: 10, functions: ['frontlight', 'cpu', 'wifi', 'sync', 'haptics'] },
      { name: 'low power', minutes: 50, functions: ['wifi', 'sync'] },
      { name: 'sleep', suspend: true, wake_every_minutes: 30 },
    ],
  },
};

const EXAMPLE_APP = `// Your Kindle app. \`npx eink-ui dev\` runs it in the browser on the real engine,
// \`npx eink-ui build\` bundles it for the device, \`npx eink-ui sync\` ships it.
// The reader shows the markdown under the folder named by app.home in package.json (data/):
// headings, paragraphs, task lists that toggle with a tap, and a keyboard to add tasks.
import React from 'react';
import { render } from 'eink-ui';
import { ReaderApp } from 'eink-ui/apps/reader';
import { settingsSection, useSettings } from 'eink-ui/files';
import { installLocalStorage } from 'eink-ui/storage';

function App() {
  const home = settingsSection(useSettings(), 'app')['home'];
  return <ReaderApp folder={typeof home === 'string' && home !== '' ? home : 'data/'} />;
}

installLocalStorage();
render(<App />);
`;

function today() {
  return new Date().toISOString().slice(0, 10);
}

function init() {
  const dir = path.resolve(cwd, args[0] ?? '.');
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(path.join(dir, 'package.json'))) fail(`${dir} already has a package.json`);
  const name = path.basename(dir).replace(/[^a-z0-9-]/gi, '-').toLowerCase() || 'kindle-app';
  // the kit is a git dependency until it is on npm
  const kitSpec = process.env['EINK_UI_SPEC'] ?? kitPackage.repository?.url?.replace(/^git\+/, '').replace(/\.git$/, '').replace(/^https:\/\/github\.com\//, 'github:') ?? `^${kitPackage.version}`;
  const pkg = {
    name,
    private: true,
    type: 'module',
    main: 'dist/app.js',
    eink: DEFAULT_SETTINGS,
    scripts: { dev: 'eink-ui dev', build: 'eink-ui build', sync: 'eink-ui sync', typecheck: 'tsc --noEmit' },
    dependencies: { 'eink-ui': kitSpec, react: '18.3.1', 'react-reconciler': '0.29.2' },
    devDependencies: { '@types/react': '^18.3.31', '@types/react-reconciler': '^0.28.9', typescript: '^5.9.0' },
  };
  const write = (rel, text) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  };
  write('package.json', JSON.stringify(pkg, null, 2) + '\n');
  write('src/app.tsx', EXAMPLE_APP);
  write(`data/${today()}.md`, `# ${today()}\n\n- [ ] Tap a task to tick it\n- [ ] Add a task with the keyboard\n- [x] Open this on the device\n`);
  write('tsconfig.json', JSON.stringify({
    compilerOptions: {
      target: 'ES2020', module: 'ESNext', moduleResolution: 'bundler', jsx: 'react-jsx', strict: true,
      noEmit: true, skipLibCheck: true, types: ['eink-ui/js/global.d.ts'],
    },
    include: ['src'],
  }, null, 2) + '\n');
  write('.gitignore', 'node_modules/\n.eink-ui/\n');
  write('README.md', `# ${name}\n\nAn eink-ui app for a jailbroken Kindle.\n\n- \`npm run dev\`: the app in the browser on the real engine, rebuilt as you save\n- \`npm run build\`: \`dist/app.js\` and \`bin/eink-host\` for the device\n- \`npm run sync\`: commit, push, and tell a reachable device to pull\n\nThe device pulls this repository; \`data/\` is the only folder it writes. Settings live in the\n\`eink\` section of package.json (see eink-ui's docs/DEBUGGING.md).\n`);
  console.log(`eink-ui: created ${dir}`);
  if (!fs.existsSync(path.join(dir, '.git'))) run('git', ['init', '-q'], { cwd: dir });
  if (!args.includes('--no-install')) run('npm', ['install', '--no-audit', '--no-fund'], { cwd: dir });
  console.log('\nNext: cd ' + path.relative(cwd, dir) + ' && npm run dev');
}

const HOST_SOURCE = path.join(kit, 'host', 'eink-host');

async function build({ quiet = false } = {}) {
  const pkg = readPackage();
  const entry = entryOf(pkg);
  const out = pkg.main ?? 'dist/app.js';
  const { build: esbuildBuild } = esbuild();
  await esbuildBuild({
    entryPoints: [path.join(cwd, entry)],
    bundle: true,
    format: 'iife',
    target: 'es2020',
    jsx: 'automatic',
    minify: true,
    legalComments: 'none',
    define: { 'process.env.NODE_ENV': '"production"' },
    outfile: path.join(cwd, out),
    logLevel: quiet ? 'error' : 'warning',
  });
  const bundle = fs.statSync(path.join(cwd, out)).size;
  // the host at the kit's version: the eink-ui dependency version is the host version
  if (!fs.existsSync(HOST_SOURCE)) fail(`the kit at ${kit} has no host/eink-host binary`);
  const hostOut = path.join(cwd, 'bin', 'eink-host');
  fs.mkdirSync(path.dirname(hostOut), { recursive: true });
  const same = fs.existsSync(hostOut) && fs.readFileSync(hostOut).equals(fs.readFileSync(HOST_SOURCE));
  if (!same) fs.copyFileSync(HOST_SOURCE, hostOut);
  fs.chmodSync(hostOut, 0o755);
  if (!quiet) {
    console.log(`eink-ui build: ${out} ${(bundle / 1024).toFixed(1)} KiB; bin/eink-host ${same ? 'unchanged' : 'updated'} (eink-ui ${kitPackage.version})`);
  }
}

async function dev() {
  const pkg = readPackage();
  const entry = entryOf(pkg);
  const port = Number(process.env['PORT'] ?? 5173);
  const work = path.join(cwd, '.eink-ui', 'dev');
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  // the simulator's page and the wasm core next to it, as the published gallery has them
  const simDir = path.join(kit, 'js', 'sim');
  let html = fs.readFileSync(path.join(simDir, 'index.html'), 'utf8');
  html = html.replace('<script src="app.js"></script>',
    '<script src="app.js"></script>\n<script>new EventSource("/esbuild").addEventListener("change", () => location.reload());</script>');
  fs.writeFileSync(path.join(work, 'index.html'), html);
  fs.cpSync(path.join(simDir, 'pkg'), path.join(work, 'pkg'), { recursive: true, filter: (s) => !s.endsWith('.ts') });
  const { build: esbuildBuild, context } = esbuild();
  await esbuildBuild({
    entryPoints: [path.join(simDir, 'pkg', 'eink_wasm.ts')],
    bundle: true,
    format: 'esm',
    target: 'es2020',
    outfile: path.join(work, 'pkg', 'eink_wasm.js'),
    logLevel: 'error',
  });
  // the page boots the simulator with the app under development as its first page; `render()`
  // calls inside the app are redirected to the simulator's page slot
  const appPath = path.join(cwd, entry).replace(/\\/g, '/');
  const devEntry = path.join(work, 'entry.tsx');
  fs.writeFileSync(devEntry, `import { bootSim } from 'eink-ui/sim';
import { captureApp } from 'eink-ui/renderer';
captureApp(() => import(${JSON.stringify(appPath)})).then((app) => {
  bootSim({ app, appName: ${JSON.stringify(pkg.name ?? 'app')} });
}, (err) => { console.error('eink-ui dev: the app failed to load', err); });
`);
  const ctx = await context({
    entryPoints: [devEntry],
    bundle: true,
    format: 'iife',
    target: 'es2020',
    jsx: 'automatic',
    sourcemap: true,
    define: { 'process.env.NODE_ENV': '"development"' },
    outfile: path.join(work, 'app.js'),
    nodePaths: [path.join(cwd, 'node_modules')],
    logLevel: 'warning',
  });
  await ctx.watch();
  const served = await ctx.serve({ servedir: work, port, host: '127.0.0.1' });
  console.log(`eink-ui dev: http://127.0.0.1:${served.port}  (${entry} on the real core; the kit's gallery is in the sidebar)`);
}

function git(...gitArgs) {
  const r = spawnSync('git', gitArgs, { cwd, encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

async function sync() {
  await build({ quiet: true });
  const status = git('status', '--porcelain');
  if (!status.ok) fail('not a git repository');
  if (status.out) {
    const message = args.find((a) => !a.startsWith('--')) ?? `sync ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
    run('git', ['add', '-A']);
    run('git', ['commit', '-q', '-m', message]);
  }
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD').out || 'main';
  run('git', ['pull', '-q', '--rebase', 'origin', branch]);
  run('git', ['push', '-q', 'origin', branch]);
  console.log(`eink-ui sync: pushed ${branch} (${git('rev-parse', '--short', 'HEAD').out})`);
  // the device pulls when told, and `eink sync` holds it awake until the pull has landed. Asleep,
  // it wakes every 30 minutes for a few seconds, so keep trying for one such cycle.
  const device = process.env['EINK_DEVICE'] ?? 'kindle';
  const waitMinutes = args.includes('--no-wait') ? 0 : Number(process.env['EINK_WAIT_MINUTES'] ?? 35);
  const deadline = Date.now() + waitMinutes * 60_000;
  let told = false;
  for (;;) {
    const r = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'ServerAliveInterval=10', device, 'eink', 'sync'], { encoding: 'utf8' });
    if (r.status === 0) {
      console.log(`eink-ui sync: ${device} pulled:\n  ${r.stdout.trim().split('\n').join('\n  ')}`);
      return;
    }
    if (r.status === 127 || /eink: not found/.test(r.stderr + r.stdout)) {
      console.log(`eink-ui sync: ${device} answers but has no eink command yet (an older host); it pulls the new one at its next wake`);
      return;
    }
    if (Date.now() >= deadline) {
      console.log(`eink-ui sync: ${device} not reachable over ssh; it pulls at its next wake`);
      return;
    }
    if (!told) {
      console.log(`eink-ui sync: waiting for ${device} to wake (it does every 30 minutes; ctrl-c to stop waiting, the push is done)`);
      told = true;
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

function help() {
  console.log(`eink-ui ${kitPackage.version}
  npx eink-ui init [dir]   the repository and the example app
  npx eink-ui dev          the app in the browser on the real core, rebuilt as you save
  npx eink-ui build        dist/app.js and bin/eink-host (the host at this kit's version)
  npx eink-ui sync [msg]   commit, push, and tell a reachable device (ssh "$EINK_DEVICE", default "kindle") to pull`);
}

const commands = { init, dev, build, sync, help, '--help': help, '-h': help };
const fn = commands[command];
if (!fn) fail(`unknown command "${command}"; try --help`);
await fn();
if (command !== 'dev') process.exit(0);
