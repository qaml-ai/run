#!/usr/bin/env bash
# Install the v2 init onto a private copy of an existing Linux ext4 rootfs.
set -euo pipefail

if (( $# != 3 )); then
  echo "Usage: $0 BASE_ROOTFS GUEST_INIT NEW_ROOTFS" >&2
  exit 2
fi

base=$(realpath "$1")
init=$(realpath "$2")
output=$(realpath -m "$3")
test -f "$base"
test -x "$init"
test ! -e "$output"

work=$(mktemp -d "$(dirname "$output")/.camelfs-rootfs.XXXXXX")
trap 'rm -rf -- "$work"' EXIT
cp --reflink=auto --sparse=always -- "$base" "$work/rootfs"
install -m 0755 -- "$init" "$work/init"
cd "$work"
debugfs -w -R 'write init /sbin/camelfs-guest-init' rootfs
debugfs -R 'dump /sbin/camelfs-guest-init installed-init' rootfs
cmp init installed-init
ln -- rootfs "$output"
