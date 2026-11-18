# Package installation and TypeScript compilation on FUSE

We timed CamelRun's package installation and application compilation on an EC2 m8id.xlarge with local instance-store NVMe. Each trial created a fresh 4 GiB ext4 filesystem. Each install began with an empty node_modules and a populated npm tarball cache outside the mount. We ran npm ci with lifecycle scripts enabled, npm offline mode, and external networking disabled for the entire workload. The lockfile installed 766 packages, with 45,489 files in the primed dependency tree. TypeScript compiled src and its imports and emitted 319 files. The emitted paths and contents were hashed for every trial.

The first comparison rotated three modes over three repetitions on the same host. Plain FUSE used the repository's Go loopback mount with a one-second metadata cache. Passthrough used the same daemon and cache configuration with Linux handling file-body I/O through registered backing files. A separate probe on the same host and binary traced a successful backing-file registration. The workload ran as the unprivileged ubuntu user in every arm. Its source tree was freshly staged before measurement. Host OS caches could stay warm. The daemon and mounts were ready before npm started.

| Mode | npm ci | Compile | Local sync after npm ci |
| --- | ---: | ---: | ---: |
| Native ext4 | 7.50 s | 2.89 s | 3.27 s |
| Plain FUSE | 10.01 s | 3.29 s | 3.20 s |
| FUSE with kernel passthrough | 9.58 s | 3.12 s | 3.10 s |

These are per-phase medians. Plain FUSE added 34% and 14% to installation and compilation respectively. Passthrough added 28% and 8%. The sync phase flushed the backing ext4 filesystem to the local device before timing the compiler. The install and compile timings exclude fsync of the whole filesystem, publication to S3 and guest boot. This measures the cost of the mounted interface on local data. A network filesystem's server, cache, and consistency protocol will also affect results. [Raw measurements](results.json)

## Keep dependencies and output on ext4

In a second comparison we kept source on passthrough FUSE and bind-mounted the backing ext4 directories for node_modules and dist directly into that workspace. Each run still began without installed packages or compiled files. Across three repetitions per layout the split mount took **7.66 s for npm ci and 3.01 s to compile**, alongside 7.44 s and 2.86 s for its native ext4 controls. All fifteen trials produced identical compiler output. The directories in this test lived on the same local disk. Using per-host scratch directories in a distributed filesystem would require an explicit decision about which files survive host changes or can be regenerated. [Paired measurements](local-dirs.json)

## Whole workspace on JuiceFS with S3

On November 18 we ran one installation and compilation per filesystem inside Firecracker on the same EC2 m8id.xlarge. Each fresh guest used Linux 6.1.141 with four vCPUs and 5 GiB of memory. Both started with an empty node_modules, the same source and lockfile, and a populated local npm cache. Each ran `npm ci --offline --no-fund --no-audit` with lifecycle scripts enabled, followed by `node_modules/.bin/tsc -p bench.json`. Times are host-observed private RPC durations, including connection teardown. Guest boot and mount setup were outside the timings.

| Guest workspace | npm ci | Compile |
| --- | ---: | ---: |
| Native ext4 on an NVMe-backed virtual disk | 16.19 s | 4.16 s |
| JuiceFS CE 1.4.2 backed by S3 and Redis | 576.40 s | 9.73 s |

The second guest mounted its entire workspace through FUSE, including node_modules and dist, with an initially empty JuiceFS data cache. JuiceFS stored file contents in regional S3 and metadata in a private Redis on the benchmark host with an append-only log on EBS and `appendfsync always`. JuiceFS asynchronous object writeback was disabled. Guest communication with Redis and S3 used TCP relays over vsock, with TLS to S3. These timings include the metadata service, persistence policy, object store and relay overhead. At the end of the run its private S3 prefix contained 50,203 objects totaling 910,886,922 bytes. The single pair does not isolate the contribution of each layer.

Before boot the service wrote a marker through a separate JuiceFS mount. The guest read it, replaced it and synced the workspace. After compilation we killed the Firecracker guest, unmounted the service client and read the marker and all 319 emitted files through a fresh client with an empty data cache. Their paths and contents matched the native control and the earlier compiler runs. Redis remained running on the same host. Twelve individual 32-byte writes through the service mount with the VM stopped took 23.9–57.4 ms each through file fsync and close, excluding public API overhead. [Trial measurements](juicefs-firecracker.json)

## Reproduce

The trials used Linux 7.0.0-1017-aws, Node 22.23.5, npm 10.9.9, TypeScript 7.0.2 and go-fuse v2.12.1. From the repository root, use an empty scratch directory on the test host's NVMe drive. The prepare script builds the isolated daemon, stages the source tree and fills the external npm cache. The benchmark takes ownership of the scratch files and its private mount namespace. The two commands run sequentially.

```sh
trial_dir=$(sudo mktemp -d /nvme/developer-workload-XXXXXXXX)
sudo chown "$(id -u):$(id -g)" "$trial_dir"
bash prototypes/block/bench/developer-workload/prepare.sh "$trial_dir"
sudo unshare -m -n --propagation private python3 prototypes/block/bench/developer-workload/bench.py "$trial_dir"
sudo unshare -m -n --propagation private python3 prototypes/block/bench/developer-workload/bench.py "$trial_dir" --compare-local-dirs
```
