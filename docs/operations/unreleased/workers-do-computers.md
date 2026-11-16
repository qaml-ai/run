### Workers retires the legacy Cloudflare Containers provider

Workers removes the experimental `computer` tool and its agent operation API.
On deployments with camelFS compute enabled, agents use `bash` on a Firecracker
VM with the writable workspace branch. Customer-supplied computer connections
retain their shell and browser tools.

The pilot removes the retired Durable Object after the drain and settlement
checks in `backends/workers/PILOT.md`. Historical usage and closed lease records
are retained.
