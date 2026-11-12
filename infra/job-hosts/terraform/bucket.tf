# Base images, warm snapshots and large job outputs (docs/design/job-hosts-plan.md, "AWS resources").
# Layout: images/<base image>/..., snapshots/<snapshot id>/..., outputs/<job id>/...
# Hosts read images/ and snapshots/ with their instance role; writes (snapshots, outputs) go through URLs the
# runtime presigns (slice 5), so the host role has no write access here.

locals {
  images_bucket_name = "camelrun-job-images-${var.env}"
}

resource "aws_kms_key" "images" {
  description             = "SSE-KMS for s3://${local.images_bucket_name}"
  enable_key_rotation     = true
  deletion_window_in_days = 30

  # The account administers the key and IAM policies grant its use (the host role: decrypt through S3 only).
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

resource "aws_kms_alias" "images" {
  name          = "alias/${local.images_bucket_name}"
  target_key_id = aws_kms_key.images.key_id
}

resource "aws_s3_bucket" "images" {
  bucket = local.images_bucket_name
}

resource "aws_s3_bucket_ownership_controls" "images" {
  bucket = aws_s3_bucket.images.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "images" {
  bucket                  = aws_s3_bucket.images.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "images" {
  bucket = aws_s3_bucket.images.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "images" {
  bucket = aws_s3_bucket.images.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.images.arn
    }
    # One data key per bucket rather than per object: far fewer KMS calls (and charges) for multi-GB images.
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "images" {
  bucket = aws_s3_bucket.images.id

  # Versioning must be on before noncurrent-version rules mean anything.
  depends_on = [aws_s3_bucket_versioning.images]

  rule {
    id     = "outputs"
    status = "Enabled"
    filter {
      prefix = "outputs/"
    }
    expiration {
      days = var.outputs_expiry_days
    }
    noncurrent_version_expiration {
      noncurrent_days = 1
    }
  }

  # The runtime's snapshot GC (slice 5) tags a snapshot unreferenced=true when no job_snapshots row points at it;
  # S3 deletes it this long after it was written. A referenced snapshot carries no tag and is kept.
  rule {
    id     = "unreferenced-snapshots"
    status = "Enabled"
    filter {
      and {
        prefix = "snapshots/"
        tags   = { unreferenced = "true" }
      }
    }
    expiration {
      days = var.snapshot_expiry_days
    }
  }

  # Overwritten and deleted objects anywhere stay recoverable this long, then go.
  rule {
    id     = "noncurrent-versions"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = var.snapshot_expiry_days
    }
    expiration {
      expired_object_delete_marker = true
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 2
    }
  }
}

resource "aws_s3_bucket_policy" "images" {
  bucket = aws_s3_bucket.images.id
  # The public access block must exist first, or S3 may judge the policy against an unblocked bucket.
  depends_on = [aws_s3_bucket_public_access_block.images]

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "TLSOnly"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.images.arn, "${aws_s3_bucket.images.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
}
