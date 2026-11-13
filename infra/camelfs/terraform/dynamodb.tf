# The tables of option C (camel-fs.md §1.2 as revised for C; the #fs-c-vs-d view) and of the compute control
# plane on the same tier (camel-fs-compute.md §3, K4): refs, leases and fences as conditional writes; trees and
# commits as items (L74); lineages as the tenant's registry; the notify/event outbox; hosts and VMs. On-demand (no
# capacity to size; adaptive capacity splits a hot item collection across partitions because there is no LSI),
# point-in-time recovery (35 days), deletion protection, encrypted with the AWS-owned key (no KMS calls per
# request; nothing here is a secret).
#
# Key schemas (fs-infra ↔ proto-block, fs-architect, wf-durable, 2026-11-13; the attribute names below are the
# whole contract this module imposes — everything else about an item is the daemon's):
#   objects     lineage (S) + id (S)    id = "<kind>/<sha1>" (t/ trees, k/ commits); b (git bytes), generation
#   refs        lineage (S) + name (S)  version, tree, root?, owner, expiresAt?, holder, leaseEpoch, leaseDeadline,
#                                        updatedAt; the tier checks the move rules first (camel-fs-files.md §6:
#                                        a new commit's parents[0] is current; a move to a recorded commit is a
#                                        fast-forward via is-ancestor), then one conditional UpdateItem on
#                                        version = :expect plus the lease state the writer believes in
#   lineages    lineage (S)             tenant, kind, default branch, ignore list; the mark: markedBytes,
#                                        markedAt, writtenSince (option B, #973)
#   deliveries  shard (S) + id (S)      the outbox: a watched ref's move, vm.* and usage.* events, written in the
#                                        same TransactWriteItems as the state change; shard = "0".."15" so claimers
#                                        Query a bounded set of partitions (a lineage key would leave pending work
#                                        unfindable without an index), then claim with a conditional claimedUntil
#   hosts       pool (S) + host (S)     bootEpoch, shape, slots, free, vms, features, lastSeenAt, draining
#   vms         id (S)                  the phase row: phase, host, lineage, ref, leaseEpoch, timestamps, result, payer
# No DynamoDB TTL anywhere: a ref's expiresAt, an object's generation and a delivery's claim are the service's to
# act on, never the store's (a TTL delete would move a ref without a CAS and without a log).

locals {
  tables = {
    objects = {
      hash_key  = "lineage"
      range_key = "id"
      purpose   = "trees and commits - git bytes by lineage and id"
    }
    refs = {
      hash_key  = "lineage"
      range_key = "name"
      purpose   = "refs leases and fences - one conditional write per move"
    }
    lineages = {
      hash_key  = "lineage"
      range_key = null
      purpose   = "lineage registry - tenant kind quota default branch last mark"
    }
    deliveries = {
      hash_key  = "shard"
      range_key = "id"
      purpose   = "notify and vm/usage event outbox - written with the state change"
    }
    hosts = {
      hash_key  = "pool"
      range_key = "host"
      purpose   = "VM hosts - capacity heartbeats draining - compute control K4"
    }
    vms = {
      hash_key  = "id"
      range_key = null
      purpose   = "VM phase rows - compute control K4"
    }
  }
  table_names = { for table in keys(local.tables) : table => "${var.name}-${var.env}-${table}" }
}

resource "aws_dynamodb_table" "camelfs" {
  for_each = local.tables

  name         = local.table_names[each.key]
  billing_mode = "PAY_PER_REQUEST"
  table_class  = "STANDARD"
  hash_key     = each.value.hash_key
  range_key    = each.value.range_key

  attribute {
    name = each.value.hash_key
    type = "S"
  }

  dynamic "attribute" {
    for_each = each.value.range_key == null ? [] : [each.value.range_key]
    content {
      name = attribute.value
      type = "S"
    }
  }

  point_in_time_recovery {
    enabled = true
  }

  deletion_protection_enabled = true

  tags = { Name = local.table_names[each.key], Purpose = each.value.purpose }

  lifecycle {
    # Every ref, every tree, every VM's phase. Nothing here is reproducible.
    prevent_destroy = true
    # DynamoDB refused the first apply's tag values (2026-11-13): commas, parentheses and colons are out. Letters,
    # digits, spaces, dashes and slashes only.
    precondition {
      condition     = can(regex("^[A-Za-z0-9 /-]+$", each.value.purpose))
      error_message = "A table's Purpose tag may contain only letters, digits, spaces, dashes and slashes (DynamoDB tag values)."
    }
  }
}
