# Job host image

For Ubuntu 24.04 nested-KVM hosts, see `infra/job-hosts/kvm/`.

The AMI a job host boots (docs/design/job-hosts-plan.md, slices 1 and 6). It is Amazon Linux 2023 on arm64 (kernel 6.18), set up to run one Firecracker microVM per job in Nitro Sandboxes direct mode. There is one image per pool, `build` or `test`, because the memory pool reserved for sandboxes differs.

**No KVM.** The hosts don't use `/dev/kvm`, nested virtualization or `.metal` instances. Firecracker's Nitro Sandboxes mode (the `enclave` block of its config) runs a microVM through the Nitro Enclaves driver instead. Per Firecracker's [Nitro Sandboxes getting started](https://github.com/firecracker-microvm/firecracker/blob/main/docs/nitro-sandboxes/getting-started.md) ("Requirements"):
- It runs on the [instance types that support AWS Nitro Enclaves](https://docs.aws.amazon.com/enclaves/latest/user/nitro-enclave.html#nitro-enclave-reqs), x86_64 or Graviton, launched with Enclaves enabled.
- It does **not** run on bare-metal instances.
- It needs the AL2023 `kernel6.18` from `6.18.51-120.162.amzn2023`. `check-image.sh` checks for it.

See also the EC2 User Guide's [Nitro Sandboxes](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/amazon-ec2-nitro-sandboxes.html) page. The 2026-11-11 spike ran this on an `r8gd.4xlarge`.

Building the image launches a temporary instance in the camelRun account, so **only Miguel runs it**, after the go-ahead. Nothing here has been built yet.

## What is in it

| Piece | Where | From |
|---|---|---|
| Firecracker v1.18.0 (aarch64) | `/usr/local/bin/firecracker` | The release tarball, sha256-pinned in `versions.env` (both the tarball and the binary) |
| Guest kernel | `/var/lib/camel/guest/vmlinux` | The host's own kernel, as in the spike |
| Guest initrd | `/var/lib/camel/guest/initrd.img` | dracut with the virtio and vsock drivers; it switch_roots into `/dev/vda` |
| Base root image | `/var/lib/camel/images/base.ext4`, copied to the NVMe at boot | `provision/guest-rootfs.sh`. It contains: AL2023 userland, build tools, git, Python, Node 22, socat; `camel-guest` (`jobhost/guest.ts`); and `files/camel-init` as PID 1 |
| Host agent and egress proxy | `/opt/camel/jobhost`, `/opt/camel/shared` | This repository at `source_revision` |
| Base network rules | `/etc/nftables/camel-host.nft` | `files/camel-host.nft`, generated from `jobhost/network.ts` `baseRules()`; a test checks the two match |
| Boot preparation | `camel-host-prep.service` | Formats the instance-store NVMe as XFS `reflink=1`, mounts it at `/var/lib/camel/nvme`, copies the base image onto it, and writes `pcie_slots` |
| Egress proxy | `camel-egress-proxy.service` | Runs as `camel-proxy` (uid 940) |
| Host agent | `camel-jobhost.service` | `--firecracker --attestor aws`. `CAMELRUN_RUNTIME_URL` comes from `/etc/camelrun/job-host.env`, which the launch template's user data writes from SSM |
| Sandboxes' memory pool | the kernel command line | `nitro_enclaves.mempool=<NE_MEMPOOL_BUILD or NE_MEMPOOL_TEST>@0`, set with grubby |
| No SSH | `sshd` masked | Operators and Packer use SSM Session Manager |

`check-image.sh` runs as the build's last step, and can be rerun on any host from the image. It checks the pinned and recorded hashes, the Firecracker version, the base rules, the proxy's uid, the memory pool, the units, that sshd is off, and the base image's contents.

## A job's network (slice 6)

- **Taps and addresses:** each job slot has its own tap, `cj<slot>`, and its own /30. The host end is `10.200.<slot>.1` and the guest is `10.200.<slot>.2`. `camel-init` reads its address from the kernel command line.
- **Forwarding:** nothing is forwarded to or from a tap. The host accepts only the proxy's port, on the tap's own address, from that tap's own guest; a spoofed source is dropped. It opens no connection into a guest, since the agent talks to the guest over vsock.
- **The only way out:** a guest leaves only through the egress proxy (`jobhost/egress-proxy.ts`). The proxy is CONNECT to port 443 only, and only to the job's allowlist:
  - with `internet` off, the allowlist is empty;
  - with `internet` on, it is `DEFAULT_EGRESS` plus the runtime.
- **Resolved addresses:** the proxy resolves names with Amazon's DNS, refuses a name if any of its addresses is non-public, and dials the address it checked.
- **The proxy's own traffic:** its user's traffic is kept to public addresses on 443, plus Amazon's DNS, by the host's rules. So IMDS, the VPC and loopback stay unreachable even if the proxy is wrong.
- **IMDS:** the host's own IMDS stays reachable for the agent's attestation (IMDSv2 with a hop limit of 1). A guest cannot reach it.

`test-netns.sh` checks all of this for real with network namespaces, without a VM: `sudo infra/job-hosts/image/test-netns.sh`. With `NO_RULES=1` it runs without the rules, to show the checks fail without them. `jobhost/isolation-suite.ts` runs the same properties from inside real VMs, plus the pid cap and disk-full checks. Run it on a host built from this image.

## Building it (Miguel, after the go-ahead)

You need Packer 1.14 or later, AWS credentials for account 904534089871 in `us-west-2`, and the SSM Session Manager plugin. Packer builds with an `r8gd` instance in a private subnet. That subnet needs NAT, for packages and the Firecracker release, and SSM. The OpenTofu in `infra/job-hosts/terraform` creates the job hosts' subnets.

```sh
cd infra/job-hosts/image
packer init host.pkr.hcl
packer validate -var pool=build -var subnet_id=<subnet> -var source_revision=$(git rev-parse HEAD) host.pkr.hcl
packer build  -var pool=build -var subnet_id=<subnet> -var source_revision=$(git rev-parse HEAD) host.pkr.hcl
packer build  -var pool=test  -var subnet_id=<subnet> -var source_revision=$(git rev-parse HEAD) -var instance_type=c8gd.4xlarge host.pkr.hcl
```

Each build prints an AMI id. Those ids are the pools' `ami_id` settings in the OpenTofu. Each build runs one instance for about 15–20 minutes, plus a 30 GiB snapshot per AMI.

## What has and has not been verified

**Verified here, without AWS:**
- `packer validate` passes (Packer 1.14.3, amazon plugin 1.8.4).
- `nft -c` accepts the base rules.
- `test-netns.sh` passes all 16 network checks, and the control run without the rules fails the rule-dependent ones.
- The guest's cgroup pid cap stops a fork bomb when run as root.
- The scripts parse with `bash -n`.
- The Firecracker release and binary hashes match the release's own sha256 files.
- The unit tests in `tests/jobhost-host.test.ts` pass. They cover the launcher, the vsock channel, the proxy and the isolation suite against a scripted host.

**Not verified: these need a Graviton instance with Nitro Enclaves, which there is none of here (and no KVM):**
- The image build itself: the package names on AL2023, the source AMI filter for kernel 6.18, and dracut's options.
- Booting a VM: Firecracker with the host's EFI kernel and this initrd, `camel-init`, socat on vsock, and the guest on Node 22.
- `pcie_slots` and the mempool sizes (`NE_MEMPOOL_*` are estimates: 100G is the spike's build value, and the test value is a guess), and `resize2fs` growing a reflink clone.
- The isolation suite on a real host.
- Packer reaching the builder through Session Manager.
