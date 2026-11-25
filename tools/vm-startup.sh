#!/bin/bash
set -euo pipefail

disk=/dev/disk/by-id/google-golaberto-data
mount=/mnt/disks/golaberto
test "$(blkid -s LABEL -o value "$disk")" = golaberto-data
test "$(blkid -s TYPE -o value "$disk")" = ext4

systemctl stop docker.service docker.socket
mkdir -p "$mount"
if ! mountpoint -q "$mount"; then
  mount -o discard,defaults "$disk" "$mount"
fi
test "$(findmnt -n -o SOURCE --target "$mount")" = "$(readlink -f "$disk")"
swap="$mount/swapfile"
test -f "$swap"
if ! swapon --noheadings --show=NAME | grep -Fx "$swap" >/dev/null; then
  chmod 0600 "$swap"
  swapon "$swap"
fi
swapon --noheadings --show=NAME | grep -Fx "$swap" >/dev/null
mkdir -p "$mount/docker"
jq --arg root "$mount/docker" \
  '.["data-root"] = $root | .["log-opts"] += {"max-size":"10m", "max-file":"3"}' \
  /etc/docker/daemon.json > /var/lib/docker/daemon.json
systemctl start docker.service
test "$(docker info --format '{{.DockerRootDir}}')" = "$mount/docker"
