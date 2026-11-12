# Job-host pools: AWS infrastructure

Slice 7 of [docs/design/job-hosts-plan.md](../../docs/design/job-hosts-plan.md): the AWS side of our own job hosts,
as OpenTofu in `terraform/`, applied only through the guarded `apply.sh`. Account `904534089871` (camelRun prod),
`us-west-2`. Nothing here has been applied.

It is its own root module, with its own state (`agent-runtime/job-hosts/terraform.tfstate` in the runtime's state
bucket), so its plans never mix with the runtime's (`infra/terraform`) and a mistake here cannot touch the runtime.
It only reads the runtime's resources: the default VPC and its internet gateway, and the us-west-2 alerts topic.

## What it creates

| File | Resources |
|---|---|
| `bucket.tf` | S3 bucket `camelrun-job-images-prod`: SSE-KMS with its own KMS key (rotation on, S3 bucket keys), public access blocked, owner-enforced, versioned, TLS-only bucket policy. Lifecycle: `outputs/` deleted after 7 days; `snapshots/` tagged `unreferenced=true` (by the runtime's GC, slice 5) deleted 30 days after they were written; noncurrent versions everywhere after 30 days; incomplete uploads after 2 days |
| `network.tf` | Three dedicated **public** subnets in the default VPC (`172.31.128.0/20`, `.144.0/20`, `.160.0/20` in us-west-2a/b/c), a route table sending 0.0.0.0/0 to the VPC's existing internet gateway (looked up, not created), an S3 gateway endpoint on that route table (none exists; set `s3_gateway_endpoint_id` to reuse one), a network ACL on the three subnets, and the hosts' security group: no inbound rule, egress TCP 443 only. **No NAT gateway** (see "Network" below) |
| `iam.tf` | One host role and instance profile per pool, `camelrun-job-hosts-build-prod` and `camelrun-job-hosts-test-prod` (below); both exist before any AMI is set |
| `ssm.tf` | `/camelrun/job-hosts/prod/runtime-url` and `/camelrun/job-hosts/prod/enrollment-audience` (`camelrun-job-host:<runtime URL>`) |
| `pools.tf` | Per pool, once its AMI is set: a launch template (arm64 AMI, IMDSv2 required with hop limit 1, Nitro Enclaves on, NVMe instance store mapped, the host profile, no key pair, a public IPv4 address, encrypted gp3 root) and an Auto Scaling group across the pool subnets with a 15-minute termination lifecycle hook for draining |
| `scaler.tf` | Once a pool exists: the scaler Lambda (below), its log group (14 days), an EventBridge rule running it every minute, its role, and an alarm on its errors |
| `alarms.tf` | Per pool: "fewer hosts in service than desired for 15 minutes" and "a host failing EC2 status checks for 10 minutes", to `camelai-agent-runtime-alerts` (us-west-2), which emails Miguel like the runtime's alarms |

The pools at the defaults:

| Pool | Instance | Purchase | Min | Desired | Max |
|---|---|---|---|---|---|
| build | `r8gd.4xlarge` (16 vCPU, 128 GiB, 950 GB NVMe) | on-demand | `build_warm_size` (0) | `build_warm_size` (0) | 4 |
| test | `c8gd.4xlarge` (16 vCPU, 32 GiB, 950 GB NVMe) | on-demand (`test_use_spot=true` for spot) | 0 | the scaler | 16 |

**A pool exists only once its AMI is set** (`build_ami_id`, `test_ami_id`, from slice 1). With an empty AMI there is
no launch template, ASG or alarm for that pool, so the bucket, network and role can be applied first and an empty
AMI can never reach a launch.

The host writes nothing it does not need: user data reads the two SSM parameters into `/etc/camelrun/job-host.env`
(`CAMELRUN_RUNTIME_URL`, `CAMELRUN_JOB_HOST_AUDIENCE`, `CAMELRUN_JOB_HOST_POOL`, `CAMELRUN_JOB_IMAGES_BUCKET`,
`AWS_REGION`) for slice 1's agent unit, and fails the boot if it cannot.

Both pools scale from zero by default (`build_warm_size=0`): a build waits for a cold host to boot and enroll.
`build_warm_size=2` keeps two build hosts running instead (the cost tables below show both).

### Network

The pools sit in their own public subnets and reach the internet through the VPC's existing internet gateway; there
is no NAT gateway.

- **A public IP exposes nothing that answers.** The security group is stateful and has no inbound rule, so nothing
  unsolicited reaches a host; there is no SSH (Session Manager only, which the host dials out to).
- **Hosts need only 443 out:** the runtime's WebSocket, the egress proxy, SSM, STS, and the per-job allowlisted
  registries and GitHub (the allowlist is enforced on the host, per job). S3 goes through the gateway endpoint.
- **The network ACL** on the pool subnets is a stateless second layer. Inbound: TCP 1024-65535 (return traffic of
  the hosts' own connections) and ICMP type 3 code 4, "fragmentation needed", so path MTU discovery works (hosts use
  9001-byte frames inside the VPC, the internet 1500; this one ICMP rule is the only addition to "return traffic
  only"). Outbound: TCP 443 and the ephemeral reply ports 1024-65535. Everything else hits the ACL's final deny.
- **DNS, IMDS and NTP need no rule:** network ACLs, like security groups, do not filter traffic to the
  Amazon-provided DNS resolver (VPC base + 2 and 169.254.169.253), the instance metadata service (169.254.169.254),
  the Time Sync Service (169.254.169.123) or DHCP (AWS VPC user guide, network ACLs, "Considerations").
- **Cost:** no NAT saves about $33/month plus $0.045/GB processed. Each running host pays for its public IPv4
  address instead: $0.005/h, about $3.65/month per host, and nothing while the pools are empty.

### Nitro, not KVM

The hosts do **not** use `/dev/kvm`. Each job runs in a Firecracker microVM in **Nitro Sandboxes** mode (direct
mode): Firecracker creates it through the Nitro Enclaves driver (`/dev/nitro_enclaves`) and the Nitro Hypervisor
enforces the boundary. So:

- The parent is a **non-metal** instance type that supports AWS Nitro Enclaves, Graviton or x86. Sandboxes do
  **not** run on bare metal ("Unlike KVM microVMs, sandboxes do not run on bare-metal instances"). The launch
  templates enable enclaves (`enclave_options { enabled = true }`), and a precondition refuses instance types that
  are not Graviton with instance storage (`…g…d.`), or that are `.metal*` or `.medium`.
- The parent kernel is Amazon Linux 2023 `kernel6.18`, version **6.18.51-120.162.amzn2023 or later** (the AMI from
  slice 1; on Graviton, `al2023-ami-kernel-6.18-arm64`).
- Hop limit 1 on IMDS does not by itself keep a sandbox away from the host's role credentials: AWS notes that a
  parent routing sandbox traffic lets it reach the parent's IMDS. The host image's nftables rules (slice 1) drop
  sandbox traffic to 169.254.169.254, and slice 6's isolation suite tests that.

Sources:
- Firecracker, Nitro Sandboxes getting started, "Requirements / Parent instance":
  https://github.com/firecracker-microvm/firecracker/blob/main/docs/nitro-sandboxes/getting-started.md
- AWS Nitro Enclaves requirements (the supported instance types; `R8gd` and `C8gd`: all types except `.medium`
  and `.metal-*`): https://docs.aws.amazon.com/enclaves/latest/user/nitro-enclave.html#nitro-enclave-reqs
- AWS EC2 Nitro Sandboxes (modes, supported types, IMDS and hibernation caveats):
  https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/amazon-ec2-nitro-sandboxes.html

### The host roles

Each pool has its own role and instance profile, `camelrun-job-hosts-build-prod` and `camelrun-job-hosts-test-prod`,
and each launch template uses its own pool's profile. The runtime takes a host's pool from the role it attests with
(`JOB_HOST_ROLE_ARNS` maps each role to its pool), never from what the host says, so a test host cannot claim to be
a build host. Both roles carry the same permissions:

- **Trust: `ec2.amazonaws.com` only.** See the invariant below.
- `AmazonSSMManagedInstanceCore` (Session Manager; there is no SSH).
- Read `images/*` and `snapshots/*` in the bucket, list those prefixes, and `kms:Decrypt` on the bucket's key through
  S3 only. No writes: snapshots and outputs go up through URLs the runtime presigns (slice 5).
- Read its two SSM parameters (`runtime-url`, `enrollment-audience`) by exact name. An explicit deny on every
  other parameter, because the SSM core policy allows reading all of them; that includes the scaler's token under
  the same prefix.
- No Auto Scaling permissions: the scaler completes the hosts' termination hooks.
- An explicit deny on `sts:AssumeRole*`. No secrets, no database, no CloudWatch agent (the runtime gets heartbeats
  over the host's WebSocket; EC2's basic metrics are enough for the alarms).

### The scaler

A Lambda (`camelrun-job-hosts-scaler`; code in `infra/job-hosts/scaler/index.mjs`, Node 22, arm64, 128 MB, 50 s
timeout, reserved concurrency 1 so two runs never decide at once) that EventBridge runs every minute. It exists only
when at least one pool does. Each run it reads every pool's demand from the runtime (`RUNTIME_URL`, authenticated with
the token in the SSM SecureString `TOKEN_PARAMETER`) and the ASGs' state, then:

- **Scales out on waiting jobs**, up to the ASG max: enough hosts for the waiting jobs at `BUILD_SLOTS=1` job per
  build host and `TEST_SLOTS=8` per test host.
- **Scales in hosts idle for `IDLE_MINUTES`** (`scaler_idle_minutes`, default 10), never below the ASG min: it asks
  the runtime to drain the host first (no new jobs placed on it), then terminates it with
  `ShouldDecrementDesiredCapacity`, so the ASG does not replace it.
- **Completes termination lifecycle hooks** (for its own scale-ins and for any other termination) once the runtime
  reports the host has no running jobs or has disconnected. The hook's 15-minute timeout (`CONTINUE`) is the
  backstop if the scaler is down.

Its role trusts only `lambda.amazonaws.com`, for functions in this account (`aws:SourceAccount`), and may do
exactly this (a precondition and the tests check the set):
`autoscaling:DescribeAutoScalingGroups` (on `*`: it takes no resource-level permissions);
`SetDesiredCapacity`, `TerminateInstanceInAutoScalingGroup` and `CompleteLifecycleAction` on the two pools' ASG ARNs
only; `ssm:GetParameter` on its token parameter only; and writing its own log group. Nothing else, no KMS: keep the
token on the default `aws/ssm` key, which SSM decrypts for it. An alarm fires when it has errored in each of three
5-minute periods (15 minutes), to the same alerts topic.

The token is **not** created here (no secrets in state); see "Scaler token" in the commands below.

## The trust-policy invariant

It holds for **both** roles, build and test. The runtime takes a host's id from the role session name of its signed
`sts:GetCallerIdentity`, and its pool from the role; whoever assumes a role picks the session name. EC2 sets it to
the instance id; any other principal able to assume a role could name a running instance and take its jobs and
their secrets. So:

- **Each role trusts only the service principal `ec2.amazonaws.com`.** No user, role, account, or a role itself (nor
  the other pool's role).
- **Nobody is ever given `sts:AssumeRole` on either**, in this module or anywhere else. (With a trust policy naming
  only EC2, an identity policy alone cannot let an IAM principal assume it; keep it that way.)
- **`iam:PassRole` on a role is as good as enrolling a host of that pool**: whoever may pass it to
  `ec2:RunInstances` (or `ec2:AssociateIamInstanceProfile`) starts a real instance that enrolls as a real host.
  Only the operator who applies this module should have it.

Guards that fail the plan, for each role: a precondition on `aws_iam_role.host` (the policy as written), a
postcondition on it (the policy as AWS returns it after a refresh), `check "host_role_trust_build"` and
`check "host_role_trust_test"` (read the live roles on every plan and warn on drift; on the very first plan the roles
do not exist yet, so each warns once), a precondition that the inline policy allows no `sts:` action, and
`terraform/tests/job-hosts.tftest.hcl`.

## Cost (estimates)

On-demand Linux list prices, us-west-2, November 2026, approximate; check the AWS pricing page before relying on them.

Rates: `r8gd.4xlarge` ~$1.176/h; `c8gd.4xlarge` ~$0.784/h; public IPv4 $0.005/h per running host (~$3.65/month);
root volume 30 GiB gp3 at $0.08/GB-month (~$2.40/month per running host); KMS key $1/month; S3 $0.023/GB-month;
CloudWatch alarms $0.10 per metric. Free: the S3 gateway endpoint, SSM parameters, ASG group metrics, the internet
gateway, Nitro Sandboxes themselves.

| Monthly, fixed (730 h) | Foundation only (no AMIs) | AMIs set, `build_warm_size=0` (default) | AMIs set, `build_warm_size=2` |
|---|---|---|---|
| Build hosts | $0 | $0 | 2 × ~$858 = **~$1,717** |
| Their public IPv4 | $0 | $0 | 2 × ~$3.65 = ~$7 |
| Their root volumes | $0 | $0 | 2 × ~$2.40 = ~$5 |
| KMS key | ~$1 | ~$1 | ~$1 |
| Alarms (5, two with 2-metric math) | $0 | ~$1 | ~$1 |
| Scaler (Lambda, logs, schedule) | $0 | a few cents | a few cents |
| **Total, plus S3 storage (~$12 per 500 GB)** | **~$1** | **~$2** | **~$1,731** |

The scaler: 43,800 runs a month at 128 MB and about a second each is ~5,500 GB-seconds (~$0.07 on arm64) plus
~$0.01 of requests, within Lambda's free tier anyway; its logs a few cents; the schedule and the SSM standard
parameter reads are free.

On top, per running host: build ~$1.18/h, test ~$0.79/h (instance plus its IPv4), plus ~$2.40/month of root
volume. At the maxima (4 build + 16 test, all running) the pools cost ~$17.35/h, about $12,700 a month: the ASG
maxima are the spend cap. Data out to the internet is EC2's standard transfer pricing; there is no NAT processing
charge.

## vCPU quotas (not requested here)

Both families count against **Running On-Demand Standard (A, C, D, H, I, M, R, T, Z) instances**, quota code
`L-1216C47A`, in vCPUs. The maxima need 4 × 16 (build) + 16 × 16 (test) = **320 vCPUs**, on top of any other
EC2 usage in the account. The default for an account is often lower; request the increase before the acceptance
run. With `test_use_spot=true`, the test pool needs 256 vCPUs of **All Standard Spot Instance Requests**
(`L-34B43A08`) instead.

```bash
aws service-quotas get-service-quota --region us-west-2 --service-code ec2 --quota-code L-1216C47A --query Quota.Value
```

## Commands (Miguel, in order)

Needs AWS credentials for `904534089871`, `tofu` (>= 1.10) and `jq`. No Cloudflare token.

1. **Foundation** (bucket, key, network, role, SSM parameters, no pools). Nothing else must exist first.

   ```bash
   PLAN_ONLY=1 infra/job-hosts/apply.sh     # review: only creates; the trust checks warn once (roles not there yet)
   infra/job-hosts/apply.sh                 # same plan; type "apply"
   ```

2. **Pools**, once slice 1 has built the AMIs (one per pool kind: the mempool differs) and the vCPU quota covers
   them. Arguments are saved to `job-hosts/prod.tfvars` in the state bucket only after an apply, so give them again:

   ```bash
   PLAN_ONLY=1 infra/job-hosts/apply.sh build_ami_id=ami-... test_ami_id=ami-...
   infra/job-hosts/apply.sh build_ami_id=ami-... test_ami_id=ami-...
   ```

   Both pools start empty and scale from zero. To keep two build hosts warm (~$1,730/month), add
   `build_warm_size=2`.

3. **Runtime config** (Cloudflare; this module does not touch it). Read `JOB_HOST_ROLE_ARNS`, ready to paste:

   ```bash
   tofu -chdir=infra/job-hosts/terraform output -raw job_host_role_arns
   ```

   Then add to `backends/workers/wrangler.pilot.jsonc` (the runtime's `AGENT_PUBLIC_URL` there,
   `https://run-pilot.camelai.dev`, must equal `runtime_public_url` here):

   ```jsonc
   // durable_objects.bindings: add
   { "name": "JOB_HOSTS", "class_name": "JobHost" },
   { "name": "HOST_JOBS", "class_name": "HostJob" },
   { "name": "JOB_HOST_REGISTRY", "class_name": "JobHostRegistry" },

   // migrations: append after "workflow-object"
   { "tag": "job-hosts", "new_sqlite_classes": ["JobHost", "HostJob", "JobHostRegistry"] },

   // top level: the enrollment rate limit, keyed by client address (backends/workers/src/jobs/hosts.ts).
   // namespace_id is any positive integer not used by another rate limit in the Cloudflare account.
   "ratelimits": [
     { "name": "JOB_HOST_ENROLL_LIMITER", "namespace_id": "4201", "simple": { "limit": 10, "period": 60 } }
   ],

   // vars: add
   "JOB_HOST_ATTESTORS": "aws",
   // pool=arn pairs, comma-separated: the runtime takes each host's pool from the role it attests with.
   "JOB_HOST_ROLE_ARNS": "build=arn:aws:iam::904534089871:role/camelrun-job-hosts-build-prod,test=arn:aws:iam::904534089871:role/camelrun-job-hosts-test-prod",
   ```

   The aws attestor refuses to run without `JOB_HOST_ROLE_ARNS`, `AGENT_PUBLIC_URL` and the rate limit, so all three
   go in together.

4. **Scaler token**, before or right after step 2 (until it exists, every scaler run fails and, after 15 minutes,
   alarms). One random value, 48 characters or more, in two places; the scaler sends it to the runtime:

   ```bash
   token=$(openssl rand -base64 48 | tr -d '\n=+/')
   aws ssm put-parameter --region us-west-2 --name /camelrun/job-hosts/prod/scaler-token --type SecureString --value "$token"
   (cd backends/workers && printf %s "$token" | npx wrangler secret put JOB_HOST_SCALER_TOKEN --config wrangler.pilot.jsonc)
   unset token
   ```

   Keep the default key (`aws/ssm`). To rotate, put a new value in both places (`--overwrite` on the parameter).

Later changes go the same way (`PLAN_ONLY=1` first). A plan that deletes or replaces anything is refused unless
`ALLOW_DESTROY` names each address, for example `ALLOW_DESTROY='aws_autoscaling_group.test[0]'`. Changing an AMI
updates the launch template in place; running hosts keep the old one until they are replaced.

## Tests

No AWS needed (mock providers):

```bash
cd infra/job-hosts/terraform
tofu init -backend=false && tofu validate && tofu fmt -check -recursive && tofu test
```

## Unverified (needs real AWS or a later slice)

- That `r8gd.4xlarge` and `c8gd.4xlarge` support Nitro Enclaves, and so Nitro Sandboxes: the AWS requirements page
  above lists `R8gd` and `C8gd` (all but `.medium` and `.metal-*`) today; confirm against it, and on a real host,
  before the first pool apply.
- That the lookups resolve: the default VPC is `172.31.0.0/16` with one internet gateway attached, and the alerts
  topic exists in us-west-2 by that name.
- That `172.31.128.0/20`, `.144.0/20` and `.160.0/20` are free in the VPC, and both types are offered in
  us-west-2a/b/c.
- That no S3 gateway endpoint exists outside Terraform (if one does, set `s3_gateway_endpoint_id`).
- That EC2 publishes `StatusCheckFailed` per Auto Scaling group under basic monitoring.
- The scaler's code (`infra/job-hosts/scaler/`, written separately): `archive_file` zips that directory at plan
  time, so the plan fails until it exists. Also the Lambda concurrency quota: reserving 1 needs the account's
  unreserved concurrency to stay at or above 10 (accounts with a 10-execution limit cannot reserve any).
- The vCPU quota, the Auto Scaling service-linked role, and whether default EBS encryption uses a customer key
  (the ASG's role would need a grant).
- The AMIs (slice 1) and their kernel version (6.18.51-120.162.amzn2023 or later), and the prices above.

## Not covered here

- The AMIs (slice 1), the scaler's code and the runtime's demand and drain endpoints it calls, and runtime-side
  alarms on heartbeat loss and stuck leases.
- Credentials for the runtime to presign snapshot and output uploads into the bucket (slice 5): whatever signs them
  needs `s3:PutObject` under `snapshots/`/`outputs/` and `kms:GenerateDataKey` on `images_kms_key_arn`.
