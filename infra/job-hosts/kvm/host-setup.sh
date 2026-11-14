#!/usr/bin/env bash
# Ubuntu 24.04 nested-KVM host. No cloud control-plane operations.
set -euo pipefail
GO_VERSION=1.24.0
FIRECRACKER_VERSION=v1.13.1
FIRECRACKER_SHA256=59450b9171ff2ebdf2f9a25be3a248a7ba79fb6371aec51a9d6d8eefca7b4faf
GUEST_KERNEL_URL=https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/v1.13/x86_64/vmlinux-6.1.141
GUEST_KERNEL_SHA256=b36a4a1b10f33b9cfdcde3d1a787d9c090556a3edb211cd06d1f3f9a6c7e8724
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
fail() { echo "ERROR: $*" >&2; exit 1; }
summary() {
  echo '== Summary'
  /usr/local/go/bin/go version || true
  /usr/local/bin/firecracker --version || true
  if [[ -f /usr/local/bin/camelfsd.commit ]]; then cat /usr/local/bin/camelfsd.commit; fi
  df -h /nvme || true
  systemctl --no-pager is-active camel-kvm-prep nftables camel-egress-proxy camelfsd || true
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
CAMELFSD_REF=main
# No xtrace: configuration and secret files must never be echoed.
# shellcheck source=/dev/null
source /etc/camel/kvm-host.conf
[[ -n ${CAMELFSD_STORE:-} ]] || fail 'Set CAMELFSD_STORE'
compute=0
if [[ -n ${TIER_ENROLL_URL:-}${TIER_HOSTS_ENDPOINT:-} ]]; then
  compute=1
  [[ -n ${TIER_ENROLL_URL:-} && -n ${TIER_HOSTS_ENDPOINT:-} ]] || fail 'Set both tier endpoints for compute'
  [[ ${CAMELFSD_IMAGES_STORE:-} == s3://?* ]] || fail 'Set CAMELFSD_IMAGES_STORE to s3://bucket[/prefix]'
  [[ ${TIER_CA_S3:-} =~ ^s3://[^/]+/.+ && ${TIER_CA_S3:-} != */ ]] || fail 'Set TIER_CA_S3 to an S3 object'
  [[ ${TIER_CA_SHA256:-} =~ ^[0-9a-f]{64}$ ]] || fail 'Set TIER_CA_SHA256 to a lowercase SHA-256'
elif [[ -n ${CAMELFSD_COMPUTE_FLAGS:-} ]]; then
  fail 'Replace CAMELFSD_COMPUTE_FLAGS with the tier settings in kvm-host.conf.example'
fi
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
packages=(xfsprogs nbd-client dmsetup thin-provisioning-tools nftables iproute2 socat awscli zstd e2fsprogs curl jq git ca-certificates build-essential unzip rsync openssl xz-utils)
missing=()
for package in "${packages[@]}"; do
  [[ $(dpkg-query -W -f='${Status}' "$package" 2>/dev/null || true) == 'install ok installed' ]] || missing+=("$package")
done
if ((${#missing[@]})); then apt-get update -qq; apt-get install -y -qq "${missing[@]}"; fi
ca_changed=0
if (( compute )); then
  echo '== Tier CA'
  aws s3 cp --region "${AWS_REGION:-us-west-2}" --only-show-errors "$TIER_CA_S3" "$work/tier-ca.pem"
  verify TIER_CA_SHA256 "$TIER_CA_SHA256" "$work/tier-ca.pem"
  changed=0
  put "$work/tier-ca.pem" "${TIER_CA:-/etc/camel/tier-ca.pem}"
  ca_changed=$changed
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
echo '== Modules'
# Exactly what camelfsd and Firecracker use: dm-snapshot (the job's writable layer over a dm-linear origin), nbd (the
# lazy origin), loop (the hydrated image; a no-op where it is built in) and vhost_vsock (the guest channel). camelfsd
# refuses to start without the snapshot target (dmsetup targets).
for module in dm-snapshot nbd loop vhost_vsock; do modprobe "$module"; done
printf '%s\n' dm-snapshot nbd loop vhost_vsock > "$work/modules"
put "$work/modules" /etc/modules-load.d/camelfs.conf
bash "$here/files/camel-kvm-prep"

echo '== Source'
checkout() {
  local dir=$1 ref=$2
  if [[ ! -d $dir/.git ]]; then git clone -q https://github.com/qaml-ai/run.git "$dir"; fi
  git -C "$dir" fetch -q origin "$ref"
  git -C "$dir" checkout -q --detach FETCH_HEAD
}
install -d /opt/camel /var/lib/camel/guest
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
  vm_changed=1
fi
if (( vm_changed )) || [[ ! -x /usr/local/bin/jailer ]]; then
  curl -fsSL "https://github.com/firecracker-microvm/firecracker/releases/download/$FIRECRACKER_VERSION/firecracker-$FIRECRACKER_VERSION-x86_64.tgz" -o "$work/fc.tgz"
  verify FIRECRACKER_SHA256 "$FIRECRACKER_SHA256" "$work/fc.tgz"
  tar -xzf "$work/fc.tgz" -C "$work"
  if (( vm_changed )); then
    install -m 0755 "$work/release-$FIRECRACKER_VERSION-x86_64/firecracker-$FIRECRACKER_VERSION-x86_64" /usr/local/bin/firecracker
  fi
  install -m 0755 "$work/release-$FIRECRACKER_VERSION-x86_64/jailer-$FIRECRACKER_VERSION-x86_64" /usr/local/bin/jailer
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
if [[ -e /usr/local/sbin/camelfsd-cleanup ]]; then rm -f /usr/local/sbin/camelfsd-cleanup; changed=1; fi
put "$here/systemd/camelfsd.service" /etc/systemd/system/camelfsd.service
restart[camelfsd]=$((changed | daemon_changed | ca_changed))
changed=0
if [[ -e /etc/systemd/system/camel-jobhost.service ]]; then
  # The TypeScript job host is gone: stop it and remove its unit (camelfsd is the only host process).
  systemctl disable --now camel-jobhost.service
  rm -f /etc/systemd/system/camel-jobhost.service
fi
put "$here/systemd/camel-egress-proxy.service" /etc/systemd/system/camel-egress-proxy.service
if [[ -e /etc/systemd/system/camel-egress-proxy.service.d/kvm.conf ]]; then rm -f /etc/systemd/system/camel-egress-proxy.service.d/kvm.conf; changed=1; fi
restart[camel-egress-proxy]=$((changed | daemon_changed))
changed=0
put "$here/files/camel-host.nft" /etc/nftables.d/camel-host.nft
if ! grep -qF 'include "/etc/nftables.d/camel-host.nft"' /etc/nftables.conf; then
  echo 'include "/etc/nftables.d/camel-host.nft"' >> /etc/nftables.conf; changed=1
fi
restart[nftables]=$changed
if [[ -e /etc/systemd/system/cloudflared-camelfs.service ]]; then
  # The tunnel fronted the removed /v0 socket API; nothing reaches the host through it any more.
  systemctl disable --now cloudflared-camelfs.service
  rm -f /etc/systemd/system/cloudflared-camelfs.service
fi
systemctl daemon-reload
for unit in camel-kvm-prep nftables camel-egress-proxy camelfsd; do
  [[ -v restart[$unit] ]] || continue
  systemctl enable "$unit.service"
  if [[ ${restart[$unit]} == 1 ]]; then
    echo "== Restart $unit"; systemctl restart "$unit.service"
  else
    echo "== Ensure $unit is started"; systemctl start "$unit.service"
  fi
done
summary
