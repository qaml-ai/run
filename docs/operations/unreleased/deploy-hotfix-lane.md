### Deploys: a hotfix lane, and never an older image over a newer one

A hand-run Deploy is now the hotfix lane: `gh workflow run deploy.yml -R qaml-ai/run -f sha=<commit>` (main's head
without `sha`) skips CI, uses CI's image or builds it, runs beside the automatic deploys instead of queuing behind
them, and logs the ECS rollout (see [CI and deploys](README.md#ci-and-deploys)). Automatic deploys no longer cancel a
hand-run one, and a newer commit's deploy cancels the older run's wait instead of queuing behind its whole rollout.
Every deploy compares its commit with production's primary deployment right before the update and follows a
deployment that already includes it, so an older commit never rolls over a newer one (`-f rollback=true` to do so on
purpose), and each run checks at the end that every running task runs its image. Run titles name the deployed commit:
a `workflow_run` run's own head SHA is main's head when CI finished, which made the deploy of #362 look like #368's.
