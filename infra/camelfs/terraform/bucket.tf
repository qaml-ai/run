# The object store: blobs, chunks, roots, tree-size sidecars, packs and search shards, and (until L74 closes) trees
# and commits, keyed <lineage>/<kind>/<hash> exactly as camelfsd writes them today (camelfsd/README.md, "Durability
# and lineage scope"); plus two prefixes outside any lineage: <guest_image_prefix>guest/<sha256>… (the
# content-addressed guest image, K1, put by CI) and results/<lineage>/<vm> (VM results, up to tens of MiB, K4, put
# by the HOST that ran the VM, read by the tier, expired after results_expiry_days by prefix).
#
# A NEW bucket, not the prototype's camel-fs-proto-904534089871-usw2. The prototype bucket was made by hand,
# unencrypted beyond SSE-S3, unversioned, holds measurement runs under arbitrary prefixes, and is written by the
# proto host's role, which must not hold production data; it is slated for deletion with the prototype. Nothing
# in it is needed: every lineage starts from a commit the runtime makes.
#
# SSE-KMS with the bucket's own key and S3 bucket keys (one data key per bucket, so 144 M writes a month cost
# cents of KMS, not hundreds of dollars); versioning with noncurrent expiry (an overwrite of an immutable object
# is a no-op, so versions only ever hold a deleted object until the GC's mistake would have shown); daily
# Inventory into inventory/ (camel-fs.md §1.9: the GC enumerates from Inventory, not from a List). No lifecycle
# expiry of live objects: deletion is the collector's decision, never the bucket's.

locals {
  bucket_name = "${var.name}-${var.env}-${var.account_id}"
}

resource "aws_kms_key" "objects" {
  description             = "SSE-KMS for s3://${local.bucket_name}"
  enable_key_rotation     = true
  deletion_window_in_days = 30

  # The account administers the key; IAM policies grant its use (the api and host roles: through S3 only).
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AccountAdministers"
      Effect    = "Allow"
      Principal = { AWS = "arn:aws:iam::${var.account_id}:root" }
      Action    = "kms:*"
      Resource  = "*"
    }]
  })
}

resource "aws_kms_alias" "objects" {
  name          = "alias/${local.bucket_name}"
  target_key_id = aws_kms_key.objects.key_id
}

resource "aws_s3_bucket" "objects" {
  bucket = local.bucket_name

  lifecycle {
    # Every lineage's objects. Nothing here is reproducible.
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_ownership_controls" "objects" {
  bucket = aws_s3_bucket.objects.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "objects" {
  bucket                  = aws_s3_bucket.objects.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "objects" {
  bucket = aws_s3_bucket.objects.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "objects" {
  bucket = aws_s3_bucket.objects.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.objects.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "objects" {
  bucket = aws_s3_bucket.objects.id

  # Versioning must be on before noncurrent-version rules mean anything.
  depends_on = [aws_s3_bucket_versioning.objects]

  # Deleted (and, should it ever happen, overwritten) objects stay recoverable for noncurrent_expiry_days, then go.
  rule {
    id     = "noncurrent-versions"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_expiry_days
    }
    expiration {
      expired_object_delete_marker = true
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 2
    }
  }

  # VM results (results/<lineage>/<vm>, K4; wf-durable, 2026-11-14): a prefix of their own, so expiry is a prefix
  # rule and no writer has to tag. The runtime has read them within the job's lifetime; after results_expiry_days
  # they go.
  rule {
    id     = "results"
    status = "Enabled"
    filter {
      prefix = "results/"
    }
    expiration {
      days = var.results_expiry_days
    }
    noncurrent_version_expiration {
      noncurrent_days = 1
    }
  }

  # Inventory reports are derived data; the GC reads the latest.
  rule {
    id     = "inventory"
    status = "Enabled"
    filter {
      prefix = "inventory/"
    }
    expiration {
      days = var.inventory_expiry_days
    }
    noncurrent_version_expiration {
      noncurrent_days = 1
    }
  }
}

# Daily inventory of every current object (key, size, last modified, storage class) into inventory/ in the same
# bucket: the GC's enumeration (camel-fs.md §1.9) and the storage-by-kind figures of §1.12.
resource "aws_s3_bucket_inventory" "objects" {
  bucket = aws_s3_bucket.objects.id
  name   = "daily"

  included_object_versions = "Current"
  optional_fields          = ["Size", "LastModifiedDate", "StorageClass"]

  schedule {
    frequency = "Daily"
  }

  destination {
    bucket {
      format     = "Parquet"
      bucket_arn = aws_s3_bucket.objects.arn
      prefix     = "inventory"
      encryption {
        sse_kms {
          key_id = aws_kms_key.objects.arn
        }
      }
    }
  }
}

resource "aws_s3_bucket_policy" "objects" {
  bucket = aws_s3_bucket.objects.id
  # The public access block must exist first, or S3 may judge the policy against an unblocked bucket.
  depends_on = [aws_s3_bucket_public_access_block.objects]

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "TLSOnly"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource  = [aws_s3_bucket.objects.arn, "${aws_s3_bucket.objects.arn}/*"]
        Condition = { Bool = { "aws:SecureTransport" = "false" } }
      },
      # S3 Inventory writes its reports here (the documented destination policy, scoped to this bucket as source).
      {
        Sid       = "InventoryReports"
        Effect    = "Allow"
        Principal = { Service = "s3.amazonaws.com" }
        Action    = "s3:PutObject"
        Resource  = "${aws_s3_bucket.objects.arn}/inventory/*"
        Condition = {
          ArnLike      = { "aws:SourceArn" = aws_s3_bucket.objects.arn }
          StringEquals = { "aws:SourceAccount" = var.account_id, "s3:x-amz-acl" = "bucket-owner-full-control" }
        }
      },
    ]
  })
}
