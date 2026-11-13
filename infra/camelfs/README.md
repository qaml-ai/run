# camelFS service: AWS infrastructure

Option C of the camelFS design (Miguel, 2026-11-13; `docs/design/camel-fs.md` §1.6, §1.10, §1.13, §5 phase 1):
camelFS as **one AWS service in `us-west-2`**. A stateless Go tier, `camelfsd api` (the §9 storage plane plus a
refs package, and the compute control plane of `camel-fs-compute.md` §3), behind a load balancer; **refs, leases
and fences as DynamoDB conditional writes**; **trees and commits in DynamoDB** (L74); **blobs and chunks in S3**;
the VM hosts run `camelfsd --role host` and reach the tier in-VPC. This directory is that service as OpenTofu in `terraform/`, applied only through the guarded `apply.sh`.
Account `904534089871`, `us-west-2`. **Nothing here has been applied.**

It is its own root module with its own state (`agent-runtime/camelfs/terraform.tfstate` in the runtime's state
bucket), so its plans never mix with the runtime's (`infra/terraform`) or the pools' (`infra/job-hosts`). It reads
the default VPC and its subnets, Cloudflare's address ranges, and the us-west-2 alerts topic; it changes nothing
of theirs.

## What it creates

| File | Resources |
|---|---|
| `bucket.tf` | S3 bucket **`camelfs-prod-904534089871`**: SSE-KMS with its own key (rotation on, S3 bucket keys), public access blocked, owner-enforced, versioned with 35-day noncurrent expiry, incomplete uploads aborted after 2 days, TLS-only, **daily Inventory** (Parquet) into `inventory/` kept 30 days. No expiry of live objects: deletion is the collector's. Keys exactly as `camelfsd` writes them today, `<lineage>/{o,t,k,r,c,ts}/<hash>`, plus `images/guest/<sha256>…` (the guest image, K1) and `results/` (VM results past 400 KB, K4) |
| `dynamodb.tf` | Six on-demand tables with PITR and deletion protection: **`camelfs-prod-objects`** (`lineage` + `id`), **`camelfs-prod-refs`** (`lineage` + `name`), **`camelfs-prod-lineages`** (`lineage`), **`camelfs-prod-deliveries`** (`shard` + `id`), **`camelfs-prod-hosts`** (`pool` + `host`), **`camelfs-prod-vms`** (`id`). No GSI/LSI, no TTL (see "Key schemas") |
| `alb.tf` | One ACM certificate for `fs.camelai.dev` + `fs-internal.camelai.dev` (validated through Cloudflare). Two application load balancers, both **HTTP/2 off**, HTTPS only (TLS 1.3/1.2 policy), deletion protection: **public** (Cloudflare's IPv4 ranges only; `fs.camelai.dev` proxied) and **internal** (the hosts' security groups only; `fs-internal.camelai.dev` DNS-only to its private addresses). A target group each (`/v0/health`, 5 s interval, 2 up / 3 down) |
| `ecs.tf` | ECR repository `camelfs-prod` (immutable tags, newest 20 kept), cluster `camelfs-prod` (Container Insights), the api tasks' security group, and, **once `api_image_tag` is set**, the Fargate task definition (ARM64, 1 vCPU / 2 GiB, read-only root, an ephemeral `/var/lib/camelfs` for the SQLite caches, the JWKS injected as `CAMELFS_JWKS`), the service `camelfs-prod-api` on both target groups (circuit breaker + alarm rollback), and CPU target-tracking autoscaling (2–8 tasks) |
| `iam.tf` | **api** task role (every table; the bucket read/write, never delete; ECS Exec; no secret) and execution role (image, logs, the one JWKS secret for the injection). **host** policy `camelfs-prod-host` (the bucket read/write, the `objects` table only; explicit deny on the five other tables and on `sts:AssumeRole*`), attachable to the job-hosts pool roles, plus a role and instance profile of the same name for hosts outside those pools (trusts `ec2.amazonaws.com` only, guarded like the job-hosts roles). **publisher** role `camelfs-prod-guest-image-publisher` for GitHub Actions (OIDC, the repository's `production` environment): `s3:PutObject` under `images/guest/` and nothing else |
| `secrets.tf` | Secrets Manager container `camelfs/prod/token-verify-keys`: the runtime's public JWKS (Ed25519), the api tier's verification keys. Value by `jwks.sh`, never Terraform |
| `alarms.tf` | To `camelai-agent-runtime-alerts` (us-west-2): per balancer, unhealthy targets (3 min), ALB 5xx (>10/5 min), target 5xx (>25/5 min), target p99 latency (>1 s for 3 of 5 min); per table, read and write throttles and system errors; running tasks below the minimum (once the service exists). 27 alarms |
| `outputs.tf` | URLs, bucket, key, tables, role and policy ARNs, repository, the secret, the guest-image location, and the api command |

### Key schemas (the whole contract this module imposes on the daemon)

| table | partition key | sort key | the item (the daemon's; listed for orientation) |
|---|---|---|---|
| `objects` | `lineage` (S) | `id` (S) = `t/<sha1>` or `k/<sha1>` | `b` (git bytes), `generation`, `createdAt`. Not wired yet: trees and commits are in S3 until L74 |
| `refs` | `lineage` (S) | `name` (S) | `version`, `tree`, `root?`, `owner`, `expiresAt?`, `holder`, `leaseEpoch`, `leaseDeadline`, `updatedAt`. A move is one conditional `UpdateItem` whose condition is the parent rule (`version = parents[0]`) and the lease state the writer believes in |
| `lineages` | `lineage` (S) | — | tenant, kind, quota, default branch, ignore list, last mark |
| `deliveries` | `shard` (S) = `"0"`..`"15"` | `id` (S) | the outbox: a watched ref's move, `vm.*` and `usage.*` events, written in the same `TransactWriteItems` as the state change (camel-fs-files.md §6, §9.11; camel-fs-compute.md); claimers `Query` each shard and claim with a conditional `claimedUntil`. A lineage key would leave pending work unfindable without an index; the shard can still be derived from the lineage |
| `hosts` | `pool` (S) | `host` (S) | `bootEpoch`, `shape`, `slots`, `free`, `vms`, `features`, `lastSeenAt`, `draining` (K4; heartbeats are `UpdateItem`s, placement a `TransactWrite` with the `vms` item) |
| `vms` | `id` (S) | — | the phase row: `phase`, `host`, `lineage`, `ref`, `leaseEpoch`, timestamps, result fields, `payer` (K4; results past 400 KB go to S3 `results/`) |

The lineage is the partition key of every fs table (tenancy in the data, §1.10; adaptive capacity splits a hot
lineage's item collection because there is no LSI). No DynamoDB TTL: a ref's `expiresAt` and a delivery's claim
are the service's to act on; a TTL delete would move a ref without a CAS and without a log. Agreed with
proto-block (objects, refs, lineages), fs-architect and wf-durable (deliveries, hosts, vms) on 2026-11-13; the
attribute names are the only thing to keep in step with `camelfsd`. The `hosts`/`vms` tables of K4 are created
now so the tier's role covers them; nothing writes them until K4 lands.

### The api task's command

The daemon's CLI (proto-block, 2026-11-13), composed by `ecs.tf`:
`camelfsd api --listen 0.0.0.0:8790 --data /var/lib/camelfs --store s3://camelfs-prod-904534089871 --region us-west-2 --token-issuer <token_issuer> --refs-table camelfs-prod-refs`,
plus `api_extra_args` (`--objects-table` / `--lineages-table` once L74 lands; the tables exist already). The
verification keys are not a flag: ECS injects the `token-verify-keys` secret as the environment variable
`CAMELFS_JWKS` at task start (the daemon also takes `--jwks-file`), so no key material is in the task definition
and the task role reads no secret. `token_issuer` is the runtime's `AGENT_PUBLIC_URL` (the JWT `iss` the tier
checks); it must equal `infra/job-hosts`' `runtime_public_url`.

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

**Tokens: the runtime's existing signer, public keys only in AWS.** Tokens are EdDSA/Ed25519 JWTs (`typ`
`camelfs+jwt`, `aud` `camelrun:camelfs`) signed by the runtime's `RuntimeSigner`
(`backends/workers/src/runtime-identity.ts`): the private keys stay sealed in the runtime's Postgres `signing_keys`
and the public JWKS is published at `<runtime>/.well-known/jwks.json`. The tier verifies against a copy of that
JWKS (`jwks.sh set` stores it in `token-verify-keys`; ECS injects it as `CAMELFS_JWKS`) and never calls the
network for keys. So nothing in AWS can mint a token, there is no key to generate here, and a rotation is the
runtime's (publish the new key beside the old) followed by `jwks.sh set`, which rolls the service. An earlier
draft of this module generated an ES256 pair of its own; the lead approved reusing the runtime's signer instead.

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
- The guest-image publisher (GitHub Actions through the account's existing OIDC provider, the repository's
  `production` environment, as the runtime's deploy role) may only `PutObject` under `images/guest/`: no read, no
  list, no delete, no other prefix. The key is the image's sha256 and `publish-guest-image.sh` puts with
  `If-None-Match: *`, so S3 refuses to overwrite an existing object; IAM cannot express that condition, and the
  bucket's versioning keeps every prior version in any case.
- The host role trusts `ec2.amazonaws.com` only, with the job-hosts invariant's guards (precondition, postcondition,
  a `check` against the live role on every plan, and `tests/`): nobody is ever given `sts:AssumeRole` on it, and
  `iam:PassRole` on it is as good as enrolling a host.
- The api task role reads no secret: the execution role reads the one JWKS secret at task start and injects it.
- Telemetry carries lineage ids, counts, statuses and durations; the daemon's access lines omit paths, ids and
  bodies (`camelfsd/README.md`).

## Cost (estimates)

On-demand list prices, us-west-2, November 2026, approximate; check the pricing pages before relying on them.
DynamoDB on-demand is quoted at the design's figures ($1.25/M write units, $0.25/M read units); AWS halved
on-demand prices in November 2024 ($0.625/M and $0.125/M), which the second column reflects — verify which applies.

**Fixed, monthly (730 h), whatever the load:**

| item | foundation only (no image) | service running (2 tasks) |
|---|---|---|
| 2 application load balancers ($0.0225/h each) | ~$33 | ~$33 |
| public balancer's IPv4 addresses (one per default subnet, $0.005/h) | ~$15 | ~$15 |
| Fargate ARM, 2 × (1 vCPU / 2 GiB) at $0.0395/h | $0 | ~$58 |
| the tasks' public IPv4 ($0.005/h each) | $0 | ~$7 |
| KMS key, 1 secret, 27 alarms, Container Insights, logs, ECR | ~$6 | ~$9 |
| **total** | **~$54** | **~$122** |

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

## Commands (Miguel, in order)

Needs AWS credentials for `904534089871`, `CLOUDFLARE_API_TOKEN` (DNS edit on camelai.dev: the certificate's
validation records and the two hostnames), `tofu` (>= 1.10), `jq`, `curl`, and Docker with buildx for the image.

1. **Foundation** (bucket, tables, roles, secrets, balancers, registry, alarms; no service). Nothing else must
   exist first. The live-role check warns once (the role is not there yet).

   ```bash
   PLAN_ONLY=1 infra/camelfs/apply.sh     # review: only creates
   infra/camelfs/apply.sh                 # same plan; type "apply"
   ```

   Both balancers answer 503 until a service registers. Cloudflare's address ranges and the certificate validation
   wait on DNS propagation; the apply holds until ACM issues the certificate (minutes).

2. **Verification keys.** Copies the runtime's public JWKS (`<token_issuer>/.well-known/jwks.json`) into the
   secret the api tasks read:

   ```bash
   infra/camelfs/jwks.sh set
   ```

3. **The first image.** Build and push from a checkout whose `camelfsd/` has the api role, then create the
   service running it (the tag is saved to `camelfs/prod.tfvars` in the state bucket):

   ```bash
   tag=$(DEPLOY_PUSH_ONLY=1 infra/camelfs/deploy.sh)
   PLAN_ONLY=1 infra/camelfs/apply.sh api_image_tag=$tag
   infra/camelfs/apply.sh api_image_tag=$tag
   ```

   Every later release is `infra/camelfs/deploy.sh` (build, push, register a revision, roll, wait for COMPLETED).

4. **Hosts.** Once `infra/job-hosts` is applied, let its pool roles and security group in:

   ```bash
   # the hosts' security group reaches the internal balancer
   infra/camelfs/apply.sh host_security_group_ids='["sg-..."]'     # infra/job-hosts: aws_security_group.hosts
   # the pool roles get the host policy: add this module's host_policy_arn to host_managed_policies in
   # infra/job-hosts/terraform/iam.tf (one line), then infra/job-hosts/apply.sh
   tofu -chdir=infra/camelfs/terraform output -raw host_policy_arn
   ```

   The proto host (`i-06fa9b78a2a9d188b`) can be let in the same way for the first end-to-end run: its security
   group in `host_security_group_ids`, the host policy attached to its `camel-fs-proto` role by hand.

5. **Runtime config** (Cloudflare; this module does not touch it): the public URL. The runtime signs with the
   keys it already has; nothing to copy back.

   ```bash
   tofu -chdir=infra/camelfs/terraform output -raw public_url        # CAMELFS_URL for the Workers runtime
   ```

6. **Guest-image CI** (K1; this module does not touch the workflow): give `.github/workflows/ci.yml`'s publish
   step the role and the location, as repository variables of the `production` environment:

   ```bash
   tofu -chdir=infra/camelfs/terraform output -raw guest_image_publisher_role_arn   # role-to-assume
   tofu -chdir=infra/camelfs/terraform output -raw guest_image_location             # publish-guest-image.sh's <s3-prefix>
   ```

Later changes go the same way (`PLAN_ONLY=1` first). A plan that deletes or replaces anything is refused unless
`ALLOW_DESTROY` names each address; the Terraform-registered task definition revision is the one exception (the
service runs `deploy.sh`'s revision). The bucket, the tables and the secret carry `prevent_destroy`.

## Tests (no AWS, no Cloudflare)

Every cloud call is mocked, including the live-role check; `plan` runs against mock providers with no credentials,
which is the only plan this module ever runs outside Miguel's applies.

```bash
cd infra/camelfs/terraform
tofu init -backend=false && tofu validate && tofu fmt -check -recursive && tofu test
```

Without `tofu` installed: `docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/work" -w /work ghcr.io/opentofu/opentofu:1.10 <command>`.
Six runs: the foundation without an image; the tables' keys and protection; the balancers (h2 off, TLS, sources,
DNS modes, health route); the internal balancer admitting named host groups; the roles (trust invariant, no delete,
no sts, hosts denied refs, no secret on the task role); the service once an image is named (Fargate ARM, both
groups, the command, the JWKS injection).

## Questions for Miguel

0. **Account.** `904534089871` (camelRun prod, where the pools and the runtime are: the job-hosts decision of
   11-12). Nothing here assumes another.
1. **Hostnames.** `fs.camelai.dev` and `fs-internal.camelai.dev` in the camelai.dev zone (the runtime's zone, its
   token already edits it). Any other name is `hostname` / `internal_hostname` in `prod.tfvars`.
2. **VPC.** The default VPC, like the runtime and the pools. A VPC of camelFS's own would need peering or shared
   subnets with the pools for the in-VPC path; not worth it until the fleet has one.
3. **Tier size.** 1 vCPU / 2 GiB × 2–8 tasks. The LRU of trees and small blobs is what memory buys; 2 vCPU / 4 GiB
   doubles the Fargate line to ~$116/month. Nothing measured yet decides this.
4. **The DynamoDB price** in force for this account (list, or the November 2024 halving): it moves the baseline
   bill by a third.

## Unverified (needs real AWS, or proto-block's api role)

- The daemon's api-role flags beyond those proto-block confirmed on 2026-11-13 (`--objects-table`,
  `--lineages-table` with L74, the deliveries/hosts/vms flags with K4: `api_extra_args`), and that `CAMELFS_JWKS`
  is read when `--jwks-file` is absent.
