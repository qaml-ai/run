#!/usr/bin/env bash
# Turns a fresh Amazon Linux 2023 arm64 instance into a job host image (host.pkr.hcl runs it; docs/design/
# job-hosts-plan.md, slice 1). Usage: POOL=build|test host-setup.sh <the image directory, with jobhost/ and shared/>
# What it leaves, checked by check-image.sh:
#   /usr/local/bin/firecracker           Firecracker, pinned by sha256 (versions.env)
#   /var/lib/camel/guest/vmlinux         the guest kernel (this host's own kernel)
#   /var/lib/camel/guest/initrd.img      a dracut initrd with the virtio drivers, which switch_roots into /dev/vda
#   /var/lib/camel/images/base.ext4      the base root image a job's disk is cloned from (guest-rootfs.sh)
#   /opt/camel/                          the host agent and egress proxy (jobhost/, shared/), run by Node 22
#   /etc/nftables/camel-host.nft         the base network rules, loaded at boot
#   systemd units: camel-host-prep (NVMe, pcie_slots), camel-egress-proxy, camel-jobhost
#   the kernel command line: nitro_enclaves.mempool for the pool; no sshd
set -euo pipefail
src=${1:?usage: host-setup.sh <image dir>}
pool=${POOL:?set POOL=build or POOL=test}
[[ $pool == build || $pool == test ]] || { echo "POOL is build or test" >&2; exit 2; }
source "$src/versions.env"
arch=$(uname -m)
[[ $arch == aarch64 ]] || { echo "The job host image is arm64 (Graviton), not $arch." >&2; exit 2; }

echo "==> Packages"
dnf -y -q install nodejs22 nftables xfsprogs e2fsprogs dracut iproute tar gzip socat jq util-linux-core
ln -sf "$(command -v node-22 || command -v node)" /usr/local/bin/node

echo "==> Firecracker $FIRECRACKER_VERSION (sha256 pinned)"
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
curl -fsSL -o "$work/fc.tgz" "https://github.com/firecracker-microvm/firecracker/releases/download/${FIRECRACKER_VERSION}/firecracker-${FIRECRACKER_VERSION}-aarch64.tgz"
echo "$FIRECRACKER_TGZ_SHA256  $work/fc.tgz" | sha256sum -c -
tar -xzf "$work/fc.tgz" -C "$work"
bin="$work/release-${FIRECRACKER_VERSION}-aarch64/firecracker-${FIRECRACKER_VERSION}-aarch64"
echo "$FIRECRACKER_BIN_SHA256  $bin" | sha256sum -c -
install -m 0755 "$bin" /usr/local/bin/firecracker

echo "==> The guest kernel and initrd"
kver=$(uname -r)
install -d -m 0755 /var/lib/camel/guest /var/lib/camel/images
# The host's own kernel boots the guest (the spike's): Firecracker on arm64 takes its EFI image.
install -m 0644 "/boot/vmlinuz-$kver" /var/lib/camel/guest/vmlinux
dracut --force --no-hostonly --kver "$kver" \
  --add-drivers "virtio_blk virtio_net virtio_mmio virtio_pci vsock vmw_vsock_virtio_transport ext4" \
  --omit "plymouth network-manager systemd-networkd" /var/lib/camel/guest/initrd.img
chmod 0644 /var/lib/camel/guest/initrd.img

echo "==> The base root image"
GUEST_IMAGE_GIB=$GUEST_IMAGE_GIB bash "$src/provision/guest-rootfs.sh" "$src" /var/lib/camel/images/base.ext4

echo "==> The host agent and egress proxy"
install -d -m 0755 /opt/camel
cp -a "$src/jobhost" "$src/shared" /opt/camel/
chown -R root:root /opt/camel
# The proxy's own user, at the uid the base rules name (jobhost/network.ts PROXY_UID).
getent passwd camel-proxy >/dev/null || useradd --system --uid 940 --user-group --no-create-home --shell /sbin/nologin camel-proxy
install -m 0644 "$src/files/jobhost.env" /etc/camel-jobhost.env
sed -i "s/^POOL=.*/POOL=$pool/" /etc/camel-jobhost.env
# A build host runs one build sandbox and nothing else (it is priced as the whole host: backends/workers/src/jobs/host-pricing.ts).
if [[ $pool == build ]]; then sed -i "s/^SLOTS=.*/SLOTS=1/" /etc/camel-jobhost.env; fi

echo "==> Network rules, units, and Nitro Sandboxes"
install -m 0644 "$src/files/camel-host.nft" /etc/nftables/camel-host.nft
grep -q 'camel-host.nft' /etc/sysconfig/nftables.conf 2>/dev/null || echo 'include "/etc/nftables/camel-host.nft"' >> /etc/sysconfig/nftables.conf
for unit in camel-host-prep.service camel-egress-proxy.service camel-jobhost.service; do install -m 0644 "$src/files/$unit" "/etc/systemd/system/$unit"; done
install -m 0755 "$src/files/camel-host-prep" /usr/local/sbin/camel-host-prep
systemctl enable nftables.service camel-host-prep.service camel-egress-proxy.service camel-jobhost.service amazon-ssm-agent.service
# No SSH: operators use SSM Session Manager.
systemctl disable --now sshd.service sshd.socket 2>/dev/null || true
systemctl mask sshd.service
# The sandboxes' memory pool, reserved at boot (takes effect on the first boot of an instance from this image).
mempool=$([[ $pool == build ]] && echo "$NE_MEMPOOL_BUILD" || echo "$NE_MEMPOOL_TEST")
grubby --update-kernel=ALL --args="nitro_enclaves.mempool=${mempool}@0"
echo "NE_PCIE_SLOTS=$NE_PCIE_SLOTS" >> /etc/camel-jobhost.env

echo "==> Hashes"
( cd / && sha256sum usr/local/bin/firecracker var/lib/camel/guest/vmlinux var/lib/camel/guest/initrd.img var/lib/camel/images/base.ext4 ) > /var/lib/camel/image.sha256
echo "$FIRECRACKER_BIN_SHA256" > /var/lib/camel/firecracker.sha256
