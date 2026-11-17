#!/usr/bin/env bash
set -euo pipefail
umask 077
run=${1:?usage: run-qualification.sh RUN_ID}
[[ $run =~ ^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}$ ]]
base=/nvme/camelfs-qualification/$run
cd "$base"
[[ $(cat run-id.txt) == "$run" ]]
sha256sum --check --status package.sha256
sha256sum --check --status binaries.sha256
assert_clear() {
  [[ $(systemctl show -p ActiveState --value camelfsd.service) == inactive ]]
  [[ -z $(systemctl list-units --state=active,activating --no-legend 'camel-vm-*.scope') ]]
  [[ -z $(ip -o link show | awk '$2 ~ /^cj[0-9]+:/ { print $2 }') ]]
  [[ -z $(find /nvme/camelfs/mounts -mindepth 1 -maxdepth 1 -print -quit) ]]
}
assert_clear
test -c /dev/kvm
test -c /dev/net/tun
[[ $(findmnt -n -o FSTYPE -T "$base") == xfs ]]
guest_sha=4223dffccd338a69feb48fe2b139ff271738f5d54e097e63a23e35d086366089
guest=/nvme/camelfs/images/$guest_sha.ext4
kernel=/var/lib/camel/guest/vmlinux
kernel_sha=b36a4a1b10f33b9cfdcde3d1a787d9c090556a3edb211cd06d1f3f9a6c7e8724
printf '%s  %s\n' "$guest_sha" "$guest" "$kernel_sha" "$kernel" | sha256sum --check --status
bucket=camel-fs-proto-904534089871-usw2
prefix=cold-bench/qualification/$run
[[ $(aws s3api list-objects-v2 --region us-west-2 --bucket "$bucket" --prefix "$prefix/" --max-keys 1 --no-paginate --query KeyCount --output text) == 0 ]]
mkdir -m 0700 logs-workspace work-prebuilt
cp revision.txt binaries.sha256 logs-workspace/
df -h "$base"
free -m
for round in 1 2; do
  assert_clear
  order=canonical-first
  [[ $round == 1 ]] || order=prebuilt-first
  log=logs-workspace/prebuilt-$round.log
  (
    unset CAMELFSD_KVM_CLEAN_IMAGE CAMELFSD_KVM_IMAGE_RANGES CAMELFSD_KVM_PACKED_APPLY CAMELFSD_KVM_PACKED_PARALLEL CAMELFSD_KVM_MEDIUM_BUNDLES CAMELFSD_KVM_CONTENT CAMELFSD_KVM_KEEP
    export CAMELFSD_KVM=1 CAMELFSD_KVM_PREBUILT=1 CAMELFSD_KVM_PREBUILT_ORDER="$order"
    export CAMELFSD_KVM_COLD_MB=50,500 CAMELFSD_KVM_OBJECTS_TABLE=camelfs-prod-objects
    export CAMELFSD_KVM_WORK="$base/work-prebuilt" CAMELFSD_KVM_STORE="s3://$bucket/$prefix/round-$round/"
    export GUEST_IMAGE="$guest" GUEST_KERNEL="$kernel"
    ./kvm-qualification -test.run '^TestKVMPrebuiltSessionQualification$' -test.v -test.count=1 -test.timeout=45m
  ) >"$log" 2>&1 || { tail -100 "$log"; exit 1; }
  grep -E 'PREBUILT_(FIXTURE|SESSION_METRIC|CORRUPTION_REJECTED)|compute_prebuilt_image' "$log"
  assert_clear
done
