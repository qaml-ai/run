#!/usr/bin/env bash
# Backup restore drill for the control database (infra/terraform/rds.tf), and the S3 half of a real restore.
# See docs/operations/backup-restore.md.
#
#   infra/restore-drill.sh                       dry run: check backups and versioning, print the plan; changes nothing
#   EXECUTE=1 infra/restore-drill.sh             restore a point in time to a new drill instance, verify it, delete it
#   infra/restore-drill.sh cleanup               delete drill instances, the check's task definitions and log group
#   infra/restore-drill.sh s3-undelete <time>    dry run: count the state bucket's delete markers made after <time>
#                                                on objects the database refers to (UNDELETE_KEYS, a jq regex)
#   EXECUTE=1 infra/restore-drill.sh s3-undelete <time>   remove them (a real restore only, after the database's)
#
# Settings: RESTORE_TIME=<ISO 8601 UTC> (default: the latest restorable time), DRILL_CLASS=<db class> (default: the
# source's, so the timing is production's), KEEP=1 (keep the drill instance; `cleanup` deletes it later).
#
# The drill never touches the production instance or the service: it reads the instance's automated backups into a
# new single-AZ instance, <name>-drill-<time>, tagged purpose=restore-drill, in the same subnets and security group
# (private; reachable from the runtime's task security group only). It sets that instance's master password to a
# random one (the restored copy's own, never production's secret), then runs a one-off Fargate task with the
# service's image and network, its own task definition (<name>-restore-drill: no task role, no secrets, none of the
# runtime's environment) and log group (/ecs/<name>-restore-drill, 1-day retention), which connects over TLS and
# reads the schema version, row counts and how recent the newest rows are. The password goes in as an environment
# override, which anyone who can describe the task sees: it opens only the drill instance, deleted at the end.
# Cleanup deletes only instances whose name starts with <name>-drill- and that carry the tag.
#
# Needs: aws (the runtime's account), jq, openssl.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
source "$here/config.sh"
aws() { command aws --region "$REGION" "$@"; }

cluster=$NAME
service=$NAME
source_db=$NAME-control
drill_prefix=$NAME-drill-
family=$NAME-restore-drill
log_group=/ecs/$family
bucket=$NAME-state
prefix=agents/

[[ "$(aws sts get-caller-identity --query Account --output text)" == "$ACCOUNT_ID" ]] || { echo "AWS credentials are not for $ACCOUNT_ID." >&2; exit 1; }

drills() {
  aws rds describe-db-instances --query "DBInstances[?starts_with(DBInstanceIdentifier, '$drill_prefix')].[DBInstanceIdentifier, DBInstanceArn]" --output text
}

delete_drill() {
  local id=$1 arn
  [[ $id == "$drill_prefix"* ]] || { echo "refusing to delete $id: not a drill instance" >&2; return 1; }
  arn=$(aws rds describe-db-instances --db-instance-identifier "$id" --query 'DBInstances[0].DBInstanceArn' --output text)
  [[ "$(aws rds list-tags-for-resource --resource-name "$arn" --query "TagList[?Key=='purpose'].Value | [0]" --output text)" == restore-drill ]] \
    || { echo "refusing to delete $id: no purpose=restore-drill tag" >&2; return 1; }
  aws rds delete-db-instance --db-instance-identifier "$id" --skip-final-snapshot --delete-automated-backups >/dev/null
  echo "deleting $id (a few minutes, in the background)"
}

if [[ ${1:-} == cleanup ]]; then
  while read -r id _; do [[ -n $id ]] && delete_drill "$id"; done < <(drills)
  for arn in $(aws ecs list-task-definitions --family-prefix "$family" --query 'taskDefinitionArns[]' --output text); do
    aws ecs deregister-task-definition --task-definition "$arn" >/dev/null
    aws ecs delete-task-definitions --task-definitions "$arn" >/dev/null || true
  done
  aws logs delete-log-group --log-group-name "$log_group" 2>/dev/null || true
  echo "deleted $family's task definitions and log group"
  exit 0
fi

