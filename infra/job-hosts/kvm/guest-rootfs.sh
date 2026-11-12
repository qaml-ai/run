#!/usr/bin/env bash
set -euo pipefail
NODE_VERSION=22.21.1
NODE_SHA256=UNPINNED
src=${1:?usage: guest-rootfs.sh SRC OUT.ext4}
out=${2:?usage: guest-rootfs.sh SRC OUT.ext4}
[[ $EUID == 0 ]] || { echo 'Must run as root' >&2; exit 1; }
gib=${GUEST_IMAGE_GIB:-6}
[[ $gib =~ ^[1-9][0-9]*$ ]] || { echo 'GUEST_IMAGE_GIB must be a positive integer' >&2; exit 1; }
work=$(mktemp -d)
cleanup() {
  mountpoint -q "$work/root" && umount -R "$work/root"
  # debootstrap may leave proc or dev mounts on failure.
  while read -r target; do umount "$target"; done < <(findmnt -Rrn -o TARGET | awk -v p="$work/" 'index($0,p)==1' | sort -r)
  rm -rf --one-file-system "$work"
}
trap cleanup EXIT
root=$work/root
echo '== Guest Ubuntu noble minbase'
debootstrap --variant=minbase --include=bash,coreutils,findutils,grep,sed,gawk,tar,gzip,xz-utils,bzip2,unzip,procps,util-linux,iproute2,ca-certificates,curl,git,make,gcc,g++,python3,python3-pip,socat,e2fsprogs \
  noble "$root" "${UBUNTU_MIRROR:-http://archive.ubuntu.com/ubuntu}"
echo "== Guest Node $NODE_VERSION"
curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz" -o "$work/node.tar.xz"
hash=$(sha256sum "$work/node.tar.xz" | cut -d ' ' -f1)
if [[ $NODE_SHA256 == UNPINNED ]]; then echo "PIN NODE_SHA256=$hash";
elif [[ $hash != "$NODE_SHA256" ]]; then echo 'NODE_SHA256 mismatch' >&2; exit 1; fi
tar -xJf "$work/node.tar.xz" -C "$root/usr/local" --strip-components=1
install -d -m 0755 "$root/opt/camel" "$root/repo" "$root/out"
install -m 0644 "$src/jobhost/guest.ts" "$root/opt/camel/guest.ts"
install -m 0644 "$src/jobhost/camelfs-wire.ts" "$root/opt/camel/camelfs-wire.ts"
install -m 0755 "$src/infra/job-hosts/image/files/camel-init" "$root/sbin/camel-init"
rm -f "$root/var/cache/apt/archives/"*.deb
mkdir -p "$(dirname "$out")"
echo "== Guest ext4 image (${gib} GiB)"
# Only replace a completed image, preserving the previous image on failure.
truncate -s "${gib}G" "$work/base.ext4"
mkfs.ext4 -q -F -L camel-root -d "$root" "$work/base.ext4"
cp --sparse=always "$work/base.ext4" "$out.new"
mv "$out.new" "$out"