- That the repository's OIDC subject (`github_subjects`) still matches: `gh api repos/qaml-ai/run/actions/oidc/customization/sub`.
- That the default VPC has default-for-AZ subnets in every AZ the balancers want, and that no name here collides.
- That `cloudflare_ip_ranges` under provider 5.x exposes `ipv4_cidrs` (it did under 4.x and 5.x at writing).
- `TargetResponseTime` p99 as an alarm statistic (`extended_statistic`), and Container Insights' `RunningTaskCount`.
- That the Cloudflare → ALB path accepts a proxied CNAME to a balancer in another account's zone (the runtime's
  does, same zone).
- The cost figures above.

## Not covered here

- The collector (S3 Batch Operations role, `touch` and `warm` tables; camel-fs.md §1.9), dashboards, and the
  daemon's EMF metrics (§1.12).
- The guest-image CI job itself (K1, proto-block) and its `publish-guest-image.sh`; only the role it assumes is here.
- Access logs for the balancers (`alb_access_logs_bucket` takes an existing bucket; none is created).
- Gateway endpoints for S3 and DynamoDB on the default route table (free; the tasks go through the internet gateway
  as the runtime's do). Worth adding with a route table of this module's own if the tasks ever leave the default
  subnets.
- The job-hosts module's attachment of `host_policy_arn` (one line there, step 4), and the runtime's client.
- A CI deploy for the image (`deploy.sh` is run by hand; the runtime's `github-deploy.tf` is the pattern).
