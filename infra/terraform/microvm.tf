# The AWS provider does not manage MicroVM images here. scripts/microvm-image.sh
# builds them from this source bucket after these prerequisites have been applied.
variable "microvm_enabled" {
  type    = bool
  default = false
}
variable "microvm_image_arn" {
  type    = string
  default = ""
}
variable "microvm_image_version" {
  type    = string
  default = ""
}

resource "aws_s3_bucket" "microvm_source" {
  count  = var.microvm_enabled ? 1 : 0
  bucket = "${var.name}-microvm-source-${var.account_id}"
}
resource "aws_s3_bucket_public_access_block" "microvm_source" {
  count                   = var.microvm_enabled ? 1 : 0
  bucket                  = aws_s3_bucket.microvm_source[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_server_side_encryption_configuration" "microvm_source" {
  count  = var.microvm_enabled ? 1 : 0
  bucket = aws_s3_bucket.microvm_source[0].id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}
resource "aws_cloudwatch_log_group" "microvm_build" {
  count             = var.microvm_enabled ? 1 : 0
  name              = "/${var.name}/microvm-build"
  retention_in_days = 30
}
resource "aws_iam_role" "microvm_build" {
  count = var.microvm_enabled ? 1 : 0
  name  = "${var.name}-microvm-build"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "lambda.amazonaws.com" }
      Condition = { StringEquals = { "aws:SourceAccount" = var.account_id } }
    }]
  })
}
resource "aws_iam_role_policy" "microvm_build" {
  count = var.microvm_enabled ? 1 : 0
  role  = aws_iam_role.microvm_build[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["s3:GetObject"], Resource = "${aws_s3_bucket.microvm_source[0].arn}/*" },
      { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.microvm_build[0].arn}:*" }
    ]
  })
}
resource "aws_iam_role_policy" "microvm_runtime" {
  count = var.microvm_enabled && var.microvm_image_arn != "" ? 1 : 0
  role  = aws_iam_role.task.id
  name  = "microvm-computers"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["lambda:RunMicrovm"], Resource = var.microvm_image_arn },
      { Effect = "Allow", Action = ["lambda:GetMicrovm", "lambda:SuspendMicrovm", "lambda:ResumeMicrovm", "lambda:TerminateMicrovm", "lambda:CreateMicrovmAuthToken"], Resource = [var.microvm_image_arn, "arn:aws:lambda:${var.region}:${var.account_id}:microvm:*"] },
      { Effect = "Allow", Action = ["lambda:ListMicrovms"], Resource = "*" }
    ]
  })
}
locals {
  microvm_environment = var.microvm_enabled && var.microvm_image_arn != "" ? merge({
    AGENT_COMPUTER_PROVIDER    = "lambda"
    AGENT_MICROVM_IMAGE        = var.microvm_image_arn
    AGENT_MICROVM_REGION       = var.region
    AGENT_MICROVM_IDLE_SECONDS = "300"
  }, var.microvm_image_version != "" ? { AGENT_MICROVM_IMAGE_VERSION = var.microvm_image_version } : {}) : {}
}
output "microvm_source_bucket" {
  value = try(aws_s3_bucket.microvm_source[0].id, null)
}
output "microvm_build_role_arn" {
  value = try(aws_iam_role.microvm_build[0].arn, null)
}
output "microvm_build_log_group" {
  value = try(aws_cloudwatch_log_group.microvm_build[0].name, null)
}
