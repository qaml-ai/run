#!/usr/bin/env bash
# Sourced by ec2-unit7.sh; all devices must belong to that run.
ublk_table() {
 local file=$1 nbd=$2 dm=$3 loopdev ublkdev id ublk_pid
 loopdev=$(losetup --find --show --read-only --direct-io=on "$file")
 fio_pair loop "$loopdev"
 losetup -d "$loopdev"
 local src=$W/libublk
 if [[ ! -x /home/ubuntu/.cargo/bin/cargo ]] && ! runuser -u ubuntu -- sh -c 'command -v cargo' >/dev/null; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs -o "$W/rustup.sh"
  chown ubuntu "$W/rustup.sh"
  runuser -u ubuntu -- sh "$W/rustup.sh" -y --profile minimal
 fi
 git clone https://github.com/ublk-org/libublk-rs.git "$src"
 git -C "$src" rev-parse HEAD >> "$RESULT"
 chown -R ubuntu "$src"
 runuser -u ubuntu -- bash -lc "cd '$src' && export PATH=\"\$HOME/.cargo/bin:\$PATH\" && cargo build --release --features tokio --example loop"
 # Explicit unused ID avoids touching any other team's ublk devices.
 for ((id=128;id<4096;id++)); do [[ -e /sys/class/block/ublkb$id || -e /dev/ublkc$id ]] || break; done
 [[ $id -lt 4096 ]]
 "$src/target/release/examples/loop" add --foreground -n "$id" -f "$file" -q 1 -d 64 -a > "$W/ublk.log" 2>&1 &
 ublk_pid=$!
 ublkdev=/dev/ublkb$id
 # Cleanup owns exactly this pid and device, including failure paths.
 UBLK_PID=$ublk_pid UBLK_ID=$id UBLK_BIN=$src/target/release/examples/loop
 for ((i=0;i<100;i++)); do [[ -b $ublkdev ]] && break; sleep .1; done
 [[ -b $ublkdev ]]
 fio_pair ublk "$ublkdev"
 "$UBLK_BIN" del -n "$UBLK_ID"; wait "$UBLK_PID" || true
 UBLK_PID= UBLK_ID=
 fio_pair nbd "$nbd"
 fio_pair dm_clone "$dm"
 python3 - "$W" <<'PY'
import json,sys,pathlib
p=pathlib.Path(sys.argv[1])
def read(name,qd):
 r=json.loads((p/f'{name}-{qd}.json').read_text())['jobs'][0]['read']
 return r['iops'],r['lat_ns']['mean']
u1,n1=read('ublk',1),read('nbd',1)
u16,n16=read('ublk',16),read('nbd',16)
print(f'ublk QD1 mean={u1[1]/1000:.2f}us; NBD={n1[1]/1000:.2f}us; QD16 IOPS ublk={u16[0]:.0f} NBD={n16[0]:.0f}')
print('ublk warrants its own unit' if u1[1]<.6*n1[1] and u16[0]>2*n16[0] else 'NBD stays; ublk is v1 (L19)')
PY
}
fio_pair() {
 local name=$1 dev=$2 qd
 for qd in 1 16; do
  fio --name="$name" --filename="$dev" --bs=4k --iodepth="$qd" --direct=1 --rw=randread --runtime=5 --time_based=1 --ioengine=io_uring --readonly --output-format=json --output="$W/$name-$qd.json"
  python3 - "$name" "$qd" "$W/$name-$qd.json" <<'PY'
import json,sys
r=json.load(open(sys.argv[3]))['jobs'][0]
assert r['error']==0,r
r=r['read']
print(f"{sys.argv[1]} QD{sys.argv[2]} IOPS={r['iops']:.0f} mean_us={r['lat_ns']['mean']/1000:.2f} p99_us={r['clat_ns']['percentile']['99.000000']/1000:.2f}")
PY
 done
}
