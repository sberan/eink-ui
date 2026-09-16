#!/bin/sh
# Wireless deploy: serve the artifacts from the Mac and tell the running host to pull them.
#   kindle/push.sh bundle   -> js/dist/app.js  then :reload
#   kindle/push.sh host     -> eink-host binary then :update
# Requires a static file server on the Mac exposing $SERVE_DIR at $UPDATE_URL (default: the
# LaunchAgent from the todo project on port 8787) and the host's debug port reachable.
set -e
cd "$(dirname "$0")/.."
SERVE_DIR=${SERVE_DIR:-$HOME/Code/kindle-todo}
IP=${KINDLE_IP:-192.168.0.33}
case "${1:-bundle}" in
  bundle) cp js/dist/app.js "$SERVE_DIR/app.js"; cmd=":reload" ;;
  host)   cp target/armv7-unknown-linux-musleabihf/release/eink-host "$SERVE_DIR/eink-host"; cmd=":update" ;;
  *) echo "usage: $0 bundle|host"; exit 1 ;;
esac
printf '%s\n' "$cmd" | nc -w 5 "$IP" 2323
