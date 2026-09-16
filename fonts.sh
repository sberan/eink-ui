#!/bin/sh
# Fetches the Noto Serif faces embedded in eink-core (OFL). Binary assets are not committed.
set -e
cd "$(dirname "$0")/crates/eink-core/fonts"
for f in Regular Bold; do
  [ -f "NotoSerif-$f.ttf" ] || curl -sfL -o "NotoSerif-$f.ttf" \
    "https://raw.githubusercontent.com/notofonts/notofonts.github.io/main/fonts/NotoSerif/hinted/ttf/NotoSerif-$f.ttf"
done
ls -la NotoSerif-*.ttf
