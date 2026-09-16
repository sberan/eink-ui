#!/bin/sh
# Name: Todo UI Stop
# Author: Sam
# DontUseFBInk: true
pkill -f eink-host-run 2>/dev/null
lipc-set-prop com.lab126.powerd preventScreenSaver 0
start lab126_gui 2>/dev/null
