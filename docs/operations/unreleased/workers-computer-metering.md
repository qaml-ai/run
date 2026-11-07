### Workers: native computer time is metered and charged at cost

The Workers backend's native computer (a `ContainerComputer` container) was unmetered. Its time is now recorded like
other platform-paid work: each container session, from its start until it is destroyed or idles out (its idle timeout
after the last use), is a usage record with `kind: "computer"`, model `cloudflare/<instance>` (for example
`cloudflare/standard-1`) and its seconds, with `platform: true`; a session in constant use is charged every 5 minutes. A
prepaid tenant is charged; an unbilled tenant sees it in `/v1/usage` only. Agent spend limits count it.

The price is Cloudflare Containers' own, passed through at cost as other platform costs are: the instance's provisioned
memory and disk for the session's time ($0.0000025 per GiB-second, $0.00000007 per GB-second), plus the CPU it used
($0.00002 per vCPU-second), read from the container's cgroup (`cpu.stat` `usage_usec`) after each operation and before
each stop. Time no reading covers (the stretch after the last operation of a container that idled out, or one that
crashed) is charged at the instance's provisioned vCPU, which is at most what Cloudflare bills; that is at most one idle
timeout per session. Measured CPU is capped at the provisioned vCPU over the measured time. An idle `standard-1` costs about $0.038 an hour, a fully busy one about $0.074.

Every computer operation is refused (402) once a prepaid tenant's credit is spent or an agent spend limit is reached.
Each session is charged once, through a durable receipt keyed by the session; a charge that fails is retried by the
computer's alarm, backing off to an hour. Deleting an agent charges its computer's time before forgetting it. End-user
credit (per-end-user allowances) is not applied to container time yet.
