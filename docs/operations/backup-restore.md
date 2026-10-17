# Backups and restore

What the hosted runtime keeps, how to bring it back, and the drill that proves it. The runtime's state is in two
places, restored differently:

- **Control database** (Postgres on RDS, `infra/terraform/rds.tf`): tenants, accounts, credit and usage ledgers,
  ownership leases, schedules, outboxes, the history and volume indexes, logs' tail rows (records not yet compacted
  into S3). Multi-AZ with a synchronous standby, so an instance or AZ failure is a failover (about a minute, absorbed
  by RDS Proxy; [Architecture](architecture.md)), not a restore. A restore is for data lost to a bad migration, an
  operator mistake or corruption.
- **State bucket** (`s3://camelai-agent-runtime-state/agents/`, `infra/terraform/state-bucket.tf`): transcripts' and
  journals' segments, history chunks, content chunks (`chunks/`), volumes' trees and snapshots. S3 is regional and
  durable; what can be lost is a delete, by the runtime (storage GC, account deletion) or by hand.

## What is kept

| | How | Window |
|---|---|---|
| Database, point in time | RDS automated backups (daily snapshot at 09:00 UTC plus transaction logs) | 7 days (`backup_retention_period`), to within about 5 minutes of now (`LatestRestorableTime`) |
| Database, on deletion | final snapshot `camelai-agent-runtime-control-final`; deletion protection and `prevent_destroy` | until deleted by hand |
| Bucket objects | versioning; an overwritten or deleted object's last version is kept | 30 days (`expire-noncurrent-versions`), then gone |
| Performance Insights | not a backup | 7 days |

Not kept: a copy in another region or account (an `us-west-2` outage or a compromised account loses both), and
anything an agent held only in memory (streamed deltas, usage not yet flushed, which a drain flushes).

## Drill

`infra/restore-drill.sh` restores the database to a throwaway instance and checks it, without touching production.
Run it after a change to backups, the schema's size or the instance class, and at least quarterly.

```sh
infra/restore-drill.sh                         # dry run: backup window, versioning, the plan; changes nothing
EXECUTE=1 infra/restore-drill.sh               # restore the latest point to <name>-drill-<time>, check it, delete it
EXECUTE=1 RESTORE_TIME=2026-10-17T12:00:00Z KEEP=1 infra/restore-drill.sh   # a chosen point; keep the copy to inspect
infra/restore-drill.sh cleanup                 # delete drill instances and the check's task definitions
```

The check runs as a one-off Fargate task in the service's network (the drill instance is private, like the real
one), with its own task definition and no task role. It prints the latest migration, row counts of the tables that
hold money and identity, and the newest ledger and model-attempt rows, which show how far behind the restore point
the copy is. `PASS` means the backup restores and answers; the elapsed time is the database half of the recovery time.

## Restoring production

A restore loses every database write after the restore point: credit purchases, ledger entries, sign-ups, schedule
changes. Stripe keeps purchases (reconcile them from its dashboard and `billing_events` afterwards); nothing else
does. Pick the latest point before the damage.

1. **Stop writes.** Scale the service to 0 so nothing writes to the damaged database while the copy is made and so
   no node holds leases from the old one: `aws ecs update-service --cluster camelai-agent-runtime --service
   camelai-agent-runtime --desired-count 0` (autoscaling's minimum brings tasks back; suspend it first with
   `aws application-autoscaling register-scalable-target --service-namespace ecs --resource-id
   service/camelai-agent-runtime/camelai-agent-runtime --scalable-dimension ecs:service:DesiredCount
   --suspended-state DynamicScalingInSuspended=true,DynamicScalingOutSuspended=true,ScheduledScalingSuspended=true`
   and `--min-capacity 0`). Clients see 5xx from here until step 6.
2. **Restore to a new instance.** `EXECUTE=1 KEEP=1 RESTORE_TIME=<point> infra/restore-drill.sh` makes and checks the
   copy (single-AZ, the copy's own password). Inspect it from a one-off task, as the drill's check does.
3. **Swap it in.** The runtime reads the instance's managed secret and connects through RDS Proxy to
   `camelai-agent-runtime-control`, so the copy takes that identifier: rename the damaged instance
   (`aws rds modify-db-instance --db-instance-identifier camelai-agent-runtime-control --new-db-instance-identifier
   camelai-agent-runtime-control-damaged --apply-immediately`; deletion protection stays on it), then the copy to
   `camelai-agent-runtime-control`, then make it Multi-AZ, deletion protected and managed-password again
   (`--multi-az --deletion-protection --manage-master-user-password --apply-immediately`). The managed secret's ARN
   changes: apply Terraform (`infra/terraform`, a saved plan you have read; it should show the task definition's
   `AGENT_DATABASE_SECRET_ARN`, the task role and the proxy's auth changing, and nothing replaced) and redeploy the
   running tag (`infra/ecs-deploy.sh <tag>`). The proxy's target follows the instance it was registered with, not
   the name: `aws rds describe-db-proxy-targets --db-proxy-name camelai-agent-runtime-control` must show
   `camelai-agent-runtime-control` `AVAILABLE`; if it shows the damaged one, `deregister-db-proxy-targets` it and
   `register-db-proxy-targets --db-instance-identifiers camelai-agent-runtime-control` (the same plan may do this).
   The instance endpoint (`AGENT_DATABASE_LISTEN_HOST`) is derived from the identifier, so it names the copy.
4. **Bring back what the database still refers to.** Objects deleted after the restore point (storage GC deletes
   content chunks a day after nothing refers to them; history pages are rewritten; volumes purged) may be referred
   to by the restored database. `infra/restore-drill.sh s3-undelete <point>` counts the delete markers made since,
   on content chunks, volumes and history chunks; `EXECUTE=1` removes them, so the objects' last versions are current
   again. It does not touch transcripts' and journals' segments: S3 has those as they are now, ahead of the
   database, and folding old segments into snapshots needs no undo. An agent deleted after the point keeps its row
   but not its logs unless `UNDELETE_KEYS=.` brings everything back. Only versions from the last 30 days exist.
5. **Hold storage GC.** Set `storage_gc_dry_run = true` in `prod.tfvars` (apply, redeploy) before tasks start, and keep
   it for a week: the restored `chunk_touches` and `gc_candidates` predate chunks written after the point, and a
   dry run's `storage_gc_dry_run` log lines show what it would remove before it is trusted again.
6. **Start the service.** Restore the scalable target's minimum (`--min-capacity 2`) and resume scaling; tasks start,
   run migrations (none, unless the point predates one), and take agents as clients reconnect. Agents' turns that
   ran after the point resume from their transcripts in S3.
7. **Afterwards.** Reconcile Stripe purchases after the point; compare `credit_accounts` with the ledger for tenants
   active since; delete `camelai-agent-runtime-control-damaged` once nothing more is needed from it (turn off its
   deletion protection first).

## Gaps

- No cross-region or cross-account copy. RDS automated backup replication to another region (Postgres supports it)
  and S3 replication with a separate account's bucket would cover a region outage or a compromised account.
- Backups are kept 7 days, objects 30: a mistake noticed after a week cannot be undone from the database.
- Step 3 has not been rehearsed against a staging stack; the drill covers steps 2 and 4's dry run.
