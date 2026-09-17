#!/bin/sh
# Name: SSH On
# Author: Sam
# DontUseFBInk: true
# Starts a dropbear SSH server (key auth only) so scp/ssh work over Wi-Fi.
# Needs /mnt/us/todo-app/dropbearmulti and /mnt/us/todo-app/authorized_keys.
D=/var/local/eink-ui
mkdir -p $D
cp /mnt/us/todo-app/dropbearmulti $D/dropbearmulti && chmod 755 $D/dropbearmulti
cp /mnt/us/todo-app/authorized_keys $D/authorized_keys
[ -f $D/host_key ] || $D/dropbearmulti dropbearkey -t ed25519 -f $D/host_key
# dropbear reads root's ~/.ssh/authorized_keys and the login shell needs scp on its PATH;
# both live on the read-only rootfs
H=$(awk -F: '$1=="root"{print $6}' /etc/passwd); H=${H%/}
mntroot rw
mkdir -p "$H/.ssh" && chmod 700 "$H/.ssh"
cp $D/authorized_keys "$H/.ssh/authorized_keys" && chmod 600 "$H/.ssh/authorized_keys"
[ -e /usr/bin/scp ] || ln -s $D/dropbearmulti /usr/bin/scp
mntroot ro
iptables -I INPUT -p tcp --dport 22 -j ACCEPT 2>/dev/null
$D/dropbearmulti dropbear -r $D/host_key -p 22 -P /var/tmp/dropbear.pid
