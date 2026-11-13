# The three tables of option C (camel-fs.md §1.2 as revised for C; the #fs-c-vs-d view): refs, leases and fences
# as conditional writes; trees and commits as items (L74); lineages as the tenant's registry. On-demand (no
# capacity to size; adaptive capacity splits a hot lineage's item collection across partitions because there is
# no LSI), point-in-time recovery (35 days), deletion protection, encrypted with the AWS-owned key (no KMS
# calls per request; the data is content-addressed objects and ref pointers, no secrets).
#
# Key schemas (fs-infra ↔ proto-block, 2026-11-13; the attribute names below are the whole contract this module
# imposes — everything else about an item is the daemon's):
#   objects   lineage (S) + id (S)    id = "<kind>/<sha1>" (t/ trees, k/ commits); payload, generation, createdAt
#   refs      lineage (S) + name (S)  version, tree, root?, owner, expiresAt?, holder, leaseEpoch, leaseDeadline,
#                                      updatedAt; a move is one conditional UpdateItem whose condition is the
#                                      parent rule (version = parents[0]) and the lease state the writer believes in
#   lineages  lineage (S)             tenant, kind, quota, default branch, ignore list, last mark
# No DynamoDB TTL anywhere: a ref's expiresAt and an object's generation are the service's to act on, never the
# store's (a TTL delete would move a ref without a CAS and without a log).

locals {
  tables = {
    objects = {
      hash_key  = "lineage"
      range_key = "id"
      purpose   = "trees and commits (git bytes, by lineage and id)"
    }
    refs = {
      hash_key  = "lineage"
      range_key = "name"
      purpose   = "refs, leases and fences (one conditional write per move)"
    }
    lineages = {
      hash_key  = "lineage"
      range_key = null
      purpose   = "lineage registry (tenant, kind, quota, default branch, last mark)"
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
    # Every ref and every tree. Nothing here is reproducible.
    prevent_destroy = true
  }
}
