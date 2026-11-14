# camelFS service: AWS infrastructure

Option C of the camelFS design (Miguel, 2026-11-13; `docs/design/camel-fs.md` §1.6, §1.10, §1.13, §5 phase 1):
camelFS as **one AWS service in `us-west-2`**. A stateless Go tier, `camelfsd api` (the §9 storage plane plus a
refs package, and the compute control plane of `camel-fs-compute.md` §3), behind a load balancer; **refs, leases
and fences as DynamoDB conditional writes**; **trees and commits in DynamoDB** (L74); **blobs and chunks in S3**;
the VM hosts run `camelfsd host` and reach the tier in-VPC. This directory is that service as OpenTofu in `terraform/`, applied only through the guarded `apply.sh`.
Account `904534089871`, `us-west-2`. **Nothing here has been applied.**

It is its own root module with its own state: key **`agent-runtime/camelfs/terraform.tfstate`** in the existing
state bucket `camelai-terraform-state-904534089871` (the runtime's is `agent-runtime/terraform.tfstate`, the
pools' `agent-runtime/job-hosts/terraform.tfstate`; this key has never been used), so its plans never mix with
theirs. It reads the default VPC and its subnets, Cloudflare's published address ranges (plain HTTPS, no token),
the account's GitHub OIDC provider and the us-west-2 alerts topic; it changes nothing of theirs. **Every plan
is creates only**: `apply.sh` refuses any in-place update or deletion it is not told to expect. DNS is not in
Terraform: the two hostnames and the certificate's validation records are made in Cloudflare by hand from the
outputs.

## What it creates

| File | Resources |
|---|---|
| `bucket.tf` | S3 bucket **`camelfs-prod-904534089871`**: SSE-KMS with its own key (rotation on, S3 bucket keys), public access blocked, owner-enforced, versioned with 35-day noncurrent expiry, incomplete uploads aborted after 2 days, TLS-only, **daily Inventory** (Parquet) into `inventory/` kept 30 days. No expiry of live objects: deletion is the collector's. Keys exactly as `camelfsd` writes them today, `<lineage>/{o,t,k,r,c,ts}/<hash>`, plus `guest/<sha256>…` (the guest image, K1, put by CI) and `results/<lineage>/<vm>` (VM results, up to tens of MiB, K4, put by the host that ran the VM, expired after 7 days by prefix) |
| `dynamodb.tf` | Eight on-demand tables with PITR and deletion protection: **`camelfs-prod-objects`** (`lineage` + `id`), **`camelfs-prod-refs`** (`lineage` + `name`), **`camelfs-prod-lineages`** (`lineage`), **`camelfs-prod-deliveries`** (`shard` + `id`), **`camelfs-prod-hosts`** (`pool` + `host`), **`camelfs-prod-vms`** (`id`), **`camelfs-prod-usage`** (`shard` + `ulid`; the one table with a TTL, `expiresAt`), **`camelfs-prod-marks`** (`lineage`). No GSI/LSI (see "Key schemas") |
| `alb.tf` | One ACM certificate for `fs.camelai.dev` + `fs-internal.camelai.dev` (DNS-validated; the records are output for Cloudflare). Two application load balancers, both **HTTP/2 off**, HTTPS only (TLS 1.3/1.2 policy), deletion protection: **public** (Cloudflare's IPv4 ranges only; `fs.camelai.dev` proxied; mTLS **verify** against the AOP CA once `aop_ca_version` is set) and **internal** (the hosts' security groups only; `fs-internal.camelai.dev` DNS-only to its private addresses; serves **only the enrollment listener**, 8443). The api target group (`/v0/health`, 5 s interval, 2 up / 3 down) is the public balancer's; the listeners exist once `certificate_issued` is set. Per host security group: 8443 to the internal ALB, `hosts_port` (8794) to the hosts NLB, and the api tasks → `host_compute_port` (8792, `--listen-compute`) |
| `mtls.tf` | §9.12. The trust bucket `camelfs-prod-trust-<account>` (public CA PEMs, versioned). The offline **AOP CA**'s secret `camelfs/prod/aop-ca` (filled by `aop.sh init`) and, once `aop_ca_version` pins its PEM, the public listener's trust store. The **hosts' CA**: AWS Private CA, root, EC P-256, **short-lived mode** (leaves ≤ 7 days, no CRL/OCSP), self-signed for 10 years and activated by Terraform. **Host routes**: an internal **NLB in TCP passthrough** (`camelfs-prod-hosts`, port 8794, its own security group: hosts in, api tasks out) to the tier's `--listen-hosts` port, where the tier terminates mutual TLS itself. The **enrollment** path: a plain-TLS listener on the internal balancer (8443) whose only rule forwards `POST /v1/hosts/enroll` to a separate target group on container port 8793 (everything else 404), with the security-group rules both sides. A rule on the public listener: `/v1/hosts/*` → 404 |
| `ecs.tf` | ECR repository `camelfs-prod` (immutable tags, newest 20 kept), cluster `camelfs-prod` (Container Insights), the api tasks' security group, the Fargate task definition (ARM64, 1 vCPU / 2 GiB, read-only root, an ephemeral `/var/lib/camelfs` for the SQLite caches and temp files, `CAMELFS_JWKS` and `CAMELFS_SERVICE_SIGNING_KEY` injected from Secrets Manager), and, with `certificate_issued`, the service `camelfs-prod-api` on both target groups (circuit breaker + alarm rollback) at **`api_min_count` tasks, 0 by default**; CPU target-tracking autoscaling (`api_min_count`–8) once the minimum is above 0 |
| `iam.tf` | **api** task role (every table, `Scan` on `marks` alone; the bucket read/write, never delete; the hosts' CA as registration authority: `IssueCertificate` restricted to the `EndEntityCertificate/V1` template, `GetCertificate`, `GetCertificateAuthorityCertificate`, `DescribeCertificateAuthority`; ECS Exec; no secret) and execution role (image, logs, the one JWKS secret it injects). **host** policy `camelfs-prod-host` (the bucket read/write, the `objects` table only; explicit deny on the seven other tables and on `sts:AssumeRole*`; no secret, no CA; it puts its VMs' results under `results/<lineage>/<vm>` and may read none: `results/` is write-only for hosts), attachable to the job-hosts pool roles, plus a role and instance profile of the same name for hosts outside those pools (trusts `ec2.amazonaws.com` only, guarded like the job-hosts roles). **publisher** role `camelfs-prod-guest-image-publisher` for GitHub Actions (OIDC, the repository's `production` environment): `s3:PutObject` under `guest/` and nothing else |
| `secrets.tf` | Secrets Manager containers `camelfs/prod/token-verify-keys` (the runtime's public JWKS, Ed25519: what the tier verifies runtime tokens with; `jwks.sh`) and `camelfs/prod/notify-key` (the §9.11 webhook HMAC key both sides hold; `notify-key.sh`). The `service-signing-key` / `service-verify-keys` pair of the retired `camelfs-host+jwt` family is deleted (§9.12). Values never by Terraform |
| `alarms.tf` | To `camelai-agent-runtime-alerts` (us-west-2): per balancer, unhealthy targets (3 min), ALB 5xx (>10/5 min), target 5xx (>25/5 min), target p99 latency (>1 s for 3 of 5 min); per table, read and write throttles and system errors; running tasks below the minimum (once the service exists); unhealthy targets on the hosts NLB and the enrollment group. 35 alarms |
| `outputs.tf` | URLs, bucket, key, tables, role and policy ARNs, repository, the secret, the guest-image location, and the api command |

### Key schemas (the whole contract this module imposes on the daemon)

| table | partition key | sort key | the item (the daemon's; listed for orientation) |
|---|---|---|---|
| `objects` | `lineage` (S) | `id` (S) = `t/<sha1>` or `k/<sha1>` | `b` (git bytes), `generation`, `createdAt`. Not wired yet: trees and commits are in S3 until L74 |
| `refs` | `lineage` (S) | `name` (S) | `version`, `tree`, `root?`, `owner`, `expiresAt?`, `holder`, `leaseEpoch`, `leaseDeadline`, `updatedAt`. The tier checks the move rules first (camel-fs-files.md §6: a new commit's `parents[0]` is the current version; a move to a recorded commit is a fast-forward, `is-ancestor` at any depth), then the write is one conditional `UpdateItem` on `version = :expect` plus the lease state the writer believes in |
| `lineages` | `lineage` (S) | — | tenant, kind, default branch, ignore list; the mark (option B, #973): `markedBytes`, `markedAt`, `writtenSince` |
| `deliveries` | `shard` (S) = `"0"`..`"15"` | `id` (S) | the outbox: a watched ref's move, `vm.*` and `usage.*` events, written in the same `TransactWriteItems` as the state change (camel-fs-files.md §6, §9.11; camel-fs-compute.md); claimers `Query` each shard and claim with a conditional `claimedUntil`. A lineage key would leave pending work unfindable without an index; the shard can still be derived from the lineage |
| `hosts` | `pool` (S) | `host` (S) | `bootEpoch`, `shape`, `slots`, `free`, `vms`, `features`, `lastSeenAt`, `draining` (K4; heartbeats are `UpdateItem`s, placement a `TransactWrite` with the `vms` item) |
| `vms` | `id` (S) | — | the phase row: `phase`, `host`, `lineage`, `ref`, `leaseEpoch`, timestamps, result fields, `payer` (K4; results go to S3 `results/<lineage>/<vm>`, put by the host) |
| `marks` | `lineage` (S) | — | one pending recount per lineage (C3b, quota B): a conditional `PutItem` by the tier when a write is refused for quota or usage crosses 90 %; the GC mark pass scans, consumes and deletes it |
| `usage` | `shard` (S) = `"0"`..`"15"` | `ulid` (S) | usage events the runtime **pulls** (Miguel, 11-13 ~18:50; not webhooked): `eventId`, `vm`, `seq`, `body`, `expiresAt` (N, unix seconds); written in the same `TransactWriteItems` as `vms`. The one table with a DynamoDB TTL (`expiresAt`, 35 days): rows are copies the runtime has already pulled into Postgres, not authority |

The lineage is the partition key of every fs table (tenancy in the data, §1.10; adaptive capacity splits a hot
lineage's item collection because there is no LSI). No DynamoDB TTL: a ref's `expiresAt` and a delivery's claim
are the service's to act on; a TTL delete would move a ref without a CAS and without a log. Agreed with
proto-block (objects, refs, lineages), fs-architect and wf-durable (deliveries, hosts, vms) on 2026-11-13; the
attribute names are the only thing to keep in step with `camelfsd`. The `hosts`/`vms`/`usage` tables of K4 are
created now so the tier's role covers them; nothing writes them until K4 lands.

### The api task's command

Composed by `ecs.tf` from what the daemon on the deployed image accepts (Go's flag package exits on an unknown
flag, so a flag set is switched on in the same apply as the deploy that carries it):
`camelfsd api --listen 0.0.0.0:8790 --data /var/lib/camelfs --store s3://camelfs-prod-904534089871 --region us-west-2 --token-issuer <token_issuer>`
is C1's command and the default; `api_features=["refs"]` adds `--refs-table camelfs-prod-refs --lineages-table camelfs-prod-lineages --marks-table camelfs-prod-marks` (C2/C3a/C3b);
`api_features=["refs","compute"]` adds K4c's set (wf-durable, 11-14): `--vms-table --hosts-table --deliveries-table --usage-table` (the compute tables), `--pools build,test` and `--enroll-roles build=<arn>,test=<arn>` (the job-hosts pools and the instance roles their hosts attest with; `pools`, `enroll_roles`), `--listen-hosts 0.0.0.0:8794 --hosts-ca <Private CA ARN>` (the host routes behind the NLB with mutual TLS terminated by the tier, the CA it issues host certificates and its own from; the tier's key stays in memory, so no file flags in production), `--listen-enroll 0.0.0.0:8793 --enroll-audience camelfs:enroll` (the enrollment-only port behind the plain-TLS listener), `--runtime-notify-url <token_issuer>/v1/internal/camelfs/notify` (§9.11; its HMAC key is injected as `CAMELFS_NOTIFY_KEY` from `camelfs/prod/notify-key`, `notify-key.sh`); `api_extra_args` appends anything else (`--objects-table` / `--lineages-table` with
L74, `--token-max-ttl`). Keys are not flags: ECS injects `token-verify-keys` as `CAMELFS_JWKS` (the daemon also takes
`--jwks-file`; exactly one of the two) at task start, so no key material is in the task definition and the task role
reads no secret. `token_issuer` is the runtime's `AGENT_PUBLIC_URL` (the JWT `iss` the tier checks); it must equal
`infra/job-hosts`' `runtime_public_url`. The daemon writes only under `--data` (`storage.db`, `tmp/`); the image
carries `git` for `git merge-file`. The enrollment and hosts target groups exist whatever `api_features` says
(their health checks probe `/v0/health` on 8790); until "compute" is on, nothing listens behind them, and no host
is wired.

## Decisions, with reasons

**A new bucket, not the prototype's.** `camel-fs-proto-904534089871-usw2` was made by hand on 11-12 for the
prototype: SSE-S3, unversioned, no lifecycle, measurement runs under arbitrary prefixes (`camelfsd/u10-<ts>`,
`keep/proto-block/`), and written by the proto host's role, which must not hold production data. It is slated for
deletion with the prototype (memory `reference_camel_fs_proto_ec2`). Nothing in it is needed: every lineage starts
from a commit the runtime makes. Reusing it would mean importing a hand-made bucket into state, retrofitting KMS,
versioning and Inventory onto live prototype data, and giving the proto role production write. The new bucket is
`camelfs-<env>-<account id>`: the design's `camelfs-prod` name is not globally unique, and a name collision on
Miguel's first apply would cost a rename across the module.

**ECS Fargate (Graviton), not an ASG.** The tier is a stateless Go process: no NVMe, no KVM, no host-level
anything. An ASG would add an AMI to bake and rebuild on every CVE, a host to patch, an enrollment path and a
drain hook, for a service whose entire state is an in-process LRU. The runtime already runs this shape on Fargate
(`infra/terraform/ecs.tf`) with a rolling deploy, a circuit breaker and alarm-driven rollback, and this module
copies it, so there is one way to run a service in this account. Cost is a wash at this size: 2 × (1 vCPU / 2 GiB,
ARM, $0.0395/h) ≈ **$58/month** against 2 × `c8g.large` ($0.0798/h) ≈ $117/month, or 2 × (2 vCPU / 4 GiB) ≈ $116/month
if the LRU wants the memory; Fargate scales by one task where an ASG scales by one instance. What Fargate gives
up: a bigger LRU per node (Fargate tops out at 16 vCPU / 120 GiB per task, more than enough), and ~$0.01/h more
per vCPU than EC2 at the same size. Switch to an ASG when the tier wants NVMe for a chunk cache (phase 3's search
or the edge git server); nothing in the rest of the module changes.

**Two load balancers.** The runtime reaches the tier through Cloudflare (as it reaches camelRun: the public ALB
admits only Cloudflare's ranges, the hostname is proxied), so "only runtime traffic" holds at the network layer and
tokens hold at the application layer. The hosts reach the tier **in-VPC** through an internal balancer that admits
only their security groups: the C view's `vpc` leg (≈ 2 ms) is only true if a host's `cas` never leaves the VPC,
and an internet-facing balancer cannot be reached by security-group reference from inside the VPC (traffic to its
public addresses leaves through the internet gateway). A target group belongs to one balancer, so there are two
and the service registers with both. The second balancer is ≈ $16/month. Both run **HTTP/1.1 only**
(`enable_http2 = false`, with a postcondition): on 2026-10-24 Cloudflare multiplexed requests on one h2 connection
to the runtime's ALB and a cancelled response stalled every stream on it (qaml-ai/run#415).

**Hosts write `objects`, not `refs`.** Under C a checkpoint publishes blobs, chunks and roots to S3 and its trees
and commit to DynamoDB from the host, then asks the tier to `cas` with its fence; so the host policy covers the
bucket (no delete) and the `objects` table, and explicitly denies `refs` and `lineages`: a host can never move a
ref except through the tier's fence check. If proto-block routes trees and commits through the tier instead, the
`ObjectsTable` statement goes and the host policy is S3 only.

**Runtime → tier: tokens; everything machine-to-machine: mutual TLS (§9.12).** Runtime → tier tokens are
EdDSA/Ed25519 JWTs (`typ` `camelfs+jwt`, `aud` `camelrun:camelfs`) signed by the runtime's `RuntimeSigner`
(`backends/workers/src/runtime-identity.ts`): the private keys stay sealed in the runtime's Postgres
`signing_keys` and the public JWKS is published at `<runtime>/.well-known/jwks.json`. The tier verifies against a
copy of that JWKS (`jwks.sh set` stores it in `token-verify-keys`; ECS injects it as `CAMELFS_JWKS`) and never
calls the network for keys; a rotation is the runtime's (publish the new key beside the old) followed by
`jwks.sh set`, which rolls the service. **Rotation runbook:** the runtime publishes the new key beside the old
one at `/.well-known/jwks.json`; run `jwks.sh set` THEN (it copies both, and rolls the tasks); only after every
task runs the new set may the runtime drop the old key. A `jwks.sh set` run before the runtime publishes the new
key, or a key dropped before the copy, rejects every token signed with the key the tier does not have. Tier ↔ host calls carry no token: the connection's certificate is the
machine's identity (Miguel, 11-13: "probably safer and simpler"), which retired the `camelfs-host+jwt` family and
its two secrets.

**Cloudflare → public ALB: Authenticated Origin Pulls from our own CA.** Cloudflare's default origin-pull
certificate is shared by every customer, so an ALB trusting it proves only "came through Cloudflare". `aop.sh
init` makes a small offline CA (RSA 4096, 10 years; key in `camelfs/prod/aop-ca`, nothing in AWS reads it) and
uploads its public PEM to the trust bucket; `apply.sh aop_ca_version=<VersionId>` creates the trust store and
puts the public listener in **verify** mode (the handshake fails before any HTTP without a leaf from that CA);
`aop.sh issue` signs the yearly leaf and uploads it to Cloudflare. The Cloudflare-ranges security group stays as
the second lock. **Per-hostname, not zone-level** (Miguel and the lead, 11-13): `aop.sh issue` uploads the leaf with
`origin_tls_client_auth/hostnames/certificates` and enables it with `origin_tls_client_auth/hostnames` for
`fs.camelai.dev` alone, so the other hostnames in `camelai.dev` (`agents.camelai.dev`, `run-pilot`, …) keep
whatever Cloudflare presents to them today. `--zone` remains as a guarded exception (refused while the zone
already holds a custom certificate unless `--replace` is given), and `status` shows what is live. `aop.sh test`
proves enforcement: the listener's mode read back from AWS, a 200 through Cloudflare, and a refusal straight at
the ALB without the certificate.

**Tier ↔ host: AWS Private CA in short-lived mode, the tier as registration authority.** The CA key lives in
AWS's HSM; a compromised tier can issue only while compromised and loses that when its role is cut, where a
self-run CA's key could be copied (§9.12's table). Short-lived mode caps leaves at 7 days (the tier asks for 24 h
and renews every 8 h), issues no CRL and no OCSP: revocation is expiry plus removing the host from `hosts`. Only
the api role may `IssueCertificate`, and only with the `EndEntityCertificate/V1` (hosts: client + server auth) and
`EndEntityClientAuthCertificate/V1` (the tier's own) templates; IAM cannot constrain a subject, so *which* host id a
certificate carries (`spiffe://camelfs/host/<id>`, URI SAN) is the tier's enrollment check. **No ALB terminates
host mTLS and no header is trusted** (the lead's K4c2 review, 11-14: AWS does not guarantee that an ALB in
verify mode strips client-supplied `X-Amzn-Mtls-*` headers). Host → tier calls (`/v1/hosts/*`) go through an
internal NLB in TCP passthrough to the tier's `--listen-hosts` port, where the tier terminates mutual TLS itself
and reads the host id from the client certificate's SAN. The tier's own certificate (`spiffe://camelfs/tier`,
server + client EKU, hence the single `EndEntityCertificate/V1` template) is what it serves there and presents on
`--listen-compute`; hosts verify it by SAN against the CA certificate the enroll/renew reply carries
(`{certificatePem, chainPem, caPem, notAfter}`; proto-block: over server-authenticated TLS, no extra IAM, and a
CA rotation reaches every host with its next renewal). Hosts dial the NLB's DNS name (`output hosts_endpoint`),
not a public hostname, on that path.

**Enrollment on its own port.** A new host has no certificate, so it presents its STS attestation once on the
internal balancer's **8443** listener (plain TLS, no client certificate), whose only rule forwards
`POST /v1/hosts/enroll` to container port **8793** (`--listen-enroll`); any other path is a 404 at the balancer.
Three container ports: 8790 (runtime tokens, behind the public ALB), 8793 (enrollment only, behind the internal
ALB's plain-TLS listener), 8794 (host routes, mutual TLS terminated by the tier, behind the NLB). A rule on the
public listener answers 404 to every `/v1/hosts/*` before the tier sees it, and the tier serves host routes on
8794 alone, so a host route is reachable only through the NLB (two locks, wf-durable). Renewal is the same call over the
host's current certificate on 443.

## Network and security

- The api tasks sit in the default subnets with public addresses (no NAT, no endpoints, as the runtime's tasks do;
  in-region S3 and DynamoDB transfer is free). Their security group admits the API port from the two balancers'
  groups and nothing else; egress is 443 only (S3, DynamoDB, Secrets Manager, ECR, logs).
- The public balancer admits 443 from Cloudflare's IPv4 ranges (read at each plan; a range Cloudflare adds shows up
  as a rule to add). No port 80: nothing but machines call this service. The internal balancer admits 443 from
  `host_security_group_ids` only; with none named it admits nothing.
- `fs-internal.camelai.dev` is a DNS-only CNAME to the internal balancer's name, which resolves to private
  addresses: it is reachable from the VPC alone, and the certificate's name matches for hosts.
- No principal here may delete an object: the collector (camel-fs.md §1.9) gets a role of its own in a later phase.
- The tier reaches each host security group on `host_compute_port` only (the boot/stop listener); the hosts'
  own egress rules (job-hosts: 443 out only) are theirs to widen, to 8443 (enrollment) and 8794 (the NLB).
- The internal ALB's security group admits hosts on 8443 only and reaches the tasks on 8793 only; the NLB's admits
  hosts on 8794 only and reaches the tasks on 8794 only; the tasks admit 8790 from the public ALB, 8793 from the
  internal ALB, 8794 from the NLB.
- The guest-image publisher (GitHub Actions through the account's existing OIDC provider, the repository's
  `production` environment, as the runtime's deploy role) may only `PutObject` under `guest/`: no read, no list,
  no delete, no other prefix. The key is the image's sha256 and `publish-guest-image.sh` puts with
  `If-None-Match: *`, so S3 refuses to overwrite an existing object; IAM cannot express that condition, and the
  bucket's versioning keeps every prior version in any case.
- The host role trusts `ec2.amazonaws.com` only, with the job-hosts invariant's guards (precondition, postcondition,
  a `check` against the live role on every plan, and `tests/`): nobody is ever given `sts:AssumeRole` on it, and
  `iam:PassRole` on it is as good as enrolling a host.
- The api task role reads no secret: the execution role reads the one JWKS secret at task start and injects it.
  Nothing in AWS reads the AOP CA secret; only `aop.sh`, run by an operator.
- Hosts' egress: the job-hosts group allows 443 out only; enrollment on 8443 and the NLB on 8794 need egress rules
  there (a job-hosts change).
- Telemetry carries lineage ids, counts, statuses and durations; the daemon's access lines omit paths, ids and
  bodies (`camelfsd/README.md`).

## Cost (estimates)

On-demand list prices, us-west-2, November 2026, approximate; check the pricing pages before relying on them.
DynamoDB on-demand is quoted at the design's figures ($1.25/M write units, $0.25/M read units); AWS halved
on-demand prices in November 2024 ($0.625/M and $0.125/M), which the second column reflects — verify which applies.

**Fixed, monthly (730 h), whatever the load:**

| item | service at 0 tasks (the default) | service running (2 tasks) |
|---|---|---|
| 2 application load balancers ($0.0225/h each) + 1 network load balancer ($0.0225/h) | ~$49 | ~$49 |
| public balancer's IPv4 addresses (one per default subnet, $0.005/h) | ~$15 | ~$15 |
| Fargate ARM, 2 × (1 vCPU / 2 GiB) at $0.0395/h | $0 | ~$58 |
| the tasks' public IPv4 ($0.005/h each) | $0 | ~$7 |
| KMS key, 3 secrets, 35 alarms, Container Insights, logs, ECR, trust bucket | ~$7 | ~$10 |
| **AWS Private CA, short-lived mode** (the hosts' CA) | ~$50 | ~$50 |
| **host and tier certificates** (~$0.058 each in short-lived mode; 24 h validity renewed every 8 h = 3 a day per host) | ~$0 (no hosts) | 10 hosts ≈ 900/month ≈ ~$52; 50 hosts ≈ ~$260 |
| **total** | **~$121** | **~$241 (10 hosts) – ~$451 (50 hosts)** |

**Variable, by scale** (the design's baseline is 1,000 concurrent agents: 144 M API writes + 14.6 M checkpoints a
month, 0.5 TB live; the pilot today is a few agents, so the fixed line is the bill):

| item | pilot (now) | baseline, design prices | baseline, current DynamoDB prices | 10× baseline |
|---|---:|---:|---:|---:|
| DynamoDB writes (≈ 10 units trees + commit, 1 unit the ref CAS, per write) | ~$1 | ~$2,180 | ~$1,090 | ~$21,800 / ~$10,900 |
| DynamoDB reads, storage (~70 GB hot generation), PITR | ~$1 | ~$110 | ~$70 | ~$1,100 |
| S3 PUTs (one blob per API write, ~2 per checkpoint, roots) at $5/M | ~$1 | ~$890 | ~$890 | ~$8,900 |
| S3 GETs, storage (0.5 TB), Inventory | <$1 | ~$65 | ~$65 | ~$650 |
| load-balancer capacity units, extra tasks (autoscaled) | $0 | ~$20 | ~$20 | ~$350 |
| **variable total** | **~$3** | **~$3,270** | **~$2,140** | **~$32,800 / ~$21,900** |
| **with the fixed line** | **~$125** | **~$3,400** | **~$2,260** | **~$33,000 / ~$22,000** |

This matches the C view's baseline (~$3.1–3.7k/month with the ref CAS as one conditional write, or a 2-item
transaction with a quota counter) and camel-fs.md §1.13's shape (the two DynamoDB write lines dominate; tree
segments cut them ~3× at 100×). Per API write: ≈ 19.75 µ$ (objects 17.5 + ref 1.25 + tier 1).

## Commands (the lead applies, in order; Miguel approved the apply on 2026-11-13)

Needs AWS credentials for `904534089871`, `tofu` (>= 1.10), `jq`, `curl`, `openssl`, and Docker with buildx for the
image. No Cloudflare token: DNS is done in the Cloudflare dashboard (or API) by hand from the outputs. Every
plan lists its changes and must show **creates only**; `apply.sh` refuses an update or a deletion it is not told
to expect by name.

1. **First apply: everything but the listeners and the service.** Bucket, tables, roles, secrets, both balancers
   and target groups, the certificate request, the registry, the task definition, the alarms. The live-role check
   warns once (the role is not there yet). Nothing else must exist first.

   ```bash
   PLAN_ONLY=1 infra/camelfs/apply.sh     # review: creates only
   infra/camelfs/apply.sh                 # same plan; type "apply"
   ```

2. **DNS, by hand, in the camelai.dev zone.** The outputs print exactly what to create:

   ```bash
   tofu -chdir=infra/camelfs/terraform output acm_validation_records   # two CNAMEs, DNS only (not proxied)
   tofu -chdir=infra/camelfs/terraform output dns_records              # fs → public ALB (proxied); fs-internal → internal ALB (DNS only)
   ```

   ACM reports `ISSUED` minutes after the validation CNAMEs resolve (`output certificate_status`, or
   `aws acm describe-certificate`). Both balancers answer nothing on 443 until step 3.

3. **Second apply: the listeners and the service, at 0 tasks.** Waits for the certificate (already issued, so at
   once), creates the two HTTPS listeners and the ECS service with `desired_count = 0`: it exists, registers with
   both target groups, and runs nothing (there is no image yet; C1 is not merged).

   ```bash
   PLAN_ONLY=1 infra/camelfs/apply.sh certificate_issued=true
   infra/camelfs/apply.sh certificate_issued=true
   ```

4. **Keys and origin pulls.** The runtime's public JWKS into the tier's secret; then the AOP CA, its trust store,
   and the certificate Cloudflare presents (needs `CLOUDFLARE_API_TOKEN` with Zone › SSL and Certificates › Edit
   on camelai.dev — DNS Edit alone is not enough; the script checks and names the missing permission):

   ```bash
   infra/camelfs/jwks.sh set                                 # <token_issuer>/.well-known/jwks.json → token-verify-keys
   infra/camelfs/notify-key.sh new                           # the §9.11 HMAC key → notify-key; prints the runtime's wrangler command
   infra/camelfs/aop.sh init                                 # the AOP CA → camelfs/prod/aop-ca; prints the PEM's VersionId
   infra/camelfs/aop.sh issue                                # the leaf, uploaded and enabled per-hostname on fs.camelai.dev
   infra/camelfs/aop.sh status                               # Cloudflare reports it enabled
   PLAN_ONLY=1 infra/camelfs/apply.sh aop_ca_version=<VersionId>   # the AOP trust store; public listener off → verify
   ALLOW_UPDATE='aws_lb_listener.api_https["public"]' infra/camelfs/apply.sh aop_ca_version=<VersionId>
   infra/camelfs/aop.sh test                                 # verify mode + 200 through Cloudflare + refused without the cert
   ```

   **Order:** `init`, then `issue` (Cloudflare now presents the leaf; the listener still ignores it), then
   `apply aop_ca_version=…` (the listener starts requiring it), then `test`. The other way round leaves a window
   in which the listener requires a certificate Cloudflare does not yet present, and `fs.camelai.dev` answers
   nothing. The apply is one in-place update of the public listener (`off` → `verify`):
   `ALLOW_UPDATE='aws_lb_listener.api_https["public"]'`.

5. **The image, once C1 is merged.** Build and push (needs `git` in the image: the Dockerfile has it), register
   it on the service (a deployment at 0 tasks completes at once), then start the tasks:

   ```bash
   infra/camelfs/deploy.sh                                   # build, push, register the revision
   PLAN_ONLY=1 infra/camelfs/apply.sh api_min_count=2        # the autoscaling target and the running-tasks alarm
   infra/camelfs/apply.sh api_min_count=2
   ```

   When C2 / K4c are merged and deployed, switch their flags on in the same step:
   `infra/camelfs/deploy.sh && infra/camelfs/apply.sh api_features='["refs","compute"]'` (the apply replaces
   Terraform's revision; the service keeps running deploy.sh's until the next `deploy.sh`, which copies the
   family's latest revision — so run deploy.sh once more after the apply, or apply first and deploy after).

   Every later release is `infra/camelfs/deploy.sh` alone (build, push, register, roll, wait for COMPLETED, then
   save the revision as `service_task_definition_arn` in `prod.tfvars`). Until that first deploy the service runs
   Terraform's own revision, so a port or setting Terraform adds reaches it on apply; afterwards Terraform's
   revision changes ship with the next deploy, which copies the family's latest revision.

6. **Hosts.** Once `infra/job-hosts` is applied, let its pool roles and security group in:

   ```bash
   # the hosts' group reaches the internal balancer on 443, and the tier reaches it on the compute port
   infra/camelfs/apply.sh host_security_group_ids='["sg-..."]'     # infra/job-hosts: aws_security_group.hosts
   # the pool roles get the host policy: add this module's host_policy_arn to host_managed_policies in
   # infra/job-hosts/terraform/iam.tf (one line), then infra/job-hosts/apply.sh
   tofu -chdir=infra/camelfs/terraform output -raw host_policy_arn
   ```

   The proto host (`i-06fa9b78a2a9d188b`) can be let in the same way for the first end-to-end run: its security
   group in `host_security_group_ids`, the host policy attached to its `camel-fs-proto` role by hand. Hosts also
   need egress to 8443 (enrollment) and 8794 (the NLB, `output hosts_endpoint`); the CA certificate to verify the
   tier comes in the enroll reply.

7. **Runtime config** (Cloudflare; this module does not touch it): the public URL. The runtime signs with the
   keys it already has; nothing to copy back.

   ```bash
   tofu -chdir=infra/camelfs/terraform output -raw public_url        # CAMELFS_URL for the Workers runtime
   ```

8. **Guest-image CI** (K1; this module does not touch the workflow): give `.github/workflows/ci.yml`'s publish
   step the role and the location, as variables of the `production` environment:

   ```bash
   tofu -chdir=infra/camelfs/terraform output -raw guest_image_publisher_role_arn   # role-to-assume
   tofu -chdir=infra/camelfs/terraform output -raw guest_image_location             # publish-guest-image.sh's <s3-prefix>
   ```

Later changes go the same way (`PLAN_ONLY=1` first). Arguments are saved to `camelfs/prod.tfvars` in the state
bucket only after an apply, so repeat the ones already set (`certificate_issued=true` stays saved from step 3).
A plan that deletes or replaces anything is refused unless `ALLOW_DESTROY` names each address, and one that
updates a resource in place unless `ALLOW_UPDATE` names it; the Terraform-registered task definition revision is
the one exception (the service runs `deploy.sh`'s revision once one exists, `service_task_definition_arn`). The bucket, the tables and the secrets carry
`prevent_destroy`.

## Tests (no AWS, no Cloudflare)

Every cloud call is mocked, including the live-role check and the Cloudflare ranges fetch; `plan` runs against
mock providers with no credentials, which is the only plan this module ever runs outside the real applies.

```bash
cd infra/camelfs/terraform
tofu init -backend=false && tofu validate && tofu fmt -check -recursive && tofu test
```

Without `tofu` installed: `docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/work" -w /work ghcr.io/opentofu/opentofu:1.10 <command>`.
Eight runs: the first apply (no listener, no service, no compute rules; the short-lived CA and its trust store);
the tables' keys and protection; the balancers (h2 off, sources, DNS modes, health route); the host groups (443 to
the internal balancer, the compute port both ways); the roles (trust invariant, no delete, no sts, hosts denied the
control tables, no secret anywhere but the execution role, only the api role issues end-entity certificates, the
publisher's one prefix); the second apply (validation wait, the public listener, the enrollment listener and its one rule, the service at
0); the service running (Fargate ARM, the command with the three listeners, the injected JWKS, the three target
groups, autoscaling); the AOP CA pinned (trust store, public verify, the ranges group still there); the hosts NLB
(TCP passthrough on 8794, health-checked on the api port).

## Questions for Miguel

0. **Account.** `904534089871` (camelRun prod, where the pools and the runtime are: the job-hosts decision of
   11-12). Nothing here assumes another.
1. **Hostnames.** `fs.camelai.dev` and `fs-internal.camelai.dev` in the camelai.dev zone (the runtime's zone).
   Any other name is `hostname` / `internal_hostname` in `prod.tfvars`, set before the first apply (the
   certificate names them).
2. **VPC.** The default VPC, like the runtime and the pools. A VPC of camelFS's own would need peering or shared
   subnets with the pools for the in-VPC path; not worth it until the fleet has one.
3. **Tier size.** 1 vCPU / 2 GiB × 2–8 tasks. The LRU of trees and small blobs is what memory buys; 2 vCPU / 4 GiB
   doubles the Fargate line to ~$116/month. Nothing measured yet decides this.
4. **The DynamoDB price** in force for this account (list, or the November 2024 halving): it moves the baseline
   bill by a third.

## Unverified (needs real AWS, or proto-block's api role)

- The daemon's api-role flags beyond those proto-block confirmed on 2026-11-13 (`--objects-table`,
  `--lineages-table` with L74, the deliveries/hosts/vms flags with K4: `api_extra_args`), the names
  `--listen-enroll` / `--hosts-ca` (proposed here for K4c, wf-durable), and that `CAMELFS_JWKS` is read when
  `--jwks-file` is absent.
- That a Private CA in short-lived mode accepts the `EndEntityCertificate/V1` template with a URI SAN from the CSR
  (AWS documents SAN passthrough for the end-entity templates), and the per-certificate price (~$0.058).
- That per-hostname Authenticated Origin Pulls is available on the camelai.dev plan (the script reports the
  API's answer; `--zone` is the guarded fallback).
- That the ALB accepts an RSA-4096 AOP CA and a 10-year root in a trust store (the runtime's doc chose RSA 4096
  for that reason).
- That the repository's OIDC subject (`github_subjects`) still matches: `gh api repos/qaml-ai/run/actions/oidc/customization/sub`.
- That the default VPC has default-for-AZ subnets in every AZ the balancers want, and that no name here collides.
- That `https://www.cloudflare.com/ips-v4` keeps its one-range-per-line shape (a postcondition checks for at
  least ten ranges).
- That an ECS service can be created at `desired_count = 0` against a task definition whose image tag does not
  exist in ECR (nothing pulls it; the documented behaviour).
- `TargetResponseTime` p99 as an alarm statistic (`extended_statistic`), and Container Insights' `RunningTaskCount`.
- That the Cloudflare → ALB path accepts a proxied CNAME to a balancer in another account's zone (the runtime's
  does, same zone), and that the internal balancer's name resolves through a DNS-only CNAME from the VPC.
- The cost figures above.

## Not covered here

- The collector (S3 Batch Operations role, `touch` and `warm` tables; camel-fs.md §1.9), dashboards, and the
  daemon's EMF metrics (§1.12).
- The guest-image CI job itself (K1, proto-block) and its `publish-guest-image.sh`; only the role it assumes is here.
- The hosts' side of mTLS (K2): enrollment at boot with the STS attestation on 8443, every later call to the NLB
  on 8794 with the host certificate, the certificate on `--listen-compute 0.0.0.0:8792`, renewal every 8 h, the CA
  from the enroll reply to verify the tier by SAN; the job-hosts egress rules for 8443 and 8794. VM results are PUT by the host under `results/<lineage>/<vm>` (wf-durable, 11-14).
- The tier's side (K4c, wf-durable): enrollment's pool check, `IssueCertificate` with the host's URI SAN, the
  reply `{certificatePem, chainPem, caPem, notAfter}`, terminating mutual TLS on `--listen-hosts` and reading the
  host id from the client certificate's SAN, its own certificate (K4c3 writes `hosts-ca.pem`, `tier.pem`,
  `tier.key` under `--data`).
- Access logs for the balancers (`alb_access_logs_bucket` takes an existing bucket; none is created).
- Gateway endpoints for S3 and DynamoDB on the default route table (free; the tasks go through the internet gateway
  as the runtime's do). Worth adding with a route table of this module's own if the tasks ever leave the default
  subnets.
- The job-hosts module's attachment of `host_policy_arn` (one line there, step 4), and the runtime's client.
- A CI deploy for the image (`deploy.sh` is run by hand; the runtime's `github-deploy.tf` is the pattern).
