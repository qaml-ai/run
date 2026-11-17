#!/bin/sh
export PATH=/bin
/bin/busybox --install -s /bin
mount -t devtmpfs dev /dev
mount -t proc proc /proc
mount -t sysfs sys /sys
trap 'echo FAILED >/dev/console; poweroff -f' EXIT
set -eu
for mod in $(cat /load); do insmod "/mods/$mod"; done
mkdir -p /x /base /ws /scratch
mount -t 9p -o trans=virtio,version=9p2000.L exchange /x
stamp() { cut -d' ' -f1 /proc/uptime > "/x/$1"; }
stamp begin
mount -t erofs -o ro,device=/dev/vdb /dev/vda /base
mount -t tmpfs tmpfs /scratch
mkdir /scratch/u /scratch/w
mount -t overlay overlay -o lowerdir=/base,upperdir=/scratch/u,workdir=/scratch/w /ws
cd /ws
if [ "$(cat /x/action)" = fault ]; then
    if cat src/hot >/dev/null; then exit 1; fi
else
    test "$(cat src/hot)" = "$(cat /x/expected)"
    stamp first
    while [ ! -f /x/proceed ]; do sleep 0.01; done
    tcc -nostdinc -c src/compile.c -o /scratch/out.o
    stamp built
    find src data -type f | sort | xargs sha256sum > /x/sums
    stamp scanned
    if [ "$(cat /x/action)" = edit ]; then
        echo 'vm write' > src/hot
        mv src/remove src/moved
        chmod +x src/moved
        ln -s moved src/link
        cd /scratch/u
        find . -type c > /x/deleted
        find . \( -type f -o -type l \) -print0 | /bin/gnu-tar cf /x/upper.tar --null -T -
    elif [ "$(cat /x/action)" = recover ]; then
        test "$(readlink src/link)" = moved
        test -x src/moved
        test ! -e src/remove
    fi
fi
cd /
umount /ws
echo PASS > /x/verdict
sync
trap - EXIT
poweroff -f
