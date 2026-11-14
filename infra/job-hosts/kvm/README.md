# Ubuntu nested-KVM job host

Builds an x86_64 Ubuntu 24.04 host for Firecracker on nested KVM, camelFS,
the egress proxy and the runtime's job host agent. Requires `/dev/kvm` and
an EC2 instance-store NVMe. No Nitro preparation or cloud resources are created.
The operator runs this on the host; it has not been exercised on a real host here.

Copy `kvm-host.conf.example` to `/etc/camel/kvm-host.conf`, owned by root, and
fill in the runtime and store. This file must use simple `KEY=value` assignments
compatible with both Bash and systemd EnvironmentFile (no expansions or shell commands).
Choose a `RUN_REF` containing `--kvm`, `--reflink always` and `--initrd none`
(currently `claude/jobhost-kvm`, pending merge). The runtime must allow this host's
instance role, or enable test attestation with the matching secret in a root-owned
0600 `/etc/camel/jobhost-test.env`. Setup never creates that secret.
Git access to qaml-ai/run must already work; setup does not obtain credentials.

From this directory:

```sh
sudo bash host-setup.sh
bash host-setup.sh --check
```

Each phase announces itself. Unchanged source, build inputs and installed files
are retained; running units are restarted only for changed files or binaries.
Stop jobs before changing host configuration or upgrading. Configuration changes
require the operator to restart the affected service; setup does not hash secrets.
The existing cloudflared unit is always left alone. A token file at
`/etc/cloudflared/camelfs.token` enables cloudflared installation and a new unit
only when no such unit already exists. Tunnel routing is configured separately.

The root disk retains source, binaries, configuration, API token, guest kernel
and the AL2023 ext4 base image. Instance-store data disappears on stop/start.
At boot `camel-kvm-prep` recreates XFS with reflinks, the directories and the base
image copy on `/nvme`. It refuses to format mounted devices, disks with children,
or any device not identified as EC2 instance store. Instance store with an old
label can be erased. `camelfsd cleanup --data /nvme/camelfs` replaces the path-scoped cleanup script; it releases dm/loop/nbd devices from mount state and clears `mounts/*` before the daemon starts.

The CI `guest-image` artifact contains a compressed ext4 image and its manifest.
An operator publishes the two files with
`camelfsd/scripts/publish-guest-image.sh <artifact-dir> <s3-prefix>` and sets
`GUEST_IMAGE_SHA256` in `guest-image.conf` to the manifest's `sha256`.
Set `GUEST_IMAGE_S3_PREFIX` in the host config if the artifact is outside
`CAMELFSD_STORE`. The instance role needs read access to the two objects.
Setup verifies the compressed and raw hashes before replacing the installed
base image. The guest uses the static Go agent. NodeSource 22 is for the host.

Ubuntu adaptations: NodeSource's node is linked at `/usr/local/bin/node`;
reused proxy dependencies are replaced by a systemd drop-in; rules copied from
the source checkout are included via `/etc/nftables.d/camel-host.nft` in
`/etc/nftables.conf`. UID 940 is required by those rules. Existing nftables rules
are preserved in the configuration (Ubuntu's default flush still applies on reload).
`rsync`, `openssl` and `xz-utils` are installed alongside the host packages.

`infra/job-hosts/image/` remains the AL2023/Nitro image path.