if [[ ${1:-} == s3-undelete ]]; then
  since=${2:?usage: infra/restore-drill.sh s3-undelete <ISO 8601 UTC time the database was restored to>}
  since_epoch=$(date -u -d "$since" +%s 2>/dev/null || date -u -j -f %Y-%m-%dT%H:%M:%SZ "$since" +%s)
  work=$(mktemp -d -t restore-drill.XXXXXX)
  trap 'rm -rf "$work"' EXIT
  echo "==> Delete markers under s3://$bucket/$prefix made after $since (deletes the restored database may still refer to)"
  # Only the latest delete marker of a key hides it. The CLI applies --query to each page: one array per page.
  aws s3api list-object-versions --bucket "$bucket" --prefix "$prefix" --output json \
    --query 'DeleteMarkers[?IsLatest].{Key: Key, VersionId: VersionId, LastModified: LastModified}' > "$work/markers.json"
  # By default only what the database indexes and S3 alone does not describe: content chunks, volumes' trees and
  # snapshots, and agents' history chunks (agent_history_chunks). A log (transcript, journal) is its segments in S3 and
  # its tail rows in the database; its old segments are deleted when folded into a snapshot, which S3 still has, so
  # they need nothing. A deleted agent's or session's logs come back only with UNDELETE_KEYS='.' (everything).
  keys=${UNDELETE_KEYS:-'^agents/(chunks|volumes)/|^agents/sessions/[^/]+/history/'}
  jq -s --argjson since "$since_epoch" --arg keys "$keys" '[.[] | .[]? | select(.Key | test($keys)) | select((.LastModified | sub("\\.[0-9]+"; "") | sub("\\+00:00$"; "Z") | fromdateiso8601) > $since)]' "$work/markers.json" > "$work/after.json"
  count=$(jq length "$work/after.json")
  echo "    $count matching $keys (by area:)"
  jq -r '.[].Key | split("/")[1]' "$work/after.json" | sort | uniq -c | sed 's/^/     /'
  noncurrent=$(aws s3api get-bucket-lifecycle-configuration --bucket "$bucket" --query "Rules[?Status=='Enabled'].NoncurrentVersionExpiration.NoncurrentDays | [0]" --output text)
  echo "    Noncurrent versions are kept $noncurrent days; a key deleted longer ago than that is gone."
  if [[ ${EXECUTE:-} != 1 ]]; then
    echo "Dry run: nothing changed. EXECUTE=1 removes these $count delete markers, so the objects' last versions are current again."
    exit 0
  fi
  echo "==> Removing $count delete markers"
  jq -c '[.[] | {Key, VersionId}] | _nwise(1000) | {Objects: ., Quiet: true}' "$work/after.json" | while read -r batch; do
    aws s3api delete-objects --bucket "$bucket" --delete "$batch" --query 'Errors' --output json
  done
  echo "Done."
  exit 0
fi

[[ -z ${1:-} ]] || { echo "unknown command $1 (cleanup, s3-undelete <time>, or none)" >&2; exit 2; }

echo "==> Source $source_db"
read -r class multi_az subnet_group security_group retention latest protection < <(aws rds describe-db-instances --db-instance-identifier "$source_db" \
  --query 'DBInstances[0].[DBInstanceClass, MultiAZ, DBSubnetGroup.DBSubnetGroupName, VpcSecurityGroups[0].VpcSecurityGroupId, BackupRetentionPeriod, LatestRestorableTime, DeletionProtection]' --output text)
earliest=$(aws rds describe-db-instance-automated-backups --db-instance-identifier "$source_db" --query 'DBInstanceAutomatedBackups[0].RestoreWindow.EarliestTime' --output text)
snapshots=$(aws rds describe-db-snapshots --db-instance-identifier "$source_db" --snapshot-type automated --query 'length(DBSnapshots)' --output text)
echo "    class $class, Multi-AZ $multi_az, deletion protection $protection"
echo "    backups kept $retention days ($snapshots automated snapshots); restorable from $earliest to $latest"
(( retention >= 7 )) || echo "!!  backup retention under 7 days"

echo "==> State bucket s3://$bucket"
versioning=$(aws s3api get-bucket-versioning --bucket "$bucket" --query Status --output text)
noncurrent=$(aws s3api get-bucket-lifecycle-configuration --bucket "$bucket" --query "Rules[?Status=='Enabled'].NoncurrentVersionExpiration.NoncurrentDays | [0]" --output text)
echo "    versioning $versioning; noncurrent versions kept $noncurrent days"
[[ $versioning == Enabled ]] || echo "!!  versioning is not on: deleted objects cannot be brought back"
[[ $noncurrent == None ]] || (( noncurrent >= retention )) || echo "!!  objects are kept fewer days ($noncurrent) than backups ($retention): an old restore point may refer to objects already gone"

