### Workers: the native computer is a container its Durable Object drives

The Workers backend's native `computer` tool (and the managed `container` provider) now runs only on Cloudflare
Containers' `durable_object` scheduling policy: each `ContainerComputer` DO starts, execs into and stops its own
container through `ctx.container`, choosing the image (a named, digest-pinned entry of the Wrangler `images` map,
`COMPUTER_IMAGE`, default `workspace`) and the instance size (`COMPUTER_INSTANCE`, default `lite`) at each start. The
Sandbox SDK path is removed: `SandboxComputer`, `@cloudflare/sandbox` (its file API, R2 directory backups and
`DirectoryBackupGateway`), the `COMPUTER_SANDBOXES` and `COMPUTER_BACKUPS` bindings and the image's `sandbox-shim`.
Breaking for the experimental tool only: `provider` accepts just `"container"`; `"sandbox"` is refused as invalid
input. Files and parsing already ran as Node processes in the image; nothing else replaces the SDK.

Snapshots are native filesystem snapshots (`snapshotContainer`) kept as handles in the computer's DO storage, with the
image digest they came from and a 30-day expiry that each restore renews. A handle from another image version, or past
its expiry, is refused before anything starts. Any computer DO can start from another's handle, the base for forking a
computer. Deleting an agent now also stops its native computer and drops its snapshot handles. The pilot binds
`ContainerComputer` (`standard-1`); deploying it needs Docker to build `computers/Dockerfile`.
