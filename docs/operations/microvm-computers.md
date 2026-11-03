# Lambda managed computers

Managed computers use AWS Lambda MicroVMs by default. `AGENT_COMPUTER_PROVIDER=boat`
selects Boat for new sessions. Each session records its provider; existing sessions
keep their provider, cleanup and metering when the setting changes. Keep Boat's
platform key available until its last session ends.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `AGENT_MANAGED_COMPUTERS` | `off` | Enable managed computers |
| `AGENT_COMPUTER_PROVIDER` | `lambda` | `lambda` or `boat` |
| `AGENT_MICROVM_IMAGE` | none | Built image ARN; required for Lambda sessions |
| `AGENT_MICROVM_IMAGE_VERSION` | latest | Pin a built image version |
| `AGENT_MICROVM_REGION` | `AWS_REGION`, then `AWS_DEFAULT_REGION`, then `us-west-2` | Region of the image |
| `AGENT_MICROVM_IDLE_SECONDS` | `300` | Proxy inactivity before suspend, at least 60 seconds |
| `AGENT_PRICE_COMPUTER_HOUR_USD` | provider cost | Override the running hourly price; scales snapshot charges by the same ratio |

The image uses ARM64, 1 vCPU and 2 GiB. Do not change its resources without updating
`MICROVM_HOUR` and snapshot size in `src/computers/microvm.ts`. Lambda sessions have
fixed duration `min(leaseSeconds, 28800)`, including suspended time. Commands do not
extend them. Idle suspension preserves files and processes; proxy traffic resumes
them. Long commands run as jobs with repeated polls of at most 25 seconds, keeping
the proxy active. Commands and descendants in their process group end on timeout.

AWS credentials come from the runtime's default credential provider chain (the ECS
task role in production). The launch never supplies `executionRoleArn`. The build
role is only for building images; it is not a guest execution role. The agent gets
no runtime credentials. Tokens allow only port 8080 and expire within 60 minutes;
the runtime refreshes them one minute early. Do not expose the agent on a public
port outside the AWS authenticated proxy.

## Build and rollout

Production applies and image builds are performed by Miguel. From the repository:

1. Review `PLAN_ONLY=1 infra/apply.sh microvm_enabled=true`. Apply through
   `infra/apply.sh microvm_enabled=true` after reviewing the saved plan. This adds
   a private, encrypted source bucket, a build log group, and a build role trusted
   by `lambda.amazonaws.com` with `aws:SourceAccount` equal to our account. The
   role can read source objects and write streams in its own log group.
2. Use a CLI with the `lambda-microvms` service model. List managed images with
   `aws lambda-microvms list-managed-microvm-images` and select the ARM64 AL2023
   minimal base ARN. Export `AWS_REGION`, `MICROVM_BASE_IMAGE_ARN`, and the outputs
   `MICROVM_SOURCE_BUCKET`, `MICROVM_BUILD_ROLE_ARN`, `MICROVM_BUILD_LOG_GROUP`.
3. Run `CONFIRM=build scripts/microvm-image.sh`. It zips only `Dockerfile` and
   `agent.py`, uploads by content hash and creates an image. It waits for the exact
   version to build successfully, then prints its ARN and version. To update,
   also export `MICROVM_IMAGE_ARN` and run the same command. Review these scripts
   before adding the build to a deploy workflow. No image build runs automatically.
4. Review and apply `infra/apply.sh microvm_enabled=true microvm_image_arn=ARN
   microvm_image_version=VERSION`. This grants the runtime `lambda:RunMicrovm`
   on the image; `GetMicrovm`, `SuspendMicrovm`, `ResumeMicrovm`, `TerminateMicrovm`
   and `CreateMicrovmAuthToken` on the image and account/region MicroVM ARN pattern;
   and `ListMicrovms` on `*`. No runtime `iam:PassRole` or `TagResource` is added.
   The ownership mapping is in `managed_computers`, not mutable guest tags.
5. Keep `AGENT_MANAGED_COMPUTERS=on` in the runtime environment and deploy with the
   existing `infra/ecs-deploy.sh` workflow. The new environment ships with that
   deploy. Test a paid/internal account and a sub-agent, file transfers in both
   directions, a long job, idle suspend/resume, TTL and operator stop.

The operator building images needs S3 upload, image create/update/get-version/list
permissions and `iam:PassRole` limited to the build role and Lambda service. These
operator permissions are not attached to the runtime task.

The source archive installs Python, git, Node/npm, pip, Docker, iptables, network
and file utilities. It does not install `coreutils`: the minimal base already has
`coreutils-single`, which conflicts with it. The image build uses the base's public
internet access to install packages; the runtime's signed file transfers use curl
and public internet egress. UDP is unavailable except through the VM's DNS resolver.

## Metering and validation limits

The existing 30-second pass charges cumulative cost and settles end-user holds.
Lambda has no cost API. Observations are persisted under a row lock, including
running seconds, suspended seconds and observed suspend/resume counts. Terminal
machines remain billable until their last observation is charged. Duplicate passes
do not charge twice, and a runtime restart retains the cumulative totals.

Rates supplied for this implementation are $0.0000276944 per vCPU-second,
$0.0000036667 per GiB-second, snapshot writes $0.0038/GiB, reads $0.00155/GiB and
storage $0.08/GiB per 30-day month. The baseline running rate is $0.12609936/hour.
An explicit hourly override scales all components relative to this rate. Holds
reserve running time; actual settlement includes observed snapshot charges.

These are estimates from polling, not an AWS invoice reconciliation. A state
change is accounted at its observation; a complete suspend/resume cycle between
polls is invisible. Snapshot charges assume the image's full 2 GiB footprint.
Verify us-west-2 pricing, the IAM resource support for MicroVM actions, the built
image's actual resources and its Docker capabilities before production rollout.
This change was developed offline, so those live checks remain required. A guest
that suspends while the runtime is unavailable is still capped by AWS's fixed TTL.

Local checks: `python3 sandbox/microvm/test_agent.py`, `npm run typecheck`, and
`node --experimental-strip-types --test tests/microvm.test.ts`. The managed-computer
Postgres suite additionally covers the provider switch, sub-agent inheritance and
TTL termination. Build, IAM, suspension and transfer smoke tests require AWS access.
