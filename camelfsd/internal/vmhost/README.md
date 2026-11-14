# Firecracker launcher

Run one Launcher per host with a dedicated, root-controlled work directory on
the reflink filesystem. Install the host's `camel-host.nft` base rules before
booting VMs. The launcher neither installs rules nor changes the host firewall.
The KVM host setup installs a matching Firecracker and jailer from the same
pinned release archive.

Reserve the UID and GID range 200000–200249 for this launcher. Each VM runs as
`UIDBase + slot` for both IDs and owns its tap. `UIDBase` defaults to 200000 and
is the setting for the future `--uid-base` host flag. K2a is a library.

The launcher runs the following command with stdin disconnected and stdout and
stderr appended to `<work>/logs/<id>.log`.

```sh
systemd-run --scope --slice=system.slice --unit=camel-vm-<id>.scope \
  --property=KillMode=control-group --property=TimeoutStopSec=3s -- \
  <jailer> --id <jailer-id> --exec-file <firecracker> --uid <uid> --gid <uid> \
  --chroot-base-dir <work>/jail/<id> --cgroup-version 2 \
  --parent-cgroup system.slice/camel-vm-<id>.scope -- \
  --no-api --config-file /config.json --level Warning
```

Systemd moves the process out of the daemon's cgroup before executing the
jailer. The jailer drops privileges and stays in the scope on cgroup v2.
It adds the Firecracker binary basename, jailer ID and `root` to the chroot
base directory. A job ID incompatible with the jailer's 64-character
alphanumeric and hyphen format uses its SHA-256 as the jailer ID. The two path
components `.` and `..` are escaped in jail directory names.

The root clone and vsock socket live directly in the chroot. The kernel and
optional initrd are read-only bind mounts and must be readable by the jail
UID. Repo block devices get a private device node with the same device number
and jail UID ownership. A regular repo file is bind-mounted read/write and
must already be writable by the jail UID. The base image is immutable for the
lifetime of the Launcher, which hashes it once.

The VM record in `<work>/vms/<id>.json` reserves the slot before launch. A new
Launcher sees the reservations and can stop a recorded VM by ID. Destroy
waits up to five seconds for the scope to stop, then removes the tap, policy,
jail and record. A failed cleanup retains the reservation for retry.
`Adopt` is a stub for K2c.

The pinned guest serves one vsock connection and reboots when that connection
closes. Keeping Firecracker in an independent scope makes it survive the
launcher's exit while another client holds the guest connection. A daemon
that owns the connection still causes the guest to shut down when it dies.
Re-adoption therefore also needs a guest lifecycle change.

## KVM lane

On the dedicated EC2 KVM test host with base rules provisioned, from
`camelfsd/` run as root.

```sh
CAMELFSD_KVM=1 GUEST_IMAGE=/nvme/camel/base.ext4 go test -tags=kvm ./internal/vmhost
```

`GUEST_KERNEL` defaults to `/var/lib/camel/guest/vmlinux`. Set `GUEST_INITRD`
if the kernel requires it and `CAMELFSD_KVM_WORK` if the guest image's
directory is unsuitable for work files. The work directory must support
reflinks. Tests do not install firewall rules. Proxy-dependent checks wait
for K2b.
