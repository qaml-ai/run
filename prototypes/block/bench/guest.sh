#!/usr/bin/env bash
# The guest side on a nested-KVM host: a Cloud Hypervisor guest with a disk attached as virtio-blk, running the
# per-op bench, a full tree read (cold / warm) and raw fio inside the guest.
#   sudo bash guest.sh prep                      seed image, guest ssh key, tap + NAT (once)
#   sudo bash guest.sh stack <base.img>          lazy stack on the host: import -> NBD -> dm-clone -> thin (/dev/mapper/vol0)
#   sudo bash guest.sh bench <label> <hostdev>   boot the guest with <hostdev> as /dev/vdc, measure, append to results
#   sudo bash guest.sh down                      stop the guest and the stack
set -euo pipefail
CH=/nvme/ch; B=${BENCH_DIR:-/nvme/bench}; STORE=${STORE:-s3://camel-fs-proto-904534089871-usw2/block}
BIN=$B/lazyblk; NBD=/dev/nbd1; M=$B/mnt; GIP=192.168.249.2; HIP=192.168.249.1
R="$B/results-guest.txt"
log() { printf '\n== %s\n' "$*"; }
rec() { echo "$*" | tee -a "$R"; }
ms() { echo $(( ($(date +%s%N) - $1) / 1000000 )); }
now() { date +%s%N; }
gssh() { ssh -q -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5 -i $CH/guest_key ubuntu@$GIP "$@"; }

case ${1:-} in
prep)
  cd $CH
  [ -f guest_key ] || ssh-keygen -q -t ed25519 -N "" -f guest_key
  cat > user-data <<EOF
#cloud-config
users:
  - name: ubuntu
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    ssh_authorized_keys:
      - $(cat guest_key.pub)
EOF
  printf 'instance-id: camel-proto\nlocal-hostname: guest\n' > meta-data
  cat > network-config <<EOF
version: 2
ethernets:
  eth0:
    match: { name: "e*" }
    addresses: [$GIP/24]
    gateway4: $HIP
    nameservers: { addresses: [8.8.8.8] }
EOF
  cloud-localds -N network-config seed.iso user-data meta-data
  ip link show tap0 >/dev/null 2>&1 || { ip tuntap add tap0 mode tap; ip addr add $HIP/24 dev tap0; ip link set tap0 up; }
  sysctl -q -w net.ipv4.ip_forward=1; iptables -t nat -C POSTROUTING -s 192.168.249.0/24 -j MASQUERADE 2>/dev/null || iptables -t nat -A POSTROUTING -s 192.168.249.0/24 -j MASQUERADE
  [ -f noble-base.raw ] || cp --reflink=auto noble.raw noble-base.raw
  echo prep-ok
  ;;
stack)
  IMG=$2
  ROOT=$($BIN import --from $IMG --store $STORE 2>$B/work/g-import.log); echo "root=$ROOT $(cat $B/work/g-import.log)"
  rm -rf $B/cache; mkdir -p $B/cache
  $BIN serve --root $ROOT --store $STORE --cache $B/cache --listen 127.0.0.1:10809 --stats 127.0.0.1:9100 2>$B/work/g-serve.log & sleep 0.5
  nbd-client -N x 127.0.0.1 10809 $NBD -C 4 >/dev/null
  SECT=$(blockdev --getsz $NBD)
  truncate -s $((SECT*512)) $B/work/clone-dest.img; dd if=/dev/zero of=$B/work/clone-meta.img bs=1M count=64 2>/dev/null
  CD=$(losetup -f --show $B/work/clone-dest.img); CM=$(losetup -f --show $B/work/clone-meta.img)
  dmsetup create clone0 --table "0 $SECT clone $CM $CD $NBD 512 1 no_hydration"
  truncate -s 20G $B/work/pool-data.img; dd if=/dev/zero of=$B/work/pool-meta.img bs=1M count=256 2>/dev/null
  LD=$(losetup -f --show $B/work/pool-data.img); LM=$(losetup -f --show $B/work/pool-meta.img)
  dmsetup create pool --table "0 $(blockdev --getsz $LD) thin-pool $LM $LD 512 0 1 skip_block_zeroing"
  dmsetup message /dev/mapper/pool 0 "create_thin 0"
  dmsetup create vol0 --table "0 $SECT thin /dev/mapper/pool 0 /dev/mapper/clone0"
  echo "stack-ok /dev/mapper/vol0 ($((SECT/2048)) MiB)"
  ;;
