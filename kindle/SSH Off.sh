#!/bin/sh
# Name: SSH Off
# Author: Sam
# DontUseFBInk: true
[ -f /var/tmp/dropbear.pid ] && kill "$(cat /var/tmp/dropbear.pid)" 2>/dev/null
pkill -f "dropbearmulti dropbear" 2>/dev/null
iptables -D INPUT -p tcp --dport 22 -j ACCEPT 2>/dev/null
