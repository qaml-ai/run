# S3 bucket for agent state (AGENT_STORAGE=s3), plus the runtime's
# access to it. See shared/s3-storage.ts: documents are <prefix>/<key>.json
# written with If-Match / If-None-Match, logs are <prefix>/<key>.log/<segment>.

resource "aws_s3_bucket" "state" {
  bucket = var.state_bucket_name

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_ownership_controls" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  # Versioning must be on before noncurrent-version rules mean anything.
  depends_on = [aws_s3_bucket_versioning.state]

  rule {
    id     = "expire-noncurrent-versions"
    status = "Enabled"
    filter {}

    # Overwritten and deleted state stays recoverable for this long.
    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_version_days
    }
    # Drop delete markers once no versions remain behind them.
    expiration {
      expired_object_delete_marker = true
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

# Get/Put/Delete on objects under the prefix, List on the prefix. Conditional
# writes (PutObject with If-None-Match or If-Match) need only s3:PutObject; no
# statement here denies or restricts on the s3:if-none-match / s3:if-match keys.
# DeleteObjects (batch) is authorized per key by s3:DeleteObject.
# The ECS task role (ecs.tf) gets the same statements.
locals {
  state_bucket_statements = [
    {
      Sid      = "StateObjects"
      Effect   = "Allow"
      Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
      Resource = "${aws_s3_bucket.state.arn}/${var.state_prefix}/*"
    },
    {
      Sid      = "ListStatePrefix"
      Effect   = "Allow"
      Action   = "s3:ListBucket"
      Resource = aws_s3_bucket.state.arn
      Condition = {
        StringLike = { "s3:prefix" = ["${var.state_prefix}/*"] }
      }
    },
  ]
}

