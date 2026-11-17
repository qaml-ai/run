#!/bin/bash
set -euo pipefail
sudo apt-get -qq update
sudo env DEBIAN_FRONTEND=noninteractive apt-get -qq install -y --no-install-recommends qemu-system-x86 qemu-utils qemu-block-extra busybox-static linux-image-virtual cpio zstd kmod tcc cryptsetup-bin dmsetup
version=$(ls -v /boot/vmlinuz-* | tail -1)
version=${version#/boot/vmlinuz-}
if ! modinfo -k "$version" 9p >/dev/null 2>&1 || ! modinfo -k "$version" dm_verity >/dev/null 2>&1; then
    sudo env DEBIAN_FRONTEND=noninteractive apt-get -qq install -y "linux-modules-extra-$version"
fi
out=$1
shift
mkdir -p "$out"
# The packaged kernel is readable only by root. Everything after the copy runs unprivileged.
kernel=$(mktemp)
trap 'rm -f "$kernel"' EXIT
sudo cat "/boot/vmlinuz-$version" > "$kernel"
export CAMELFS_BENCH_KERNEL="$kernel"
python3 "$(dirname "$0")/bench.py" "$out" "$@"
