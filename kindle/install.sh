#!/bin/sh
# Copies the host binary, the React bundle and the library launchers onto a USB-mounted Kindle.
set -e
cd "$(dirname "$0")/.."
K=${KINDLE:-/Volumes/Kindle}
[ -d "$K/documents" ] || { echo "Kindle not mounted at $K"; exit 1; }
mkdir -p "$K/todo-app"
cp target/armv7-unknown-linux-musleabihf/release/eink-host "$K/todo-app/eink-host"
cp js/dist/app.js "$K/todo-app/app.js"
cp "kindle/Todo UI.sh" "kindle/Todo UI Stop.sh" "$K/documents/"
find "$K/todo-app" "$K/documents" -maxdepth 1 -name '._*' -delete 2>/dev/null || true
sync
echo "installed; eject the Kindle and open 'Todo UI' in the library"
