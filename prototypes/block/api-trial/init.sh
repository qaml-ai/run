#!/bin/busybox sh
set -eu
export PATH=/bin
/bin/busybox --install -s /bin
mount -t devtmpfs devtmpfs /dev
mount -t proc proc /proc
mount -t sysfs sys /sys
mount -t ext4 -o noatime /dev/vda /workspace
exec /bin/socat VSOCK-LISTEN:5000,reuseaddr,fork EXEC:/bin/request
