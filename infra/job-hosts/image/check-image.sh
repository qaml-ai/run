#!/usr/bin/env bash
# Checks a built job host image (the last step of host.pkr.hcl, and runnable on any host from it): the pinned files are
# what versions.env and the build recorded, and the setup is in place. Exits non-zero on the first difference.
set -euo pipefail
fail() { echo "check-image: $*" >&2; exit 1; }
[[ $(sha256sum /usr/local/bin/firecracker | cut -d' ' -f1) == "$(cat /var/lib/camel/firecracker.sha256)" ]] || fail "firecracker is not the pinned binary"
( cd / && sha256sum --quiet -c /var/lib/camel/image.sha256 ) || fail "an image file changed since the build"
/usr/local/bin/firecracker --version | grep -q "Firecracker v1.18.0" || fail "firecracker is not v1.18.0"
nft -c -f /etc/nftables/camel-host.nft || fail "the base rules do not load"
getent passwd camel-proxy | cut -d: -f3 | grep -qx 940 || fail "camel-proxy is not uid 940"
grubby --info=DEFAULT | grep -q 'nitro_enclaves.mempool=' || fail "no Nitro Sandboxes memory pool on the kernel command line"
systemctl is-enabled --quiet camel-host-prep camel-egress-proxy camel-jobhost nftables amazon-ssm-agent || fail "a unit is not enabled"
! systemctl is-enabled --quiet sshd 2>/dev/null || fail "sshd is enabled"
dumpe2fs -h /var/lib/camel/images/base.ext4 2>/dev/null | grep -q 'Filesystem volume name:   camel-root' || fail "the base image is not the camel root"
debugfs -R 'stat /sbin/camel-init' /var/lib/camel/images/base.ext4 2>/dev/null | grep -q 'Type: regular' || fail "the base image has no camel-init"
# Nitro Sandboxes need the parent kernel's nitro_enclaves support: AL2023 kernel6.18 from 6.18.51-120.162.amzn2023.
kernel=$(ls /lib/modules | sort -V | tail -1)
[[ $(printf '%s\n' 6.18.51-120.162.amzn2023.aarch64 "$kernel" | sort -V | head -1) == 6.18.51-120.162.amzn2023.aarch64 ]] || fail "kernel $kernel predates Nitro Sandboxes support (6.18.51-120.162.amzn2023)"
/usr/local/bin/node --version | grep -q '^v22\.' || fail "node is not 22"
echo "check-image: ok"
