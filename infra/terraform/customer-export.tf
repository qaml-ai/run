# The role that writes one-time customer data exports (camelAI's scripts/org-export.ts, ORG_EXPORT.md) into a
# customer's own S3 bucket. The customer's bucket policy names this role's ARN, so the export never needs their
# credentials or ours in their account. It can only put objects under each destination's prefix (and use the
# destination's KMS key, when the bucket requires SSE-KMS): no reads, no listing, no deletes, and nothing of ours.
#
# Destinations are customer data, so set customer_export_destinations and customer_export_assumer_arns in
# prod.auto.tfvars (README "Plan and apply"), not in this repository. The role exists only while at least one
# destination does; remove a destination once its export is delivered. Apply before sending the ARN: S3 refuses a
# bucket policy that names a principal that does not exist yet.

locals {
  customer_export_enabled = length(var.customer_export_destinations) > 0
  customer_export_kms_keys = compact([
    for destination in values(var.customer_export_destinations) : destination.kms_key_arn
  ])
}

resource "aws_iam_role" "customer_export" {
  count       = local.customer_export_enabled ? 1 : 0
  name        = "${var.name}-customer-export"
  description = "Writes one-time customer data exports into customers' S3 buckets"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { AWS = var.customer_export_assumer_arns }
    }]
  })
}

resource "aws_iam_role_policy" "customer_export" {
  count = local.customer_export_enabled ? 1 : 0
  name  = "customer-export"
  role  = aws_iam_role.customer_export[0].name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat([
      {
        Sid      = "PutExports"
        Effect   = "Allow"
        Action   = ["s3:PutObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"]
        Resource = [for destination in values(var.customer_export_destinations) : "arn:aws:s3:::${destination.bucket}/${destination.prefix}*"]
      },
      ], length(local.customer_export_kms_keys) > 0 ? [
      {
        Sid      = "ExportBucketKeys"
        Effect   = "Allow"
        Action   = ["kms:GenerateDataKey", "kms:Decrypt"]
        Resource = local.customer_export_kms_keys
      },
    ] : [])
  })
}
