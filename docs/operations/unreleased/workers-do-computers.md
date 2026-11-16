### Workers retires the legacy Cloudflare Containers provider

Workers removes the experimental `computer` tool and its agent operation API.
On deployments with camelFS compute enabled, agents use `bash` on a Firecracker
VM with the writable workspace branch. Customer-supplied computer connections
retain their shell and browser tools.

The pilot temporarily retains the `ContainerComputer` Durable Object so it can
stop existing containers, settle usage and release admission slots. See
`backends/workers/PILOT.md` for data export, the drain checks and the eventual
class migration.
