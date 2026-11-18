#!/bin/bash
set -euo pipefail
out=$(realpath "$1")
here=$(dirname "$(realpath "$0")")
root=$out/initrd
mkdir -p "$root"/{bin,dev,sys,proc,workspace}
cp /bin/{busybox,bash} /usr/bin/socat "$root/bin/"
while read -r lib; do cp -L --parents "$lib" "$root"; done < <(
    ldd /bin/bash /usr/bin/socat | awk '{for(i=1;i<=NF;i++)if($i!~/:$/ && $i~/^\//) print $i}' | sort -u
)
if [[ $# -eq 2 ]]; then install -m755 "$2" "$root/bin/workspace-file"; fi
cp "$here/init.sh" "$root/init"
cp "$here/request.sh" "$root/bin/request"
chmod 755 "$root/init" "$root/bin/request"
(cd "$root" && find . | cpio --quiet -o -H newc | gzip -1) > "$out/init.gz"
