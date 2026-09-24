# Code executor hosts

`js_exec` code is model-written, so treat it as hostile. With executors configured,
the runtime no longer runs it on its own host. It runs on separate EC2 hosts, each
execution in its own fresh gVisor sandbox with no network, a read-only root and
nothing from the host mounted. The hosts hold no provider keys, tenant data or
agent state, sit in private subnets without internet, and reach only the
runtime's callback port and AWS's VPC endpoints.

```text
runtime (agents.camelai.dev)                   executor host (private subnet, ASG)
  agent process: executeCode()                   agent-executor.service (user agent-executor)
    ── POST /execute {code, tools, callback} ──▶    src/executor/server.ts
    ◀─ NDJSON: output events, then result|error ─     per execution: sudo sandbox run <uuid>
  callback listener :8791                                runsc run: fresh gVisor sandbox
    ◀─ POST /internal/executions/:id/tools ──────          node sandbox-child.ts (stdin/stdout NDJSON)
       Bearer <per-execution token>                          QuickJS/WASM (same limits)
    validate + quota (same code as local) → ToolBridge
```

- The runtime authenticates to executors with a bearer token kept in Secrets
  Manager (`camelai/agent-runtime/executor-token`). Executors read it with their
  instance role at startup and re-read it every five minutes, or early when an
  unknown token arrives (at most every 30s). After a rotation the previous token
  is still accepted for 15 minutes, so rotating needs no restart on either side.
- Each execution gets a fresh random callback capability. It reaches only that
  execution's tools, and only until the execution's deadline or its end,
  whichever comes first. The runtime keeps a hash of it and nothing else.
- Every tool call goes through the same validation and quotas as local codemode:
  schema checks, the 256-call limit, 32 concurrent calls, the per-result and
  total transfer limits, and output limits. A compromised executor can't get
  past any of them.
- When the runtime aborts or times out an execution, it disconnects, and the
  executor kills that execution's sandbox. The executor also kills it after the
  deadline plus 2s, even if the runtime never disconnects.

## One sandbox per execution

The executor service runs on the host under systemd as the unprivileged
`agent-executor` user. It never runs guest code itself. For each execution it
runs `sudo -n /usr/local/libexec/agent-executor/sandbox run <uuid>` (the helper
is [`sandbox.sh`](sandbox.sh)). That is all the sudoers rule
([`agent-executor.sudoers`](agent-executor.sudoers)) lets it run, apart from
`sandbox kill <uuid>`.

The helper is root-owned, and it alone decides what a sandbox gets. It writes an
OCI bundle under `/run/agent-executor/bundles/<uuid>` and runs `runsc run` with:

| | |
|---|---|
| root | the runtime image's filesystem, read-only (`/opt/agent-executor/sandbox/rootfs`, in a root-only directory the executor's user cannot even list) |
| writable | a 64 MiB tmpfs at `/tmp`, which is also `HOME`, `TMPDIR` and the working directory |
| network | `--network=none`: loopback only |
| user | uid 1000, no capabilities, `noNewPrivileges` |
| environment | `PATH`, `HOME`, `TMPDIR`, `NODE_ENV` only |
| limits | cgroup memory 512 MiB (no swap), 1 CPU, 128 pids, 256 open files; Node heap 256 MiB |
| mounts | `/proc` and the tmpfs; nothing from the host |

The executor chooses nothing but the sandbox's id, so a guest that took over
the executor process still cannot ask for a mount, a network or a larger limit.
Host-wide overrides of the limits go in the root-owned
`/etc/agent-executor/sandbox.env` (`MEMORY_MB`, `HEAP_MB`, `CPU_PERCENT`,
`PIDS`, `TMP_MB`, `RUNSC_FLAGS`).

The code child talks to the executor over its stdin/stdout, one JSON message per
line, because no IPC channel crosses the sandbox boundary. The protocol is the
same one the runtime relays, so streaming output and tool callbacks work as
before. The child sends everything else it might print to stderr, which goes to
the executor's log.

A sandbox dies when:
- the execution ends, the runtime disconnects, or the deadline plus 2s passes:
  the executor closes the child's stdin and runs `sandbox kill <uuid>`. The
  user cannot signal sudo, so the helper does the killing.
- the helper gets SIGTERM, for example when systemd stops the service: its trap
  kills and deletes the sandbox and removes the bundle.
- the service (re)starts: `sandbox gc`, run as root, deletes every sandbox and
  bundle a previous run left behind.

