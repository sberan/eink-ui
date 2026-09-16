#!/bin/sh
# Run on the Mac with the Kindle mounted: removes jailbreak leftovers and superseded experiments.
set -e
K=/Volumes/Kindle
[ -d "$K/documents" ] || { echo "Kindle not mounted"; exit 1; }
rm -rf "$K/filler" "$K/dashboard" "$K/mesquito" "$K/apps" "$K/.active_content_sandbox/store/resource/cachedResources"
rm -f "$K/documents/Dashboard Start.sh" "$K/documents/Dashboard Stop.sh" "$K/documents/Todo Web.sh" "$K/documents/Todo Web Stop.sh" "$K/documents/KUAL.sh"
rm -rf "$K/documents/Dashboard Start.sdr" "$K/documents/Dashboard Stop.sdr" "$K/documents/Todo Web.sdr" "$K/documents/Todo Web Stop.sdr" "$K/documents/KUAL.sh.sdr"
find "$K" -maxdepth 2 -name '._*' -delete 2>/dev/null || true
df -h "$K" | tail -1
ls "$K" "$K/documents" | grep -v "\.sdr$"
