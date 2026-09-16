#!/bin/sh
# Bundles every target with esbuild. No other bundler, no transpiler.
#   sim/pkg/eink_wasm.js - ESM glue compiled from eink_wasm.ts, next to the .wasm
#   dist/app.js          - the Kindle bundle, QuickJS: IIFE, ES2020, minified,
#                          React in production mode, no DOM globals, no `process`
#   dist/sim.js          - the browser bundle, unminified, for local debugging
# For a deployable simulator use `npm run build:sim` (-> sim-dist/).
set -eu
cd "$(dirname "$0")"

ESBUILD="npx --no-install esbuild"
COMMON="--bundle --target=es2020 --jsx=automatic"

echo "==> sim/pkg/eink_wasm.js (wasm glue)"
$ESBUILD sim/pkg/eink_wasm.ts --format=esm --target=es2020 --outfile=sim/pkg/eink_wasm.js

echo "==> dist/app.js (Kindle / QuickJS)"
$ESBUILD entry-kindle.ts $COMMON \
  --outfile=dist/app.js \
  --format=iife \
  --minify \
  --legal-comments=none \
  --define:process.env.NODE_ENV='"production"'

echo "==> dist/sim.js (browser)"
$ESBUILD sim/sim.ts $COMMON \
  --outfile=dist/sim.js \
  --format=iife \
  --define:process.env.NODE_ENV='"development"'

echo
echo "==> QuickJS sanity check on dist/app.js"
node scripts/check-kindle-bundle.ts