In development and tests, `AGENT_EXECUTOR_SANDBOX` defaults to `process`, a
plain child process with a fixed environment and a private temp directory.
[`test-sandbox.sh`](test-sandbox.sh) runs `tests/executor.test.ts` against real
gVisor sandboxes instead (see [Testing](#testing)).

## Hosts

Executor hosts are an Auto Scaling group that Terraform (`infra/terraform`)
builds from the AMI below and the user-data template.

- **AMI** ([`ami.pkr.hcl`](ami.pkr.hcl), built by [`build-ami.sh`](build-ami.sh)):
  AL2023 arm64 with:
  - Docker, used only at first boot to pull the image;
  - `amazon-ecr-credential-helper`, the AWS CLI and the CloudWatch agent;
  - nftables, with sshd disabled and the SSM agent enabled;
  - gVisor, from a release pinned by date, verified against a pinned SHA-512
    and installed in `/usr/local/lib/gvisor`;
  - Node, pinned by version and SHA-256 and installed in `/opt/node`, for the
    executor service (the sandboxes use the image's own Node);
  - the `agent-executor` user, the helper, the sudoers rule, the unit and the
    logrotate config.

  The pins live in [`versions.env`](versions.env). The build instance needs
  internet access. Hosts never do.
- **Boot** ([`user-data.sh`](user-data.sh)): configures the CloudWatch agent,
  writes the egress rules and the executor's environment, pulls the image with
  the instance role, and exports its filesystem as the sandbox root, with a copy
  of `/app` for the executor itself. It then disables Docker (its socket is
  root-equivalent) and starts `agent-executor.service`.
- **Host firewall** (nftables, loaded by the unit on every start):
  - the executor's user may reach only loopback (DNS through the local
    resolver), IMDS (the instance role's credentials), TCP/8791 in
    `runtime_callback_cidr`, and TCP/443, which the security group narrows to
    the VPC endpoints;
  - no other non-root user reaches IMDS, and nothing is forwarded, so no
    container or sandbox path gets out even if one had a network;
  - port 8790 accepts connections from `runtime_callback_cidr` only.
- **Logs**: the executor's log (`/var/log/agent-executor/executor.log`: one line
  per execution with its outcome and duration, plus errors) and
  `cloud-init-output.log` go to CloudWatch Logs, in the streams
  `<instance-id>/executor` and `<instance-id>/boot`.
- **Access**: SSM Session Manager only. There is no SSH and no key pair.

### User-data template

`user-data.sh` is a Terraform `templatefile()` with exactly these variables. It
contains no secrets.

| Variable | Example | Used for |
|---|---|---|
| `region` | `us-west-2` | `AWS_REGION` for the executor's Secrets Manager client |
| `image` | `904534089871.dkr.ecr.us-west-2.amazonaws.com/camelai-agent-runtime:<tag>` | the full ECR URI of the runtime image; its filesystem is the sandbox root |
| `token_secret_arn` | `arn:aws:secretsmanager:…:secret:camelai/agent-runtime/executor-token-…` | `AGENT_EXECUTOR_TOKEN_SECRET_ARN` |
| `log_group` | `/camelai/agent-executor` | CloudWatch Logs group for the agent (Terraform creates it, with retention) |
| `runtime_callback_cidr` | `172.31.0.0/17` | an IPv4 CIDR covering the runtime tasks and the NLB's nodes: the only source accepted on :8790 (data and health checks), and the only destination for callbacks (:8791). Security groups make the exact cut |
| `max_concurrency` | `4` | `AGENT_EXECUTOR_MAX_CONCURRENCY`: executions per host; beyond it, 503 |

For sizing, each sandbox may use up to 512 MiB. A `t4g.small` (2 GiB) takes
about 3 at full use, and a `t4g.medium` about 6.

### What Terraform provides

- **Instance role**, with:
  - `secretsmanager:GetSecretValue` on the token secret;
  - `ecr:GetAuthorizationToken`, plus `ecr:BatchGetImage`,
    `ecr:GetDownloadUrlForLayer` and `ecr:BatchCheckLayerAvailability` on the
    repository;
  - `logs:CreateLogStream`, `logs:PutLogEvents` and `logs:DescribeLogStreams` on
    the log group;
  - `AmazonSSMManagedInstanceCore`.
- **Launch template**: IMDSv2 required, with a hop limit of 1.
- **VPC endpoints** (private DNS on):
  - interface endpoints for `ecr.api`, `ecr.dkr`, `secretsmanager`, `logs`,
    `ssm`, `ssmmessages` and `ec2messages`;
  - the `s3` gateway endpoint, because ECR serves image layers from S3.
- **Security groups**:
  - the executor group allows in TCP/8790 from the runtime, and out TCP/8791
    to the runtime plus TCP/443 to the endpoints' group and the S3 prefix list;
  - the runtime group allows in TCP/8791 from the executors.

### Rolling hosts

Hosts are immutable. A new runtime image or a new AMI changes the launch
template (the `image` variable or the AMI id). Roll it out with an instance
refresh:

```sh
aws autoscaling start-instance-refresh --auto-scaling-group-name camelai-agent-executor \
  --preferences '{"MinHealthyPercentage": 100, "InstanceWarmup": 120}'
```

A deploy of the runtime alone keeps the current executors. If you change
`src/executor`, `src/quickjs-sandbox.ts` or anything the code child imports,
roll the executors onto the new image too. To bump gVisor or Node:
1. Update `versions.env`.
2. Run `test-sandbox.sh`.
3. Run `build-ami.sh`.
4. Point Terraform at the new AMI and refresh the group.

## Runtime settings

| Variable | Where | Meaning |
|---|---|---|
| `AGENT_EXECUTOR_URL` | runtime | Comma-separated executor origins, e.g. `http://10.0.1.20:8790`. Each execution picks one at random. Unset means local execution. |
| `AGENT_EXECUTOR_TOKEN` | runtime; executor in development | At least 32 characters. Executors accept only this bearer token. |
| `AGENT_EXECUTOR_TOKEN_SECRET_ARN` | executor | Read the token from this secret (plain string) instead, and keep re-reading it. Needs `AWS_REGION`. |
| `AGENT_EXECUTOR_CALLBACK_URL` | runtime | Base URL executors use to reach the runtime's callback listener, e.g. `http://<runtime private IP>:8791`. |
| `AGENT_EXECUTOR_CALLBACK_PORT` | runtime | Callback listener port (default 8791). This listener is separate from the public one and is never exposed publicly. |
| `AGENT_EXECUTOR_SANDBOX` | executor | `runsc` (hosts; the unit sets it) or `process` (default: development and tests). |
| `AGENT_EXECUTOR_SANDBOX_HELPER` | executor | Path to the helper (default `/usr/local/libexec/agent-executor/sandbox`). |
| `PORT`, `HOST` | executor | Listen address. The unit sets `0.0.0.0:8790`. |
| `AGENT_EXECUTOR_MAX_CONCURRENCY` | executor | Concurrent executions per host (default 8). Beyond this, requests get a 503. |

## Testing

`tests/executor.test.ts` runs everywhere with the process launcher. It covers
the launcher contract: one execution per sandbox; kill on abort, timeout or
disconnect, with no process or work directory left behind; and no inherited
environment. It also covers token rotation.

`infra/executor/test-sandbox.sh` needs Docker (Docker Desktop on an arm64 Mac
works) and installs nothing outside containers. It sets up a privileged Linux
container like a host, with the pinned runsc, the helper, the sudoers rule, the
unprivileged user, and the runtime image as the sandbox root. Then it:

1. checks that the executor's user can run the helper and nothing else;
2. probes a sandbox built from the helper's own config, for a read-only root,
   loopback only, uid 1000, no capabilities, its own pid namespace, no host
   paths and a fixed environment;
3. measures startup;
4. runs `tests/executor.test.ts` with `AGENT_EXECUTOR_SANDBOX=runsc`, then
   checks that no sandbox or bundle is left.

Startup, measured on Docker Desktop on an Apple-silicon Mac (systrap platform),
from launch to the result of `return 1`:

| | p50 | p90 |
|---|---|---|
| gVisor sandbox, one at a time | ~500 ms | ~540 ms |
| gVisor sandbox, 8 at once | ~590 ms | ~620 ms |
| the same child without gVisor | ~210 ms | ~225 ms |

gVisor adds about 300 ms per execution. On a `t4g` host it will differ, so
measure it there before relying on these numbers. If the latency matters, the
launcher interface leaves room for a pool of pre-started sandboxes, each still
used once.

## Known limits

- **No health-aware routing in the runtime.** Each execution picks an executor
  URL at random. Put an internal load balancer in front of the group, or list
  healthy hosts.
- **Executors are shared across tenants.** Each execution now has its own
  sandbox, so executions cannot see each other. The executor process holds the
  bearer token in memory and can use the instance role. To get either, a guest
  would have to escape QuickJS, then Node, then gVisor, and then reach a
  different host user. Per-tenant pools would narrow this further.
- **DNS.** The local resolver answers the executor's user, and Route 53
  Resolver answers public names even without internet access. A compromised
  executor could therefore leak data over DNS. A Route 53 Resolver DNS Firewall
  on the executor subnets would close that. Sandboxes have no network, so they
  cannot use DNS at all.
- **Plain HTTP inside the VPC.** Traffic between runtime and executors stays
  within security groups and the host firewall. Add TLS if the path ever leaves
  the VPC.
- **Startup latency**: see [Testing](#testing).
