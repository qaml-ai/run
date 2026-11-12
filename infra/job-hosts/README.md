# Job-host pools: AWS infrastructure

Slice 7 of [docs/design/job-hosts-plan.md](../../docs/design/job-hosts-plan.md): the AWS side of our own job hosts,
as OpenTofu in `terraform/`, applied only through the guarded `apply.sh`. Account `904534089871` (camelRun prod),
`us-west-2`. Nothing here has been applied.

It is its own root module, with its own state (`agent-runtime/job-hosts/terraform.tfstate` in the runtime's state
bucket), so its plans never mix with the runtime's (`infra/terraform`) and a mistake here cannot touch the runtime.
It only reads the runtime's resources: the default VPC and its public subnet for the NAT, and the us-west-2 alerts
topic.

## What it creates

| File | Resources |
|---|---|
| `bucket.tf` | S3 bucket `camelrun-job-images-prod`: SSE-KMS with its own KMS key (rotation on, S3 bucket keys), public access blocked, owner-enforced, versioned, TLS-only bucket policy. Lifecycle: `outputs/` deleted after 7 days; `snapshots/` tagged `unreferenced=true` (by the runtime's GC, slice 5) deleted 30 days after they were written; noncurrent versions everywhere after 30 days; incomplete uploads after 2 days |
| `network.tf` | Three private subnets in the default VPC (`172.31.128.0/20`, `.144.0/20`, `.160.0/20` in us-west-2a/b/c), one route table, **one NAT gateway** with its Elastic IP (the VPC has none: the runtime's tasks use public IPs), an S3 gateway endpoint (none exists; set `s3_gateway_endpoint_id` to reuse one), and the hosts' security group: no inbound rule, egress TCP 443 only |
| `iam.tf` | The host role and instance profile (below) |
| `ssm.tf` | `/camelrun/job-hosts/prod/runtime-url` and `/camelrun/job-hosts/prod/enrollment-audience` (`camelrun-job-host:<runtime URL>`) |
| `pools.tf` | Per pool, once its AMI is set: a launch template (arm64 AMI, IMDSv2 required with hop limit 1, Nitro Enclaves on, NVMe instance store mapped, the host profile, no key pair, no public IP, encrypted gp3 root) and an Auto Scaling group across the private subnets with a 15-minute termination lifecycle hook for draining |
| `alarms.tf` | Per pool: "fewer hosts in service than desired for 15 minutes" and "a host failing EC2 status checks for 10 minutes", to `camelai-agent-runtime-alerts` (us-west-2), which emails Miguel like the runtime's alarms |

The pools at the defaults:

| Pool | Instance | Purchase | Min | Desired | Max |
|---|---|---|---|---|---|
| build | `r8gd.4xlarge` (16 vCPU, 128 GiB, 950 GB NVMe) | on-demand | 2 | 2 | 4 |
| test | `c8gd.4xlarge` (16 vCPU, 32 GiB, 950 GB NVMe) | on-demand (`test_use_spot=true` for spot) | 0 | slice 8 | 16 |

**A pool exists only once its AMI is set** (`build_ami_id`, `test_ami_id`, from slice 1). With an empty AMI there is
no launch template, ASG or alarm for that pool, so the bucket, network and role can be applied first and an empty
AMI can never reach a launch.

The host writes nothing it does not need: user data reads the two SSM parameters into `/etc/camelrun/job-host.env`
(`CAMELRUN_RUNTIME_URL`, `CAMELRUN_JOB_HOST_AUDIENCE`, `CAMELRUN_JOB_HOST_POOL`, `CAMELRUN_JOB_IMAGES_BUCKET`,
`AWS_REGION`) for slice 1's agent unit, and fails the boot if it cannot.

### The host role

- **Trust: `ec2.amazonaws.com` only.** See the invariant below.
- `AmazonSSMManagedInstanceCore` (Session Manager; there is no SSH).
- Read `images/*` and `snapshots/*` in the bucket, list those prefixes, and `kms:Decrypt` on the bucket's key through
  S3 only. No writes: snapshots and outputs go up through URLs the runtime presigns (slice 5).
- Read its own two SSM parameters. An explicit deny on every other parameter, because the SSM core policy allows
  reading all of them.
- `autoscaling:CompleteLifecycleAction` / `RecordLifecycleActionHeartbeat` on the pools' ASGs, so a drained host ends
  its own termination wait. (No condition key names the instance: a host could end another host's wait, which only
  terminates that host sooner.)
- An explicit deny on `sts:AssumeRole*`. No secrets, no database, no CloudWatch agent (the runtime gets heartbeats
  over the host's WebSocket; EC2's basic metrics are enough for the alarms).

## The trust-policy invariant

The runtime takes a host's id from the role session name of its signed `sts:GetCallerIdentity`, and whoever assumes
the role picks that name. EC2 sets it to the instance id; any other principal able to assume the role could name a
running instance and take its jobs and their secrets. So:

- **The role trusts only the service principal `ec2.amazonaws.com`.** No user, role, account, or the role itself.
- **Nobody is ever given `sts:AssumeRole` on it**, in this module or anywhere else. (With a trust policy naming only
  EC2, an identity policy alone cannot let an IAM principal assume it; keep it that way.)
- **`iam:PassRole` on it is as good as enrolling a host**: whoever may pass it to `ec2:RunInstances` (or
  `ec2:AssociateIamInstanceProfile`) starts a real instance that enrolls as a real host. Only the operator who
  applies this module should have it.

Guards that fail the plan: a precondition on `aws_iam_role.host` (the policy as written), a postcondition on it (the
policy as AWS returns it after a refresh), `check "host_role_trust"` (reads the live role on every plan and warns on
drift; on the very first plan the role does not exist yet, so that check warns once), a precondition that the inline
policy allows no `sts:` action, and `terraform/tests/job-hosts.tftest.hcl`.

## Cost at the defaults (estimates)

On-demand Linux list prices, us-west-2, November 2026, approximate; check the AWS pricing page before relying on them.

| Item | Rate | Monthly (730 h) |
|---|---|---|
| Build pool, 2 warm `r8gd.4xlarge` | ~$1.176/h each | **~$1,717** |
| Their root volumes, 2 × 30 GiB gp3 | $0.08/GB-month | ~$5 |
| NAT gateway | $0.045/h + $0.045/GB processed | ~$33 + traffic |
| NAT Elastic IP (public IPv4) | $0.005/h | ~$4 |
| KMS key | $1/month + requests (few, with bucket keys) | ~$1 |
| S3 storage | $0.023/GB-month | ~$12 per 500 GB |
| CloudWatch alarms (4, two with 2-metric math) | $0.10 per metric | ~$1 |
| S3 gateway endpoint, SSM parameters, ASG group metrics | free | $0 |
| Test pool, idle | | $0 |
| **Fixed, with both AMIs set** | | **~$1,760 + S3 + NAT traffic** |
| Fixed, foundation only (no AMI yet) | | ~$40 + S3 |

Running test hosts cost ~$0.784/h each (`c8gd.4xlarge`). At the maxima (4 build + 16 test, all running) the pools
cost ~$17.25/h, about $12,600 a month: the ASG maxima are the spend cap. `build_warm_size=0` removes the $1,717.

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

1. **Foundation** (bucket, key, network, NAT, role, SSM parameters, no pools). Nothing else must exist first.

   ```bash
   PLAN_ONLY=1 infra/job-hosts/apply.sh     # review: only creates; the trust check warns once (role not there yet)
   infra/job-hosts/apply.sh                 # same plan; type "apply"
   ```

2. **Pools**, once slice 1 has built the AMIs (one per pool kind: the mempool differs) and the vCPU quota covers
   them. Arguments are saved to `job-hosts/prod.tfvars` in the state bucket only after an apply, so give them again:

   ```bash
   PLAN_ONLY=1 infra/job-hosts/apply.sh build_ami_id=ami-... test_ami_id=ami-...
   infra/job-hosts/apply.sh build_ami_id=ami-... test_ami_id=ami-...
   ```

   The build pool then starts its 2 warm hosts (the fixed cost above). To start smaller, add `build_warm_size=0`.

3. **Runtime config** (Cloudflare; this module does not touch it). Read the role ARN:

   ```bash
   tofu -chdir=infra/job-hosts/terraform output -raw host_role_arn
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
   "JOB_HOST_ROLE_ARNS": "arn:aws:iam::904534089871:role/camelrun-job-hosts-prod",
   ```

   The aws attestor refuses to run without `JOB_HOST_ROLE_ARNS`, `AGENT_PUBLIC_URL` and the rate limit, so all three
   go in together.

Later changes go the same way (`PLAN_ONLY=1` first). A plan that deletes or replaces anything is refused unless
`ALLOW_DESTROY` names each address, for example `ALLOW_DESTROY='aws_autoscaling_group.test[0]'`. Changing an AMI
updates the launch template in place; running hosts keep the old one until they are replaced.

## Tests

No AWS needed (mock providers):

```bash
cd infra/job-hosts/terraform
tofu init -backend=false && tofu validate && tofu fmt -check -recursive && tofu test
```

## Not covered here

- The AMIs (slice 1), the queue-depth metric and test-pool scaling policy (slice 8), and runtime-side alarms on
  heartbeat loss and stuck leases (slice 8).
- Credentials for the runtime to presign snapshot and output uploads into the bucket (slice 5): whatever signs them
  needs `s3:PutObject` under `snapshots/`/`outputs/` and `kms:GenerateDataKey` on `images_kms_key_arn`.
