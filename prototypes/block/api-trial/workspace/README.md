# Persistent ext4 workspaces

This is a runnable storage backend for trusted pilot experiments. Each named workspace starts at the same immutable, empty ext4 template. Creation writes a ref. A Firecracker start reads its block map and attaches a lazy NBD device. An empty host cache triggers on-demand reads of 256 KiB blocks. The only entry point that calls the formatter is `format-template`.

One private Unix HTTP endpoint serves file operations on each host. While the workspace sleeps, libext2fs reads and writes its blocks directly. A PUT creates missing parent directories and creates or replaces a regular file. The path is relative to the workspace. The editor refuses symlinks and writes to multiply linked files. A running VM owns the disk exclusively. A request received elsewhere is forwarded to the configured peer socket for the owner recorded in S3. An unreachable or displaced owner returns an error.

For a running edit or Bash command the host freezes ext4, seals the changed blocks and thaws the guest. The NBD backend gives a later write its own copy of any sealed block still uploading. The API acknowledges after uploading changed blocks and their map and conditionally advancing the S3 ref. A command response carries the shell's exit status and its output, including when a nonzero exit leaves filesystem changes. Sleeping the VM publishes a cleanly unmounted disk. An explicit recovery takes the exact former owner's epoch, starts a fresh VM to replay the committed ext4 journal, unmounts it and publishes a clean revision.

## Run

Start in `prototypes/block/api-trial`. Use the S3, KVM, NBD and nbdkit environment in the [Firecracker trial setup](../README.md#reproduction). Use an unused NBD device and an S3 test prefix. The offline API process needs Python, boto3 and libext2fs. The compute process also needs the prepared guest kernel and initrd. Both use the same bucket and prefix.

```sh
cc -Wall -Wextra -Werror -O2 -shared -fPIC offline/edit.c -lext2fs -o offline/edit.so
CGO_ENABLED=0 go build -o "$scratch/workspace-guest" workspace/guest.go
bash prepare.sh "$scratch" "$scratch/workspace-guest"
export TRIAL_INITRD="$scratch/init.gz"
python3 workspace/server.py format-template 128
sudo --preserve-env=TRIAL_BUCKET,TRIAL_PREFIX,TRIAL_KERNEL,TRIAL_NBD,TRIAL_INITRD,NBDKIT,NBDKIT_PYTHON \
  python3 workspace/server.py serve demo "$scratch/compute" --host compute
```

On the API host, set `TRIAL_BUCKET` and `TRIAL_PREFIX`, compile the same offline editor and provide a private socket connected to the compute endpoint (in qualification, an SSH Unix-socket forward). Start the service with a private local state directory.

```sh
python3 workspace/server.py serve demo "$scratch/api" --host api --peer "compute=$scratch/compute.sock"
```

Exercise a fresh named workspace across both endpoints with `python3 workspace/smoke.py "$scratch/api/api.sock" "$scratch/compute.sock"`. For individual requests use curl with `--unix-socket`.

| Operation | Request |
| --- | --- |
| Create workspace, inspect ref | `POST /create`, `GET /status` |
| Write or read raw bytes | `PUT /files/<encoded-path>`, `GET /files/<encoded-path>` |
| Boot or resume on a compute host | `POST /start` |
| Run Bash in /workspace | `POST /exec` with the script as the request body |
| Checkpoint and sleep | `POST /stop` |
| Recover after losing the owner | `POST /recover` on the replacement compute host with the former epoch as the body |

A failed S3 operation cannot acknowledge a write. A disconnected caller can have an unknown outcome after publication. The prototype has no durable request-deduplication record. It serves trusted private callers, uses an in-process native parser for offline edits, and buffers individual file and command responses in memory. The existing Git/ref API, placement, billing and tenant isolation still use the pilot's existing implementation. This prototype's authority is its own S3 ref. Connecting both mutable ref systems would require a single publication decision for disk and Git state.

## Verification

An API process on exe.dev created a nested file crossing a block boundary. A Firecracker guest on EC2 started with an empty cache, read those bytes, accepted a routed edit and produced output with Bash. The API read the output after sleep, truncated the original file, rewrote it and booted the workspace again. After a subsequent acknowledged live edit we killed the owner process with SIGKILL. Its Firecracker and NBD children exited. A fresh compute process with an empty cache on the same EC2 machine rejected a stale recovery epoch, recovered the current revision and read the acknowledged bytes. A stale S3 publication returned HTTP 412. The API and compute processes had failing formatter wrappers on PATH throughout. Neither wrapper ran. [Run receipts](results.json)

A single paired developer workload used the same four-vCPU, 4 GiB Firecracker guest, the same package cache and the same source tree. The native control ran first on a separate ext4 disk. Its build outputs stayed local. The persistent workspace returned success only after S3 publication.

| Operation | Native guest time | Persistent guest time | Persistent API time including durability | Changed block bytes uploaded |
| --- | ---: | ---: | ---: | ---: |
| Install 766 packages with offline npm ci | 15.609 s | 15.132 s | 49.663 s | 1,026,818,048 |
| Compile TypeScript, 319 output files | 3.551 s | 3.466 s | 4.197 s | 8,650,752 |

The combined output digest matched. During the install checkpoint the guest was frozen for 1.615 s, then resumed while the host finished publishing. The workspace endpoint processes requests serially, so other API requests still wait during that upload. A separate API-to-compute run measured 1.502 s from the start request to a mounted, empty-cache workspace and 0.420 s for a sleeping 262,161-byte file edit. These are individual observations.
