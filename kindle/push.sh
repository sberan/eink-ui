#!/bin/sh
# Push files to the Kindle over Wi-Fi with scp, then relaunch the host so it picks them up.
#   kindle/push.sh                      -> js/dist/app.js
#   kindle/push.sh path/to/eink-host    -> the host binary
#   kindle/push.sh any other file       -> /mnt/us/todo-app/<name>
# Needs "SSH On" running on the device. The host runs from a tmpfs copy, so overwriting the
# files on /mnt/us is safe. -O selects the classic scp protocol, which is what dropbear speaks.
set -e
cd "$(dirname "$0")/.."
IP=${KINDLE_IP:-192.168.0.33}
OPTS="-o StrictHostKeyChecking=accept-new -o ConnectTimeout=5"
[ $# -gt 0 ] || set -- js/dist/app.js
for f in "$@"; do
  scp -O $OPTS "$f" "root@$IP:/mnt/us/todo-app/$(basename "$f")"
done
ssh $OPTS "root@$IP" 'sh "/mnt/us/documents/Todo UI.sh"'
echo "pushed; the app relaunched with the new files"
