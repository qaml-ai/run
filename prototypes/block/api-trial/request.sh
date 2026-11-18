#!/bin/sh
set -eu
read -r command value
case "$command" in
    put)
        case "$value" in ''|*[!a-z0-9-]*) exit 1;; esac
        printf '%s\n' "$value" > /workspace/src/.edit
        mv /workspace/src/.edit /workspace/src/main.py
        ;;
    read) exec /bin/bash -c 'cat /workspace/src/main.py';;
    freeze) fsfreeze --freeze /workspace;;
    thaw) fsfreeze --unfreeze /workspace;;
    unmount) umount /workspace;;
    ping) ;;
    *) exit 1;;
esac
echo OK
