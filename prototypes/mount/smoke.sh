#!/usr/bin/env bash
# smoke.sh <camelfs-binary> <empty work dir>: mount, read through the overlay, write, commit, fork. Needs sudo (FUSE
# passthrough and overlayfs).
set -euo pipefail
B=$1 W=$2
[ -n "$W" ] && [ -d "$W" ] && [ -z "$(ls -A "$W")" ] || { echo "work dir must exist and be empty"; exit 2; }
cd "$W"
S=http://127.0.0.1:9911
"$B" serve -dir blobd -addr 127.0.0.1:9911 -latency 5ms 2>/dev/null & SP=$!
trap 'kill $SP 2>/dev/null || true' EXIT
sleep 0.5
"$B" gen -files 200 -bytes 1048576 -out tree
mkdir -p tree/bin && ln -s ../pkg000/sub00/f00000.txt tree/bin/link
printf '#!/bin/sh\necho hi\n' > tree/bin/run && chmod +x tree/bin/run
"$B" import -server $S -name small tree
sudo "$B" mount -server $S -name small -cache "$W/cache" -lower "$W/lower" -upper "$W/up" -work "$W/work" -merged "$W/m" -stats "$W/stats.json" -ready "$W/ready" 2>mount.log & MP=$!
for _ in $(seq 50); do [ -f ready ] && break; sleep 0.1; done; cat ready; echo
ls -la m | head -4; ls -la m/bin; m/bin/run
cmp m/bin/link tree/pkg000/sub00/f00000.txt && echo LINK_OK
"$B" read -dir m -pct 100; "$B" lat -dir m -n 20
sudo tee m/newfile <<<new >/dev/null
sudo tee -a m/pkg000/sub00/f00001.txt <<<changed >/dev/null
sudo rm m/pkg000/sub00/f00002.txt
sudo rm -r m/pkg000/sub01
sudo kill -INT $MP; wait $MP || true
cat stats.json; echo; cat mount.log
sudo "$B" commit -server $S -base small -name small2 -upper "$W/up"
"$B" fork -server $S -base small2 -name fork1
curl -s $S/stats; echo
mountpoint -q m && echo STILL_MOUNTED || echo UNMOUNTED
