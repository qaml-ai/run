#!/usr/bin/env bash
# Ubuntu 24.04 nested-KVM host. No cloud control-plane operations.
set -euo pipefail
GO_VERSION=1.24.0
FIRECRACKER_VERSION=v1.13.1
FIRECRACKER_SHA256=UNPINNED
GUEST_KERNEL_URL=https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/v1.13/x86_64/vmlinux-6.1.141
GUEST_KERNEL_SHA256=UNPINNED
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
fail() { echo "ERROR: $*" >&2; exit 1; }
summary() {
  echo '== Summary'
  node --version || true
  /usr/local/go/bin/go version || true
  /usr/local/bin/firecracker --version || true
  if [[ -f /usr/local/bin/camelfsd.commit ]]; then cat /usr/local/bin/camelfsd.commit; fi
  df -h /nvme || true
  systemctl --no-pager is-active camel-kvm-prep nftables camel-egress-proxy camelfsd camel-jobhost || true
}
if [[ ${1:-} == --check ]]; then summary; exit 0; fi
[[ $# == 0 ]] || fail 'Usage: host-setup.sh [--check]'
echo '== Checks'
[[ $EUID == 0 ]] || fail 'Run as root'
# shellcheck source=/dev/null
source /etc/os-release
[[ $ID == ubuntu && $VERSION_ID == 24.04 ]] || fail 'Ubuntu 24.04 is required'
[[ $(uname -m) == x86_64 ]] || fail 'x86_64 is required'
[[ -c /dev/kvm ]] || fail '/dev/kvm is missing; enable nested KVM'
[[ -f /etc/camel/kvm-host.conf ]] || fail 'Copy kvm-host.conf.example to /etc/camel/kvm-host.conf and fill it in'
RUN_REF=main CAMELFSD_REF=camelfs/daemon-v0
UBUNTU_MIRROR='' GUEST_IMAGE_GIB=6
# No xtrace: configuration and secret files must never be echoed.
# shellcheck source=/dev/null
source /etc/camel/kvm-host.conf
[[ -n ${RUNTIME_URL:-} && -n ${CAMELFSD_STORE:-} ]] || fail 'Set RUNTIME_URL and CAMELFSD_STORE'
export UBUNTU_MIRROR GUEST_IMAGE_GIB
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
# Compare before installing, so an unchanged run does not restart services.
changed=0
put() {
  local from=$1 to=$2 mode=${3:-0644}
  if ! cmp -s "$from" "$to" || [[ $(stat -c %a "$to" 2>/dev/null || true) != "${mode#0}" ]]; then
    install -D -m "$mode" "$from" "$to"; changed=1
  fi
}
verify() {
  local name=$1 expected=$2 file=$3 actual
  actual=$(sha256sum "$file" | cut -d ' ' -f1)
  if [[ $expected == UNPINNED ]]; then echo "PIN $name=$actual";
  elif [[ $expected != "$actual" ]]; then fail "$name mismatch"; fi
}
echo '== Packages'
export DEBIAN_FRONTEND=noninteractive
packages=(xfsprogs nbd-client dmsetup thin-provisioning-tools nftables iproute2 socat debootstrap e2fsprogs curl jq git ca-certificates build-essential unzip rsync openssl xz-utils)
missing=()
for package in "${packages[@]}"; do
  [[ $(dpkg-query -W -f='${Status}' "$package" 2>/dev/null || true) == 'install ok installed' ]] || missing+=("$package")
done
if ((${#missing[@]})); then apt-get update -qq; apt-get install -y -qq "${missing[@]}"; fi
if ! command -v node >/dev/null || [[ $(node --version) != v22.* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x -o "$work/nodesource.sh"
  bash "$work/nodesource.sh"
  apt-get install -y -qq nodejs
fi
node_path=$(command -v node)
if [[ $node_path != /usr/local/bin/node && $(readlink /usr/local/bin/node 2>/dev/null || true) != "$node_path" ]]; then
  ln -sfn "$node_path" /usr/local/bin/node
fi
if [[ ! -x /usr/local/go/bin/go ]] || [[ $(/usr/local/go/bin/go version) != "go version go$GO_VERSION linux/amd64" ]]; then
  curl -fsSL "https://go.dev/dl/go$GO_VERSION.linux-amd64.tar.gz" -o "$work/go.tgz"
  # Check against go.dev's published digest as well as HTTPS.
  curl -fsSL 'https://go.dev/dl/?mode=json&include=all' -o "$work/go.json"
  go_hash=$(jq -er --arg f "go$GO_VERSION.linux-amd64.tar.gz" '[.[].files[] | select(.filename==$f)][0].sha256' "$work/go.json")
  verify GO_SHA256 "$go_hash" "$work/go.tgz"
  tar -xzf "$work/go.tgz" -C "$work"
  rm -rf /usr/local/go
  mv "$work/go" /usr/local/go
fi
if [[ -f /etc/cloudflared/camelfs.token ]] && [[ ! -x /usr/bin/cloudflared ]]; then
  install -d /usr/share/keyrings
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
  echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared noble main' > /etc/apt/sources.list.d/cloudflared.list
  apt-get update -qq; apt-get install -y -qq cloudflared
fi
echo '== Modules'
for module in nbd dm-clone ublk_drv dm-thin-pool vhost_vsock; do modprobe "$module"; done
printf '%s\n' nbd dm-clone ublk_drv dm-thin-pool vhost_vsock > "$work/modules"
put "$work/modules" /etc/modules-load.d/camelfs.conf
bash "$here/files/camel-kvm-prep" --storage-only

echo '== Source'
checkout() {
  local dir=$1 ref=$2
  if [[ ! -d $dir/.git ]]; then git clone -q https://github.com/qaml-ai/run.git "$dir"; fi
  git -C "$dir" fetch -q origin "$ref"
  git -C "$dir" checkout -q --detach FETCH_HEAD
}
install -d /opt/camel /var/lib/camel/guest /var/lib/camel/images
checkout /opt/camel/src "$RUN_REF"
agent_changed=0
for tree in jobhost shared; do
  if [[ -n $(rsync -rcni --delete "/opt/camel/src/$tree/" "/opt/camel/$tree/") ]]; then
    rsync -rc --delete "/opt/camel/src/$tree/" "/opt/camel/$tree/"; agent_changed=1
  fi
done
checkout /opt/camel/camelfsd-src "$CAMELFSD_REF"
commit=$(git -C /opt/camel/camelfsd-src rev-parse HEAD)
daemon_changed=0
if [[ ! -x /usr/local/bin/camelfsd || $(cat /usr/local/bin/camelfsd.commit 2>/dev/null || true) != "$commit" ]]; then
  (cd /opt/camel/camelfsd-src/camelfsd && /usr/local/go/bin/go build -o "$work/camelfsd" ./cmd/camelfsd)
  install -m 0755 "$work/camelfsd" /usr/local/bin/camelfsd
  echo "$commit" > /usr/local/bin/camelfsd.commit
  daemon_changed=1
fi

echo '== Firecracker'
vm_changed=0
if [[ ! -x /usr/local/bin/firecracker ]] || ! /usr/local/bin/firecracker --version | head -1 | grep -qx "Firecracker $FIRECRACKER_VERSION"; then
  curl -fsSL "https://github.com/firecracker-microvm/firecracker/releases/download/$FIRECRACKER_VERSION/firecracker-$FIRECRACKER_VERSION-x86_64.tgz" -o "$work/fc.tgz"
  verify FIRECRACKER_SHA256 "$FIRECRACKER_SHA256" "$work/fc.tgz"
  tar -xzf "$work/fc.tgz" -C "$work"
  install -m 0755 "$work/release-$FIRECRACKER_VERSION-x86_64/firecracker-$FIRECRACKER_VERSION-x86_64" /usr/local/bin/firecracker
  vm_changed=1
fi
echo '== Guest kernel'
kernel=/var/lib/camel/guest/vmlinux
if [[ ! -f $kernel || $(cat "$kernel.url" 2>/dev/null || true) != "$GUEST_KERNEL_URL" ]]; then
  curl -fsSL "$GUEST_KERNEL_URL" -o "$work/vmlinux"
  verify GUEST_KERNEL_SHA256 "$GUEST_KERNEL_SHA256" "$work/vmlinux"
  install -m 0644 "$work/vmlinux" "$kernel"
  echo "$GUEST_KERNEL_URL" > "$kernel.url"
  vm_changed=1
else
  verify GUEST_KERNEL_SHA256 "$GUEST_KERNEL_SHA256" "$kernel"
fi
echo '== Guest rootfs'
base=/var/lib/camel/images/base.ext4
# Includes the requested inputs, plus build configuration that changes the resulting image.
inputs=$({ sha256sum "$here/guest-rootfs.sh" /opt/camel/src/infra/job-hosts/image/files/camel-init /opt/camel/src/jobhost/guest.ts /opt/camel/src/jobhost/camelfs-wire.ts | cut -d ' ' -f1; sed -n 's/^NODE_VERSION=//p' "$here/guest-rootfs.sh"; printf '%s\n' "$UBUNTU_MIRROR" "$GUEST_IMAGE_GIB"; } | sha256sum | cut -d ' ' -f1)
if [[ ! -f $base || $(cat "$base.inputs" 2>/dev/null || true) != "$inputs" ]]; then
  bash "$here/guest-rootfs.sh" /opt/camel/src "$base"
  echo "$inputs" > "$base.inputs"
  vm_changed=1
fi
bash "$here/files/camel-kvm-prep"
echo '== Secrets'
if [[ ! -f /etc/camel/camelfs-api.env ]]; then
  (umask 077; printf 'CAMELFS_API_TOKEN=%s\n' "$(openssl rand -hex 32)" > /etc/camel/camelfs-api.env)
fi
if [[ $(stat -c %u:%g /etc/camel/camelfs-api.env) != 0:0 ]]; then chown root:root /etc/camel/camelfs-api.env; fi
if [[ $(stat -c %a /etc/camel/camelfs-api.env) != 600 ]]; then chmod 0600 /etc/camel/camelfs-api.env; fi

echo '== Units'
if ! getent passwd camel-proxy >/dev/null; then
  useradd --system --uid 940 --user-group --no-create-home --shell /usr/sbin/nologin camel-proxy
fi
[[ $(id -u camel-proxy) == 940 ]] || fail 'camel-proxy must have UID 940 for firewall isolation'
declare -A restart=()
changed=0
put "$here/files/camel-kvm-prep" /usr/local/sbin/camel-kvm-prep 0755
put "$here/systemd/camel-kvm-prep.service" /etc/systemd/system/camel-kvm-prep.service
restart[camel-kvm-prep]=$changed
changed=0
put "$here/files/camelfsd-cleanup" /usr/local/sbin/camelfsd-cleanup 0755
put "$here/systemd/camelfsd.service" /etc/systemd/system/camelfsd.service
restart[camelfsd]=$((changed | daemon_changed))
changed=0
put "$here/systemd/camel-jobhost.service" /etc/systemd/system/camel-jobhost.service
restart[camel-jobhost]=$((changed | agent_changed | vm_changed))
changed=0
put /opt/camel/src/infra/job-hosts/image/files/camel-egress-proxy.service /etc/systemd/system/camel-egress-proxy.service
# Override only the AL2023 prep dependency. The source unit stays unchanged.
cat > "$work/proxy.conf" <<'DROPIN'
[Unit]
After=
After=camel-kvm-prep.service nftables.service
Requires=
Requires=camel-kvm-prep.service nftables.service
DROPIN
put "$work/proxy.conf" /etc/systemd/system/camel-egress-proxy.service.d/kvm.conf
restart[camel-egress-proxy]=$((changed | agent_changed))
changed=0
put /opt/camel/src/infra/job-hosts/image/files/camel-host.nft /etc/nftables.d/camel-host.nft
if ! grep -qF 'include "/etc/nftables.d/camel-host.nft"' /etc/nftables.conf; then
  echo 'include "/etc/nftables.d/camel-host.nft"' >> /etc/nftables.conf; changed=1
fi
restart[nftables]=$changed
if [[ -f /etc/cloudflared/camelfs.token ]]; then
  if [[ $(systemctl show cloudflared-camelfs.service -p LoadState --value) == not-found ]]; then
    changed=0
    put "$here/systemd/cloudflared-camelfs.service" /etc/systemd/system/cloudflared-camelfs.service
    restart[cloudflared-camelfs]=$changed
  else
    echo '== Existing cloudflared-camelfs.service left alone'
  fi
fi
systemctl daemon-reload
for unit in camel-kvm-prep nftables camel-egress-proxy camelfsd camel-jobhost cloudflared-camelfs; do
  [[ -v restart[$unit] ]] || continue
  systemctl enable "$unit.service"
  if [[ ${restart[$unit]} == 1 ]]; then
    echo "== Restart $unit"; systemctl restart "$unit.service"
  else
    echo "== Ensure $unit is started"; systemctl start "$unit.service"
  fi
done
summary
