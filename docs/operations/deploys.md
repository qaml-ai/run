# Deploys and infrastructure changes

How code and settings reach the hosted runtime (the ECS service `camelai-agent-runtime`, AWS account `904534089871`,
`us-west-2`). How a rollout replaces tasks without cutting turns is in [Architecture](architecture.md) and
[`infra/terraform/README.md`](../../infra/terraform/README.md#deploying); this page is what to do.

## Every green main commit deploys itself

1. A push to `main` runs **CI** (`.github/workflows/ci.yml`). Its `publish` job pushes the commit's ARM64 image to ECR
   as `camelai-agent-runtime:<first 12 characters of the SHA>`.
2. When CI finishes, **Deploy** (`.github/workflows/deploy.yml`) starts from `workflow_run`. It deploys only when that
   CI run succeeded and was a `push` (a PR's CI, or a failed run, shows as a Deploy run with conclusion `skipped`).
3. Deploy assumes the GitHub OIDC role in `infra/terraform/github-deploy.tf` (only the `production` environment of
   this repository may), builds the image itself only if ECR lacks it, and runs `infra/ecs-deploy.sh <tag>`.

`infra/ecs-deploy.sh` registers a task definition revision that copies the family's **latest** revision and swaps the
image, rolls the service, waits (up to 30 minutes) until every new task is healthy in the target group, fails if the
circuit breaker rolled back, and checks `/healthz` through Cloudflare. It does not wait for old tasks to stop: they
retire in the background once their turns reach a step boundary (up to 20 minutes), so `rolloutState` stays
`IN_PROGRESS` well after the job is green.

### Superseded commits are skipped

CI runs finish out of order, so a green run can arrive after a newer commit has shipped. Before deploying, the job
reads the image tag the service runs and, if that commit already contains this one
(`git merge-base --is-ancestor <this> <live>`), logs `Production already runs <live>, which includes <this>; not
deploying` and stops: production is never rolled back by a late CI run. Deploys also share the concurrency group
`deploy-production` without cancelling: one rollout at a time, in order. GitHub keeps at most one run waiting in a
group, so when several commits land during a rollout the waiting run is replaced by the newest one, and the
intermediate commits never deploy on their own.

### Following a deploy

```sh
gh run list -R qaml-ai/run --workflow deploy.yml -L 5        # recent deploys and their conclusions
aws ecs describe-services --region us-west-2 --cluster camelai-agent-runtime --services camelai-agent-runtime \
  --query 'services[0].deployments[].[status,rolloutState,runningCount,taskDefinition]'
aws ecs describe-task-definition --region us-west-2 --task-definition camelai-agent-runtime \
  --query 'taskDefinition.containerDefinitions[0].image' --output text    # the latest revision's image
```

The latest revision is not always the running one (Terraform may have registered a newer one; see below). The
running image is the service's `taskDefinition`:

```sh
aws ecs describe-task-definition --region us-west-2 --query 'taskDefinition.containerDefinitions[0].image' --output text \
  --task-definition "$(aws ecs describe-services --region us-west-2 --cluster camelai-agent-runtime \
    --services camelai-agent-runtime --query 'services[0].taskDefinition' --output text)"
```

## Deploying by hand

```sh
infra/ecs-deploy.sh          # build this checkout (arm64), push, deploy
infra/ecs-deploy.sh <tag>    # deploy an image already in ECR, e.g. a 12-character commit SHA
```

- **Don't overlap.** Check `gh run list` first. Starting a manual deploy (or a script's "roll the service now") while
  a CI deploy is rolling makes the two fight: one sees the other's deployment as primary and reports a rollback. If a
  deploy is running, let it finish, or let the automatic deploy carry your change.
- A build from a checkout with uncommitted changes under `src`, `shared`, `console`, `package.json` or `Dockerfile` is
  tagged `<sha>-dirty-<time>`. The next CI deploy replaces it (its commit cannot be an ancestor of a dirty tag).
- **Redeploy the same commit**: run the Deploy workflow by hand (`gh workflow run deploy.yml -R qaml-ai/run`), which
  deploys the head of `main` without the ancestry check.

## Rolling back

```sh
infra/ecs-deploy.sh <older tag>
```

ECR keeps the last 30 images (`runtime.tf`), so a tag older than that is gone: build it from its commit instead
(`git checkout <sha> && infra/ecs-deploy.sh`). The next green main commit deploys again and undoes a rollback, so to
keep it, revert the change on `main`: the revert's own deploy then holds. Migrations are not undone by an older image
(see [Migrations](migrations.md)): an image older than the database's newest migration must still work with it, which
the expand-only rule there guarantees.

## Settings changes ship with a deploy

Task settings that aren't secret (`runtime_env` and the derived environment in `infra/terraform/ecs.tf`, CPU and
memory) live in Terraform. Applying such a change registers a new task definition revision with the image from
`runtime_image_tag`, but the service keeps running the old revision (`ignore_changes = [task_definition]`). The next
deploy, by hand or from CI, copies that newer revision and swaps in its own image, so:

