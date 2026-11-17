#!/bin/bash
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
sudo apt-get -qq update
sudo env DEBIAN_FRONTEND=noninteractive apt-get -qq install -y --no-install-recommends erofs-utils nbdkit nbdkit-plugin-python qemu-system-x86 linux-image-virtual busybox-static tcc dmsetup cpio zstd kmod
kernel=$(ls -v /boot/vmlinuz-* | tail -1)
version=${kernel#/boot/vmlinuz-}
if ! modinfo -k "$version" erofs >/dev/null || ! modinfo -k "$version" 9p >/dev/null; then
    sudo apt-get -qq install -y "linux-modules-extra-$version"
fi
sudo cat "$kernel" > "$work/readable"
# Share the earlier Linux boot fixture. Replace only the guest entrypoint and filesystem module.
sed 's/9p ext4 overlay dm_verity/9p erofs overlay/' "$here/../workspace-layouts/kernel.sh" > "$work/kernel.sh"
cp "$here/guest.sh" "$work/"
CAMELFS_BENCH_KERNEL="$work/readable" bash "$work/kernel.sh" "$work/boot"
python3 "$here/trial.py" "$work" "$@"
