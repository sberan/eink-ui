#!/bin/sh
# Live log + JS REPL on the running Kindle host. Usage: kindle/debug.sh [kindle-ip]
# Type JavaScript and press Enter; e.g.  __eink.hit(500, 400)   or   JSON.stringify(Object.keys(globalThis))
IP=${1:-${KINDLE_IP:-192.168.0.33}}
exec nc "$IP" 2323
