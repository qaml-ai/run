### Job hosts: a build host keeps a pre-started sandbox

A build host (`r8gd`, one job at a time, charged as the whole host) now keeps one VM booted while it is idle. This is
its build sandbox, started before a job needs it. The host agent's `--prestart` turns it on; the image sets it for
the build pool.
- **A job that fits takes it:** a build job with no snapshot, whose shape fits the sandbox, takes the warm VM at once
  instead of waiting for a boot (the design's ≤ 7 s start on an idle host).
  - Its egress becomes the job's when it takes the VM. The warm VM boots with egress allowing nothing.
  - The next sandbox is started as soon as the host is idle again.
- **The shape:** a build job is sent the sandbox's shape: 16 vCPUs, 96 GiB, and a 64 GiB disk unless it asks for more.
  It already pays for the whole host.
- **A job that doesn't fit** gives the warm VM up and boots its own, so a build host still runs one sandbox at a
  time. Not fitting means a bigger disk, or starting from a snapshot.
- **Billing:** a warm VM's idle time is not charged to anyone; it is part of what the build pool's markup covers.
