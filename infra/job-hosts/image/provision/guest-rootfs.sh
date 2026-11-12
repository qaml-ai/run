#!/usr/bin/env bash
# The base root image a job VM boots (host-setup.sh runs it on the image builder): Amazon Linux 2023 userland with the
# usual build and test tools, Node 22 for camel-guest (jobhost/guest.ts), socat for its vsock channel, and camel-init
# as PID 1. A job's disk is a reflink clone of it, grown to the job's size.
# Usage: guest-rootfs.sh <image dir> <output .ext4>
set -euo pipefail
src=${1:?image dir} out=${2:?output image}
gib=${GUEST_IMAGE_GIB:-6}
root=$(mktemp -d); trap 'umount -R "$root/proc" 2>/dev/null || true; rm -rf "$root"' EXIT
dnf -y -q --installroot="$root" --releasever=2023 --setopt=install_weak_deps=False install \
  bash coreutils findutils grep sed gawk tar gzip xz bzip2 unzip which procps-ng util-linux iproute shadow-utils \
  ca-certificates curl git make gcc gcc-c++ python3 python3-pip nodejs22 nodejs22-npm socat e2fsprogs
# camel-init and the guest run /usr/local/bin/node (AL2023's nodejs22 installs node-22).
if [[ -e $root/usr/bin/node-22 ]]; then ln -sf /usr/bin/node-22 "$root/usr/local/bin/node"; else ln -sf /usr/bin/node "$root/usr/local/bin/node"; fi
install -d -m 0755 "$root/opt/camel" "$root/repo" "$root/out"
install -m 0644 "$src/jobhost/guest.ts" "$root/opt/camel/guest.ts"
install -m 0755 "$src/files/camel-init" "$root/sbin/camel-init"
dnf -y -q --installroot="$root" clean all
truncate -s "${gib}G" "$out"
mkfs.ext4 -q -F -L camel-root -d "$root" "$out"
