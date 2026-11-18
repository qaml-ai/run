# File API through a Firecracker workspace volume

The API and Bash share one writable ext4 mount in a guest. Each host reads immutable 256 KiB blocks from S3 on demand and caches verified content on local NVMe. The guest replaces a file by rename. The harness reads the result through Bash, freezes ext4, uploads changed blocks and their immutable map, conditionally advances the S3 ref, thaws the guest and returns success. A new owner first changes the ownership epoch with a conditional write. Any subsequent publish by the displaced owner using its previous ETag fails.

The [persistent workspace API](workspace/README.md) serves named workspaces, accepts binary file edits at caller-selected paths and executes Bash on the same disk.

## Native cold and warm timings

These runs used Firecracker 1.13.1 and KVM on an EC2 m8id.xlarge with local instance-store NVMe and an S3 bucket in us-west-2. The 128 MiB workspace held 2,001 small source files and an 8 MiB random payload. Every edit replaced an existing file with a new 33-byte value, including its newline. Each started through a private RPC to the guest over vsock and was verified by a second RPC that ran Bash. The launcher waited for an explicit durable acknowledgment. This measures the experimental storage and guest path, excluding a public API gateway and authentication.

| State on arrival | Edits | Median to durable acknowledgment | Observed range |
| --- | ---: | ---: | ---: |
| Sleeping VM, empty host block cache | 6 | 1,728 ms | 1,662–1,788 ms |
| Sleeping VM, populated host block cache | 6 | 1,317 ms | 1,243–1,372 ms |
| Running VM and populated cache | 24 | 161 ms | 117–409 ms |

We ran two independent sets of three pairs. Each pair started from an identical snapshot under a fresh ref. The empty-cache run fetched 13 blocks and was killed immediately after its first acknowledgment. The next run began with those blocks cached on NVMe, started a new guest, and made five edits before it was killed. The 24 warm timings are edits two through five across six guests. The two separate fault cases are excluded from the timing summary. Host OS page caches were allowed to remain warm.

On a running VM the median edit plus Bash readback took 4.2 ms, freeze took 8.7 ms, uploading the changed blocks and map took 103.3 ms, conditional ref publication took 37.4 ms and thaw took 2.9 ms. Per-phase medians need not add to the median request. Each 33-byte write uploaded 1–1.5 MiB of block bodies, plus the map and ref. Raw records include elapsed time, bytes and phases per edit. The sleeping cases also include owner claim, device attach, kernel boot and workspace mount. The API coordinator and its AWS client were already initialized.

## Failure and takeover

For each of the twelve measured owner sessions, the supervisor killed the owner, its Firecracker guest and its block backend immediately after the terminal acknowledgment. Two additional runs killed them during a subsequent edit after uploading its new immutable data but before publishing its ref. A second machine fetched each authoritative ref from S3, took ownership and attempted a publish with the displaced owner's ETag. All fourteen stale publishes returned HTTP 412, including the attempt immediately after takeover with the file revision still unchanged.

The second machine created an empty block cache for each recovered root, attached a fresh read-only NBD device, mounted ext4 and read the acknowledged bytes. It also independently rebuilt the entire image from hash-verified S3 objects, checked it with e2fsck and checked an untouched file. Both interrupted runs recovered their previous acknowledged values. These checks used a mounted filesystem on the second host. The native timing runs used a Firecracker guest on the writer.

## Abrupt loss of the owner host

A separate run placed the same writer, NBD server, local cache and nested Firecracker guest inside a disposable KVM Linux host on the EC2 test machine. Its virtual system disk was on NVMe. It published a cold edit and a subsequent warm edit to real S3. After the second acknowledgment an external supervisor sent SIGKILL to the outer VMM. The SSH session broke, the owner kernel and guest stopped together, and the private owner disk was removed before recovery. The independent reader took ownership from S3, mounted the recovered volume with an empty cache, read revision 2, passed e2fsck and rejected a stale publish with HTTP 412. It fetched 13 blocks (3.25 MiB) for the lazy mount and file read. Nested timing is excluded from the native results. [Power-cut receipt](results/power-writer.json) and [independent recovery](results/power-recovery.json).

## Scope

This prototype exercises ownership, guest/API visibility, conditional publication and durability. It uses a serial block backend, a single writable owner and a fixed trusted API target. Production would also need routing, request idempotency when the connection dies after publication, admission control for takeover, cache eviction and object collection. The control process examines all blocks dirtied since guest boot at each checkpoint. It freezes the whole workspace through S3 publication. Several simultaneous clients and sustained churn were outside this run.

## Reproduction

Use an isolated host with KVM, an unused kernel NBD device, local storage, a Firecracker-compatible kernel with ext4, initrd and vsock enabled, and test-only S3 access. The writer needs Python 3 with boto3, e2fsprogs, BusyBox with fsfreeze, cpio, Bash, socat, nbdkit with its Python plugin, nbd-client and Firecracker. Give each run a unique S3 prefix. A fresh prefix and local directory make accidental reuse fail immediately.

```sh
export TRIAL_BUCKET=your-benchmark-bucket
export TRIAL_PREFIX="unified-volume-trials/$(date -u +%Y%m%dT%H%M%SZ)"
export TRIAL_KERNEL=/path/to/vmlinux
export TRIAL_NBD=/dev/nbd15
export NBDKIT=$(command -v nbdkit)
export NBDKIT_PYTHON=/usr/lib/x86_64-linux-gnu/nbdkit/plugins/nbdkit-python-plugin.so
scratch=$(mktemp -d /nvme/api-trial-XXXXXXXX)
bash prepare.sh "$scratch"
export TRIAL_INITRD="$scratch/init.gz"
sudo --preserve-env=TRIAL_BUCKET,TRIAL_PREFIX,TRIAL_KERNEL,TRIAL_NBD,TRIAL_INITRD,NBDKIT,NBDKIT_PYTHON python3 run.py "$scratch/session"
```

On the recovery host use the same test bucket and prefix, an unused NBD device, local nbdkit and its Python plugin, and set NBD_CLIENT to the absolute nbd-client path. Copy only the JSON receipts to that host. Run `python3 recover.py writer.json recovery.json` as a user with test-prefix S3 access and passwordless sudo for the short-lived mount, attach and detach. Recovery claims each ref, advances its epoch and verifies the prior owner is fenced.

The two runs include [first-run receipts](results/writer.json), [first-run recovery](results/recovery.json), [repeat receipts](results/writer-repeat.json) and [repeat recovery](results/recovery-repeat.json).

For the power-cut variant, run the writer inside a disposable Linux VM with nested KVM, NBD, the same guest kernel and initrd, and credentials restricted to a separate experiment prefix. The harness ran on an Ubuntu 24.04 owner VM with two vCPUs and 1.5 GiB of RAM. From the outer machine, use `sudo python3 powercut.py outside <qemu-pidfile> <private-owner-disk> <report.json> ssh ...` with a remote command that invokes `python3 powercut.py inside <fresh-scratch-folder>` with the writer environment. The external process validates the private VMM and waits for the second acknowledgment before cutting power. Remove the private owner disk, transfer the JSON receipt, then run the same independent reader with the power-cut prefix.
