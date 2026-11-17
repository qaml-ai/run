#!/bin/bash
set -euo pipefail
out=$1
kernel=$(ls -v /boot/vmlinuz-* | tail -1)
version=${kernel#/boot/vmlinuz-}
mkdir -p "$out/root"/{dev,sys,proc,bin,mods}
cp "${CAMELFS_BENCH_KERNEL:-$kernel}" "$out/kernel"
cp /bin/busybox "$out/root/bin/"
ln -s busybox "$out/root/bin/sh"
cp "$(dirname "$0")/guest.sh" "$out/root/init"
chmod 755 "$out/root/init"
for mod in virtio_pci virtio_blk 9pnet_virtio 9p ext4 overlay; do
    modprobe -S "$version" --show-depends "$mod"
done | awk '$1=="insmod" && !seen[$2]++ {print $2}' > "$out/modules"
touch "$out/root/load"
while read -r file; do
    name=$(basename "${file%%.ko*}").ko
    case "$file" in
        *.zst) zstdcat "$file" > "$out/root/mods/$name";;
        *.xz) xzcat "$file" > "$out/root/mods/$name";;
        *.ko) cp "$file" "$out/root/mods/$name";;
        *) exit 2;;
    esac
    echo "$name" >> "$out/root/load"
done < "$out/modules"
(cd "$out/root" && find . | cpio --quiet -o -H newc | gzip -1) > "$out/init.gz"