restore_time=${RESTORE_TIME:-}
drill_class=${DRILL_CLASS:-$class}
drill=$drill_prefix$(date -u +%Y%m%d%H%M)
point=${restore_time:-latest restorable time ($latest)}
echo "==> Plan"
echo "    restore $source_db at $point to $drill ($drill_class, single-AZ, private, subnet group $subnet_group, security group $security_group)"
echo "    set its master password to a random one; run the check task ($family) in the service's network; print what it finds"
[[ ${KEEP:-} == 1 ]] && echo "    keep $drill (KEEP=1): 'infra/restore-drill.sh cleanup' deletes it" || echo "    delete $drill (no final snapshot)"
existing=$(drills | awk '{print $1}' | tr '\n' ' ')
[[ -z $existing ]] || echo "    note: drill instances already exist: $existing('cleanup' deletes them)"

if [[ ${EXECUTE:-} != 1 ]]; then
  echo "Dry run: nothing changed. EXECUTE=1 runs the drill (about 20 to 40 minutes; the instance costs cents)."
  exit 0
fi

started=$(date +%s)
point_args=(--use-latest-restorable-time)
[[ -n $restore_time ]] && point_args=(--restore-time "$restore_time")
echo "==> Restoring to $drill"
aws rds restore-db-instance-to-point-in-time --source-db-instance-identifier "$source_db" --target-db-instance-identifier "$drill" \
  "${point_args[@]}" --db-instance-class "$drill_class" --no-multi-az --db-subnet-group-name "$subnet_group" \
  --vpc-security-group-ids "$security_group" --no-publicly-accessible --no-deletion-protection --no-copy-tags-to-snapshot \
  --tags Key=purpose,Value=restore-drill --query 'DBInstance.DBInstanceIdentifier' --output text
cleanup_hint() { echo "!! The drill stopped early. 'infra/restore-drill.sh cleanup' deletes $drill once it is available." >&2; }
trap cleanup_hint ERR

wait_available() {
  local status pending
  while true; do
    read -r status pending < <(aws rds describe-db-instances --db-instance-identifier "$drill" \
      --query 'DBInstances[0].[DBInstanceStatus, length(keys(PendingModifiedValues))]' --output text)
    [[ $status == available && $pending == 0 ]] && return 0
    sleep 30
  done
}
wait_available
restored=$(date +%s)
echo "    available after $(( (restored - started) / 60 )) min"

password=$(openssl rand -hex 24)
echo "==> Setting the drill instance's master password"
err=$(mktemp -t restore-drill.XXXXXX)
if ! aws rds modify-db-instance --db-instance-identifier "$drill" --master-user-password "$password" --apply-immediately >/dev/null 2>"$err"; then
  # A copy of an instance whose password RDS manages may come back managed too: turn that off for the copy alone.
  grep -qi manage "$err" || { cat "$err" >&2; exit 1; }
  aws rds modify-db-instance --db-instance-identifier "$drill" --no-manage-master-user-password --master-user-password "$password" --apply-immediately >/dev/null
fi
sleep 30
wait_available
read -r host port user database < <(aws rds describe-db-instances --db-instance-identifier "$drill" \
  --query 'DBInstances[0].[Endpoint.Address, Endpoint.Port, MasterUsername, DBName]' --output text)

# The service's network, image and execution role, read from it (nothing is changed there).
read -r task_definition subnets security_groups public_ip < <(aws ecs describe-services --cluster "$cluster" --services "$service" \
  --query 'services[0].[taskDefinition, join(`,`, networkConfiguration.awsvpcConfiguration.subnets), join(`,`, networkConfiguration.awsvpcConfiguration.securityGroups), networkConfiguration.awsvpcConfiguration.assignPublicIp]' --output text)
read -r image execution_role < <(aws ecs describe-task-definition --task-definition "$task_definition" \
  --query 'taskDefinition.[containerDefinitions[0].image, executionRoleArn]' --output text)

aws logs create-log-group --log-group-name "$log_group" 2>/dev/null || true
aws logs put-retention-policy --log-group-name "$log_group" --retention-in-days 1

