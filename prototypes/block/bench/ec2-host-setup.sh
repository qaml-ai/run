#!/usr/bin/env bash
# camelFS proto host setup (re-run after an instance stop/start wipes the instance-store NVMe).
#   sudo bash host-setup.sh            # format+mount /nvme (XFS reflink), tools, Go, Node, AWS CLI, CH, trees
set -euo pipefail
NVME=${NVME:-/dev/nvme1n1}
if ! mountpoint -q /nvme; then
  blkid "$NVME" >/dev/null 2>&1 && [ "$(blkid -o value -s TYPE "$NVME")" = xfs ] || mkfs.xfs -q -f -m reflink=1 "$NVME"
  mkdir -p /nvme && mount -o noatime "$NVME" /nvme
fi
chown ubuntu /nvme
grep -q " /nvme " /etc/fstab || echo "$NVME /nvme xfs noatime,nofail 0 0" >> /etc/fstab
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null; apt-get install -y -qq qemu-utils cloud-image-utils nbd-client fio xfsprogs thin-provisioning-tools unzip curl jq build-essential dmsetup git >/dev/null
for m in ublk_drv dm-thin-pool dm-clone nbd; do modprobe $m; done
grep -qxF nbd /etc/modules-load.d/camelfs.conf 2>/dev/null || printf 'nbd\ndm-clone\nublk_drv\n' > /etc/modules-load.d/camelfs.conf
[ -x /usr/local/go/bin/go ] || curl -sL https://go.dev/dl/go1.24.0.linux-amd64.tar.gz | tar -C /usr/local -xz
command -v aws >/dev/null || { curl -sL https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip -o /tmp/awscli.zip && (cd /tmp && unzip -qo awscli.zip && ./aws/install >/dev/null); }
command -v node >/dev/null || { curl -sL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1 && apt-get install -y -qq nodejs >/dev/null; }
sudo -u ubuntu mkdir -p /nvme/ch /nvme/bench/trees /nvme/bench/work
cd /nvme/ch
[ -x cloud-hypervisor ] || { curl -sL -o cloud-hypervisor https://github.com/cloud-hypervisor/cloud-hypervisor/releases/latest/download/cloud-hypervisor-static && chmod +x cloud-hypervisor; }
[ -f noble.raw ] || { curl -sL -o noble.img https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img && qemu-img convert -f qcow2 -O raw noble.img noble.raw && qemu-img resize -f raw noble.raw 8G >/dev/null; }
[ -f /home/ubuntu/keep/ch/guest_key ] && cp -n /home/ubuntu/keep/ch/{guest_key,guest_key.pub,seed.iso,user-data,meta-data,network-config} /nvme/ch/ 2>/dev/null || true
chown -R ubuntu /nvme/ch
SRC=/home/ubuntu/camelfsd-src
[ -d $SRC ] || sudo -u ubuntu git clone -q --branch camelfs/daemon-v0 https://github.com/qaml-ai/run.git $SRC
cp $SRC/prototypes/block/bench/gen.mjs /nvme/bench/gen.mjs
for s in small medium large; do [ -d /nvme/bench/trees/$s ] || sudo -u ubuntu node /nvme/bench/gen.mjs /nvme/bench/trees/$s $s; done
cd /nvme/bench && sudo -u ubuntu bash $SRC/prototypes/block/bench/guest.sh prep >/dev/null 2>&1 || true
echo "host-setup done: $(df -h /nvme | tail -1)"
