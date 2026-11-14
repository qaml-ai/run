# Job hosts

`kvm/` sets up a camelFS compute host: an Ubuntu 24.04 nested-KVM machine running `camelfsd host --compute` and the
egress proxy (see `kvm/README.md`).

The TypeScript job host agent, its AL2023/Nitro image (`image/`) and the never-applied job-host pool infrastructure
(`terraform/`, `scaler/`, `apply.sh`; no state and no resources exist in the account) were removed with the
TypeScript job host; hosts now enroll with the camelFS tier (`infra/camelfs`).
