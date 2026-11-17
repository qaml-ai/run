#!/bin/sh
export PATH=/bin
/bin/busybox --install -s /bin
mount -t devtmpfs dev /dev
mount -t proc proc /proc
mount -t sysfs sys /sys
fail() { echo "GUEST_FAILED" >/dev/console; poweroff -f; }
trap fail EXIT
set -eu
for module in $(cat /load); do insmod "/mods/$module"; done
mkdir -p /x /base /ws /scratch /tmp
mount -t 9p -o trans=virtio,version=9p2000.L,msize=524288 exchange /x
read mode action < /x/request
stamp() { cut -d' ' -f1 /proc/uptime > "/x/$1"; }
stamp start
if [ "$mode" = git ]; then
    mount -t tmpfs tmpfs /base
    tar xf /x/base.tar -C /base
elif [ "$mode" = block ]; then
    mount -t ext4 /dev/vda /ws
else
    mount -t ext4 -o ro,noload /dev/vda /base
fi
if [ "$mode" != block ]; then
    mount -t tmpfs tmpfs /scratch
    mkdir /scratch/u /scratch/w
    mount -t overlay overlay -o lowerdir=/base,upperdir=/scratch/u,workdir=/scratch/w /ws
    if [ -f /x/patch.tar ]; then tar xf /x/patch.tar -C /ws; fi
    if [ -f /x/deleted ]; then while IFS= read -r name; do rm "/ws/$name"; done < /x/deleted; fi
fi
cd /ws
if [ "$action" = api ]; then
    printf 'api edit\n' > src/hot
else
    if [ "$action" = recover ]; then test "$(cat src/hot)" = 'vm write'; else test "$(cat src/hot)" = 'api edit'; fi
    stamp first
    # Signal first verified read so the host can sample origin traffic before scanning.
    touch /x/reached
    while [ ! -f /x/proceed ]; do sleep 0.01; done
    stamp scanstart
    tcc -nostdinc -c src/compile.c -o /tmp/compile.o
    test -s /tmp/compile.o
    stamp buildend
    find data src -type f | sort | xargs sha256sum > /x/digests
    stamp scanend
    if [ "$action" = edit ]; then
        printf 'vm write\n' > src/hot
        mv src/remove src/moved
        ln -s moved src/link
        chmod +x src/moved
    fi
fi
if [ "$action" = recover ]; then
    test -x src/moved
    test "$(readlink src/link)" = moved
    test ! -e src/remove
fi
stamp checkpointstart
cd /
if [ "$mode" != block ] && [ "$action" = edit ]; then
    cd /scratch/u
    find . -type c > /x/whiteouts
    find . \( -type f -o -type l \) | tar cf /x/upper.tar -T -
    cd /
fi
sync
umount /ws
stamp checkpointend
echo PASS > /x/verdict
sync
trap - EXIT
poweroff -f
