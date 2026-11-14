# Ubuntu nested-KVM compute host

Builds an x86_64 Ubuntu 24.04 host that runs camelFS session VMs for the tier: `camelfsd host --compute`
(Firecracker on nested KVM) and the egress proxy (`camelfsd egress`). Requires `/dev/kvm` and an EC2 instance-store
NVMe. No cloud resources are created. The first host's bring-up runbook covers enrollment and the success signals.

Copy `kvm-host.conf.example` to `/etc/camel/kvm-host.conf`, owned by root, and fill in the store and the tier
settings (enrollment URL, hosts endpoint, the tier CA object and its SHA-256, the images store). The file must use
simple `KEY=value` assignments compatible with both Bash and systemd EnvironmentFile (no expansions or commands).
Git access to qaml-ai/run must already work; setup does not obtain credentials.

From this directory:

```sh
sudo bash host-setup.sh
bash host-setup.sh --check
```

Each phase announces itself. Unchanged source, build inputs and installed files are retained; running units are
restarted only for changed files or binaries. Setup fetches the tier CA from `TIER_CA_S3` and refuses it unless its
SHA-256 equals `TIER_CA_SHA256`; the host trusts nothing else.

The root disk keeps the source, the camelfsd binary, the configuration and the guest kernel. Instance-store data
disappears on stop/start: at boot `camel-kvm-prep` recreates XFS with reflinks and the directories on `/nvme`. It
refuses to format mounted devices, disks with children, or any device not identified as EC2 instance store. Instance
store with an old label can be erased. `camelfsd cleanup --data /nvme/camelfs` releases dm/loop/nbd devices from mount
state and clears `mounts/*`.

Guest images are not installed by setup: the tier names one per boot (its allowed set) and the host fetches and
verifies `guest/<sha>.json` + `.ext4.zst` from `CAMELFSD_IMAGES_STORE` into its own cache.

`camel-egress-proxy.service` runs `camelfsd egress` as `camel-proxy` (UID 940). The base rules `files/camel-host.nft`
(generated from `camelfsd/internal/vmhost` `BaseRules`; a test checks they match) are included via
`/etc/nftables.d/camel-host.nft` in `/etc/nftables.conf`. Existing nftables rules are preserved in the configuration
(Ubuntu's default flush still applies on reload).
