#!/bin/sh
# Name: Todo UI
# Author: Sam
# DontUseFBInk: true
mkdir -p /mnt/us/todo-app /var/tmp/todo-app
cd /
pkill -f eink-host-run 2>/dev/null
pkill -f todo-app-run 2>/dev/null
cp /mnt/us/todo-app/eink-host /var/tmp/eink-host-run && chmod +x /var/tmp/eink-host-run
stop lab126_gui 2>/dev/null
lipc-set-prop com.lab126.powerd preventScreenSaver 1
# the stock firewall drops inbound Wi-Fi connections; open the debug port
iptables -I INPUT -p tcp --dport 2323 -j ACCEPT 2>/dev/null
# supervisor: a crash restarts the host; a clean exit (footer tap, :exit) stops the loop
nohup sh -c 'while :; do /var/tmp/eink-host-run >>/var/tmp/todo-app/stdout.log 2>&1 && break; sleep 2; done' >/dev/null 2>&1 &
