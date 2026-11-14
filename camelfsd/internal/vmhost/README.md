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
Use `Launcher.Adopt(id)` to recover a handle from the VM record, then
`VM.Reconnect(ctx)` to dial port 5000 and retrieve the guest's session inventory.
The guest serves one connection at a time and accepts another after EOF.
The Firecracker scope outlives the launcher. An explicit guest `exit` syncs
and shuts down the VM.

## Guest sessions

`VM.Request(ctx, req, onLog, onEvent)` takes an optional event callback for
`exec` or `exec_tail`. The request returns the acknowledgement. The callback
receives events for that exec ID in wire order, including after the request
returns. Use a fresh callback when reattaching. Callbacks must return
promptly and may hand messages to another goroutine.

`shell_open` starts a persistent Bash in `/repo` if it exists, with the VM's
boot environment. `exec` with a shell runs one command at a time in that
shell. The command inherits shell state, and explicit `env` entries are
exported in the shell. `stdin` is a JSON string passed as UTF-8 bytes. A shell
that exits or times out is removed from the session inventory. Without a
shell ID, `exec` uses a separate Bash process group.

Each shell command is evaluated in a wrapper with separate pipes for
stdout and stderr. The wrapper closes fd 3 during evaluation and writes
a fresh 128-bit random token followed by the exit status to fd 3 after
evaluation. The guest reads and checks the sentinel on the dedicated
status pipe. It never parses stdout or stderr for sentinels.

Output offsets count bytes across both streams. Resume with `exec_tail` at
the next offset after the last chunk received. The guest sends an
acknowledgement, then any truncation marker, retained bytes and exit. If
the exec is still running, subsequent live events follow the replay. The
most recent eight accepted IDs keep up to 1 MiB each, and the most recent
64 completions keep their exit records. Active IDs stay registered until
completion. Repeating an ID while it is registered reattaches at offset
zero if the command, shell, env and stdin match. Once both records have
aged out, `exec_tail` returns `exec_unknown`.

## KVM lane

On the dedicated EC2 KVM test host with base rules provisioned, from
`camelfsd/` run as root.

```sh
CAMELFSD_KVM=1 GUEST_IMAGE=/nvme/camel/session-base.ext4 go test -tags=kvm ./internal/vmhost
```

Use an image built with this guest. The reconnect test logs boot-to-exec,
exec round-trip, and the freeze and walk times for an unchanged 10,000-file
repo.

`GUEST_KERNEL` defaults to `/var/lib/camel/guest/vmlinux`. Set `GUEST_INITRD`
if the kernel requires it and `CAMELFSD_KVM_WORK` if the guest image's
directory is unsuitable for work files. The work directory must support
reflinks. Tests do not install firewall rules. Proxy-dependent checks wait
for K2b.