bench)
  LABEL=$2; DEV=$3
  cd $CH; rm -f /tmp/ch.sock; cp --reflink=always noble-base.raw noble-run.raw
  t0=$(now)
  ./cloud-hypervisor --api-socket /tmp/ch.sock --kernel /boot/vmlinuz-$(uname -r) --initramfs /boot/initrd.img-$(uname -r) --cmdline "console=ttyS0 root=/dev/vda1 rw" --cpus boot=4 --memory size=4G \
    --disk path=noble-run.raw,image_type=raw --disk path=seed.iso,readonly=on,image_type=raw --disk path=$DEV,image_type=raw \
    --net tap=tap0,mac=12:34:56:78:90:ab --serial file=/tmp/ch-serial.log --console off > /tmp/ch.log 2>&1 &
  CHPID=$!
  until gssh true 2>/dev/null; do sleep 0.5; [ -d /proc/$CHPID ] || { echo "guest died"; tail -5 /tmp/ch.log; exit 1; }; done
  rec "[$LABEL] guest_boot_to_ssh_ms=$(ms $t0) (Cloud Hypervisor $(./cloud-hypervisor --version | cut -d' ' -f2), direct boot of the host kernel $(uname -r), 4 vCPU, 4 GiB, nested KVM)"
  scp -q -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i guest_key $BIN ubuntu@$GIP:/tmp/lazyblk
  gssh 'sudo mkdir -p /mnt/v && sudo mount /dev/vdc /mnt/v && sudo chown ubuntu /mnt/v/. 2>/dev/null; ls /mnt/v | head -3' >/dev/null
  gssh "sudo sync; echo 3 | sudo tee /proc/sys/vm/drop_caches >/dev/null; t0=\$(date +%s%N); sudo cat /mnt/v/src/m0/d0/f0.ts >/dev/null; echo \$(( (\$(date +%s%N)-t0)/1000000 ))" | sed "s/^/[$LABEL] guest_first_file_cold_ms=/" | tee -a $R
  gssh "sudo sync; echo 3 | sudo tee /proc/sys/vm/drop_caches >/dev/null; t0=\$(date +%s%N); sudo tar cf - -C /mnt/v src | cat >/dev/null; echo \$(( (\$(date +%s%N)-t0)/1000000 ))" | sed "s/^/[$LABEL] guest_full_read_cold_ms=/" | tee -a $R
  gssh "t0=\$(date +%s%N); sudo tar cf - -C /mnt/v src | cat >/dev/null; echo \$(( (\$(date +%s%N)-t0)/1000000 ))" | sed "s/^/[$LABEL] guest_full_read_pagecache_ms=/" | tee -a $R
  gssh "sudo sync; echo 3 | sudo tee /proc/sys/vm/drop_caches >/dev/null; t0=\$(date +%s%N); sudo grep -r function /mnt/v/src | wc -l >/dev/null; echo \$(( (\$(date +%s%N)-t0)/1000000 ))" | sed "s/^/[$LABEL] guest_grep_r_cold_ms=/" | tee -a $R
  rec "[$LABEL] --- guest per-op (ext4 on /dev/vdc)"; gssh "sudo /tmp/lazyblk fsbench /mnt/v/gfsb 2000 2>/dev/null" | tee -a $R
  gssh "sudo umount /mnt/v"
  if gssh "command -v fio" >/dev/null 2>&1; then
    for qd in 1 16; do gssh "sudo fio --name=r --filename=/dev/vdc --rw=randread --bs=4k --iodepth=\$qd --direct=1 --runtime=5 --time_based --ioengine=libaio --size=1G --output-format=json 2>/dev/null | python3 -c 'import json,sys; j=json.load(sys.stdin)[\"jobs\"][0][\"read\"]; print(\"iops=%d clat_mean_us=%.1f p99_us=%.1f\" % (j[\"iops\"], j[\"clat_ns\"][\"mean\"]/1000, j[\"clat_ns\"][\"percentile\"][\"99.000000\"]/1000))'" | sed "s/^/[$LABEL] guest_fio_randread_4k_qd$qd: /" | tee -a $R; done
  else rec "[$LABEL] (no fio in the guest image; raw device numbers are the host's)"; fi
  gssh "sudo poweroff" >/dev/null 2>&1 || true; sleep 2; kill $CHPID 2>/dev/null || true; wait $CHPID 2>/dev/null || true
  ;;
down)
  pkill -f "^[.]/cloud-hypervisor" 2>/dev/null || true; sleep 1
  dmsetup remove vol0 2>/dev/null || true; dmsetup remove pool 2>/dev/null || true; dmsetup remove clone0 2>/dev/null || true
  nbd-client -d $NBD >/dev/null 2>&1 || true; pkill -x lazyblk 2>/dev/null || true; losetup -D 2>/dev/null || true
  echo down-ok
  ;;
*) echo "usage: guest.sh prep|stack <img>|bench <label> <dev>|down"; exit 2;;
esac