- to ship a settings change now, deploy the running tag: `infra/ecs-deploy.sh <running tag>`;
- otherwise the next main commit ships it. Don't apply a task definition change you are not ready to ship.

Secrets are not in the task definition: the runtime reads them from Secrets Manager (the tenants secret every 60 s,
the others at startup). The scripts that store a startup-read secret (`infra/azure-openai.sh`,
`infra/github-oauth.sh`, `infra/google-oauth.sh`) force-roll the service themselves.

## Applying Terraform

Every apply is a saved plan you have read, made with production's private settings.

```sh
cd infra/terraform
tofu init
aws s3 cp s3://camelai-terraform-state-904534089871/agent-runtime/prod.tfvars prod.auto.tfvars   # every time
tofu plan -out=tfplan
tofu show -json tfplan | jq -r '.resource_changes[] | select(.change.actions != ["no-op"])
  | "\(.change.actions | join(",")) \(.address)"'                                    # what changes, one per line
tofu apply tfplan
```

`prod.auto.tfvars` is gitignored and loaded without `-var-file`. Without it a plan turns production's optional
features off, and tasks started from that revision can fail at boot. If you change one of its settings, upload the
file back in the same sitting:
`aws s3 cp prod.auto.tfvars s3://camelai-terraform-state-904534089871/agent-runtime/prod.tfvars`.

What to check in a plan:

- **Only your change.** List the changed addresses (above) and compare them with what your change should touch. Any
  other `update` or `replace` means the state, the live resources or `prod.auto.tfvars` differ from what you
  assumed: stop and find out why. Cloudflare's IP ranges are read at each plan, so an
  `aws_vpc_security_group_ingress_rule.alb_cloudflare[...]` to add or remove can be Cloudflare's doing, not drift.
- **No destroys** you did not intend. The state bucket, the RDS instance and the core secrets have `prevent_destroy`,
  so a plan that would delete them fails; everything else, a DNS record or an SNS subscription among them, does not.
- **The task definition's environment.** A change to `aws_ecs_task_definition.runtime` is a replacement (a new
  revision). Compare its environment with the running revision's:

  ```sh
  tofu show -json tfplan | jq -r '.resource_changes[] | select(.address == "aws_ecs_task_definition.runtime")
    | .change.after.container_definitions | fromjson | .[0].environment[] | "\(.name)=\(.value)"' | sort > planned.env
  aws ecs describe-task-definition --region us-west-2 --query 'taskDefinition.containerDefinitions[0].environment[]' \
    --output json --task-definition "$(aws ecs describe-services --region us-west-2 --cluster camelai-agent-runtime \
      --services camelai-agent-runtime --query 'services[0].taskDefinition' --output text)" \
    | jq -r '.[] | "\(.name)=\(.value)"' | sort > running.env
  diff running.env planned.env
  ```

  The diff should be the variables your change adds or changes. A variable missing from `planned.env` usually means
  `prod.auto.tfvars` was not fetched.
- **Plan freshness.** `tofu apply tfplan` refuses a plan whose state changed since; plan again. Only one person
  applies at a time (the state lock is an object next to the state).

After an apply that changed the task definition, ship it (above) and watch `/healthz` and the alarms for a few
minutes. `CLOUDFLARE_API_TOKEN` with DNS edit on both zones is needed to plan at all; see
[`infra/terraform/README.md`](../../infra/terraform/README.md#prerequisites).
