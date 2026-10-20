# camelRun task boot experiment (2026-10-20)

Draft branch `deploy-boot-speed`, baseline `aba52e72b83e`. Production access was read-only: ECS task/service metadata, bounded CloudWatch log queries, ECR image metadata, and GitHub Actions logs. No task launches, execution, database access, secret reads, infrastructure plans/applies, or production deployments.

## Production baseline

Latest [Deploy run](https://github.com/qaml-ai/run/actions/runs/39354435259): the `infra/ecs-deploy.sh` step took **84 seconds**, versus **113 seconds** in the [previous run](https://github.com/qaml-ai/run/actions/runs/39338146194). This sample does not consistently reproduce the reported ~140 seconds. The job itself took 98 seconds (runner/job overhead is separate).

All times below are seconds since each task's `createdAt`. Raw, sanitized observations are in `production-before.json`.

| Task suffix | Pull begins | Pull ends | App listening (log timestamp) | ECS startedAt | Observed healthy interval |
| --- | ---: | ---: | ---: | ---: | ---: |
| 495370c5 | 11.926 | 20.059 | 24.416 | 35.162 | (33.842, 43.399] |
| 282ccca9 | 14.825 | 23.678 | 29.858 | 35.877 | (31.586, 41.642] together with 448cbd69 |
| 448cbd69 | 15.127 | 22.214 | 27.144 | 36.480 | (31.586, 41.642] together with 282ccca9 |

The healthy intervals come from the deploy's polls, not exact ALB transition timestamps: first task was healthy by 01:38:37.691Z (none at 01:38:28.134Z); all three by 01:38:57.638Z (only one at 01:38:47.582Z). ECS registration events identify the first task versus the later pair, but the pair's individual health times are unavailable. ECS `startedAt` is a control-plane observation and occurs **after** the app's listening log here; it must not be interpreted as the process's exact start. Existing logs have no process-start/migration/model timings, so those production stage durations cannot be recovered precisely. No historical per-target health transition API was used or assumed.

Pulling took **7.087–8.853 s**; pull completion to listening took **4.357–6.180 s**. Service deployment creation to the last pair's task creation took **38.632 s**. Scheduling, provisioning, ECS observations, and health/poll timing dominate; removing model loading cannot alone save tens of seconds. Poll cycles take roughly 9–10 seconds with the serial AWS CLI calls and 5-second sleep.

Startup inspection: `nodeDeps` loads tenants/secrets, checks the V8/parser sandbox, prepares the DB pool, and discovers the task address. `createNode` completes migrations (including the existing cross-task advisory lock/retry behavior), storage, ownership/heartbeat, HTTP routes, voice setup, DB notification subscription, and managed Discord configuration before binding HTTP. Managed Discord connections and ordinary background services do not gate listening. Previously it also awaited the turn model host. The host readiness previously covered Silero but **did not await Smart Turn's actual load**. The ONNX files total **~10.6 MiB**; the ~190 MB estimate describes loaded/native voice memory, not model file downloads at startup. Models are bundled in the image, not fetched at boot.

## Changes

- The node creates a deferred model host; workers first start after the HTTP socket binds, or on an earlier voice client if one exists. Model readiness includes both Silero and Smart Turn. Model failure keeps the existing restart/backoff policy.
- Cold inference uses the existing bounded timeouts (VAD 500 ms, end-of-turn 1 s) and TurnTaker's level/silence fallback; a session is not rejected because its models are warming. Subsequent calls use the loaded models without recreating the session. Explicit smart mode stays enabled while temporarily unavailable. Models disabled by configuration still retain their previous behavior.
- Migrations, sandbox validation, and cluster/storage prerequisites remain before HTTP binding. No early unconditional health endpoint bypasses those prerequisites.
- `startup_stage` logs contain only stage names, elapsed milliseconds and process uptime. `listening` gains uptime. Voice workers report individual model loading times. These allow an approved rollout to distinguish imports/process setup, secrets, migrations, sandbox checks, storage, ownership, notifications, managed Discord configuration and model loading.
- Production dependencies install and prune in their own Docker stage. Runtime gets only that dependency tree; development dependencies and compiler stages were **already excluded**. Remove dependency source maps, type declarations, and ONNX build/header metadata, preserving executable code/native binaries/licenses. Both architecture image CI jobs now execute real VAD and Smart Turn inference from the pruned image.

## Local measurements

ARM64 Docker on this Mac, containers capped at **1 CPU / 2 GiB** (matching task resources), warm image layers, isolated local Postgres on port 55882, production launcher/isolation, voice and both turn models enabled. Five alternating before/after pairs per run, excluding the first pair that migrates the disposable database. Original node/inference/worker files are mounted for the before variant. No provider requests. The first run overlapped local test/build work; the repeat finished after those checks. These are small local samples, not Fargate startup or p95 estimates.

| Measurement | Before | After |
| --- | ---: | ---: |
| Image size (Docker uncompressed) | 521,218,356 bytes | 462,405,503 bytes |
| Listening process uptime, first run median | 2,280 ms | 2,075 ms |
| Listening process uptime, repeat median | 1,794 ms | 1,797 ms |

The image saves **58,812,853 bytes (56.1 MiB / 11.3%)** uncompressed. Production's baseline registry image is **170,252,513 bytes (162.4 MiB)** compressed; the new compressed ECR size is **unmeasured**, because no ECR image was pushed. The local boot results show **no consistent total-boot improvement**; do not select only the favorable first run. Raw trials and stage timings are in `local-first.json` and `local.json`.

Repeat-run after medians: sandbox 141 ms, no-op migrations 85 ms, ownership 7 ms, notifications 83 ms, Silero session creation 30 ms, Smart Turn session creation 27 ms, full background model host ready 247 ms (includes worker/native-module startup). Tenants from a local file took 2 ms; local secret/database configuration and storage setup rounded to 0 ms. These local substitutes do not measure AWS Secrets Manager/RDS network latency. There is no model inference warm-up before listening; actual model inference remains demand driven.

Expected effect: remove the model-host wait (a fraction of a second locally) from readiness, plus potentially a modest pull/unpack saving from the smaller image. **No defensible claim of a 20–50 second saving or consistently ≤90-second deploys.** Latest production already met 90 seconds; earlier runs did not. Production after times and first-call production voice behavior remain unmeasured under the read-only constraint.

## SOCI decision

Do **not** add SOCI in this draft. The image is below AWS's suggested >250 MiB compressed evaluation range and its full pull is already 7–9 seconds. AWS notes that SOCI's initial overhead can exceed a normal pull for small images. Adding containerd/soci index creation, registry writes and index compatibility handling without an authorized Fargate comparison would not be a measured improvement. If later tested, generate/push the supported index alongside each immutable published image, including the CI publish path (Deploy normally reuses that image), and compare complete task readiness plus cold voice latency. Index creation time on Deploy must also count toward the target.

Sources: [Fargate pull behavior](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-pull-behavior.html), [Fargate SOCI support and restrictions](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-tasks-services.html), [AWS explanation of small-image overhead](https://aws.amazon.com/blogs/containers/under-the-hood-lazy-loading-container-images-with-seekable-oci-and-aws-fargate/).

## Validation and rollout

Local: full TypeScript typecheck; 13 turn-model/segmentation/lifecycle tests including lazy close/load and cold-client recovery; 6 voice session/media tests; node integration test; ARM64 production image build and real model inference. The initial node integration run failed because this new worktree lacked its V8 executable; rerunning with the existing native build at the expected path passed. GitHub CI validates the full suite and both production-image architectures on the PR.

**No Terraform/OpenTofu apply is needed.** If Miguel elects to keep this work, merge/release via the normal reviewed path, publish the image, and roll ECS with it. Then run `python3 infra/boot-timeline.py` and compare process/stage timings and deployment-step wall time across several rollouts; verify a cold first voice session, fallback, and recovery. Do not deploy this branch directly to production as part of this experiment.

Reproduce locally (only against a disposable DB):

```sh
mkdir -p /tmp/camelrun-boot-original/src/voice/turns
git show aba52e72b83e:src/node.ts > /tmp/camelrun-boot-original/src/node.ts
git show aba52e72b83e:src/voice/turns/inference.ts > /tmp/camelrun-boot-original/src/voice/turns/inference.ts
git show aba52e72b83e:src/voice/turns/inference-worker.ts > /tmp/camelrun-boot-original/src/voice/turns/inference-worker.ts
# Build the baseline image from the baseline Dockerfile and the new image from this branch.
python3 scripts/bench-boot.py --before camelrun-boot:baseline --after camelrun-boot:after \
  --baseline-source /tmp/camelrun-boot-original --database-port 55882
```
