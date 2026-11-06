### Workers: native computer time is metered and charged

The Workers backend's native computer (a `ContainerComputer` container) was unmetered. Its time is now recorded like
other platform-paid work: each container session, from its start until it is destroyed or idles out (60 s after its
last use), is a usage record with `kind: "computer"`, model `cloudflare/<instance>` (for example `cloudflare/standard-1`)
and its seconds, with `platform: true`; a session in constant use is charged every 5 minutes. A prepaid tenant is
charged; an unbilled tenant sees it in `/v1/usage` only. Agent spend limits count it. The price is Cloudflare
Containers' list rate for the instance's provisioned vCPU, memory and disk ($0.00002 per vCPU-second, $0.0000025 per
GiB-second, $0.00000007 per GB-second): `lite` is about $0.0073 an hour and `standard-1` about $0.074 an hour. CPU is
charged as provisioned because its actual use is not measurable here, so this is at most what Cloudflare bills; a
container that stops on its own (a crash) is billed until it would have idled out, at most 60 s more. Every computer
operation is refused (402) once a prepaid tenant's credit is spent or an agent spend limit is reached. Each session is
charged once, through a durable receipt keyed by the session; a charge that fails is retried by the computer's alarm,
backing off to an hour. Deleting an agent charges its computer's time before forgetting it. End-user credit
(per-end-user allowances) is not applied to container time yet.