# What the check reads: the schema version, row counts of the tables that hold money and identity, and the newest
# rows' age against the restore point (a restore of the latest point should be seconds to minutes behind).
check=$(cat <<'JS'
import pg from "pg";
import { readFileSync } from "node:fs";
const client = new pg.Client({ host: process.env.PGHOST, port: Number(process.env.PGPORT), user: process.env.PGUSER, password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE, ssl: { ca: readFileSync("/etc/ssl/rds-global-bundle.pem", "utf8"), rejectUnauthorized: true }, connectionTimeoutMillis: 20_000 });
await client.connect();
const one = async (sql) => (await client.query(sql)).rows[0];
const out = { migrations: await one("select count(*)::int as applied, max(name) as latest from schema_migrations"), counts: {} };
for (const table of ["tenants", "agents", "volumes", "credit_accounts", "credit_ledger", "end_user_ledger", "usage", "model_attempts", "schedules"]) {
  try { out.counts[table] = (await one(`select count(*)::bigint as n from ${table}`)).n; } catch (error) { out.counts[table] = `error: ${error.message}`; }
}
const newest = await one("select (select max(created_at) from credit_ledger) as ledger, (select max(updated_at) from model_attempts) as attempts");
out.newest = { creditLedger: newest.ledger && new Date(Number(newest.ledger)).toISOString(), modelAttempts: newest.attempts && new Date(Number(newest.attempts)).toISOString() };
await client.end();
console.log(JSON.stringify(out, null, 2));
console.log("RESTORE_CHECK_OK");
JS
)
container=$(jq -n --arg image "$image" --arg group "$log_group" --arg region "$REGION" --arg check "$check" '[{
  name: "restore-drill", image: $image, essential: true,
  command: ["node", "--input-type=module", "-e", $check],
  linuxParameters: { initProcessEnabled: true },
  logConfiguration: { logDriver: "awslogs", options: { "awslogs-group": $group, "awslogs-region": $region, "awslogs-stream-prefix": "restore-drill" } }
}]')
revision=$(aws ecs register-task-definition --family "$family" --requires-compatibilities FARGATE --network-mode awsvpc \
  --cpu 256 --memory 512 --runtime-platform cpuArchitecture=ARM64,operatingSystemFamily=LINUX --execution-role-arn "$execution_role" \
  --container-definitions "$container" --query 'taskDefinition.taskDefinitionArn' --output text)
overrides=$(jq -n --arg h "$host" --arg p "$port" --arg u "$user" --arg d "$database" --arg w "$password" \
  '{ containerOverrides: [{ name: "restore-drill", environment: [
    { name: "PGHOST", value: $h }, { name: "PGPORT", value: $p }, { name: "PGUSER", value: $u }, { name: "PGDATABASE", value: $d }, { name: "PGPASSWORD", value: $w } ] }] }')
echo "==> Checking the restored database from the service's network"
task=$(aws ecs run-task --cluster "$cluster" --launch-type FARGATE --task-definition "$revision" \
  --network-configuration "awsvpcConfiguration={subnets=[$subnets],securityGroups=[$security_groups],assignPublicIp=$public_ip}" \
  --overrides "$overrides" --query 'tasks[0].taskArn' --output text)
aws ecs wait tasks-stopped --cluster "$cluster" --tasks "$task"
exit_code=$(aws ecs describe-tasks --cluster "$cluster" --tasks "$task" --query 'tasks[0].containers[0].exitCode' --output text)
log=$(aws logs get-log-events --log-group-name "$log_group" --log-stream-name "restore-drill/restore-drill/${task##*/}" \
  --start-from-head --query 'events[].message' --output text | tr '\t' '\n')
echo "$log"
checked=$(date +%s)

trap - ERR
if [[ ${KEEP:-} == 1 ]]; then
  echo "==> Keeping $drill (KEEP=1); 'infra/restore-drill.sh cleanup' deletes it"
else
  echo "==> Deleting $drill"
  delete_drill "$drill"
fi

echo "==> Result"
echo "    restore point: $point"
echo "    restore took $(( (restored - started) / 60 )) min; restored to checked $(( (checked - started) / 60 )) min in all"
if [[ $exit_code == 0 && $log == *RESTORE_CHECK_OK* ]]; then
  echo "PASS: the backup restores and the restored database answers."
else
  echo "FAIL: the check task exited $exit_code." >&2
  exit 1
fi
