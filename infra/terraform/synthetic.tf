# The synthetic check (infra/synthetic/check.mjs): every 5 minutes a Lambda outside the VPC calls the public API as a
# customer does (GET /healthz, then one stateless run of a real model turn), through Cloudflare and the load balancer,
# and writes SyntheticChecks and SyntheticFailures. The -synthetic alarm pages when two checks in a row fail or none
# ran. It catches what /healthz cannot: a runtime that answers but cannot run a turn (2026-10-15's settings change).
#
# Off until synthetic_enabled. It runs as a tenants-file tenant of its own (synthetic_tenant), on the platform's keys,
# so it takes the platform's tenants' path and its runs are easy to tell apart. First make that tenant:
#   infra/tenant.sh add synthetic
# which stores its operator token at <secret_prefix>/operator-token/synthetic, the only secret the Lambda may read.
# A check costs one short model response (~$0.0003 on Haiku 5.5): ~$3 a month, and ~$0.10 of Lambda.

variable "synthetic_enabled" {
  description = "Run the synthetic check (synthetic.tf) every 5 minutes. Store its operator token in the synthetic secret first."
  type        = bool
  default     = false
}

variable "synthetic_tenant" {
  description = "The tenants-file tenant the synthetic check runs as (its operator token: <secret_prefix>/operator-token/<tenant>, from infra/tenant.sh add)."
  type        = string
  default     = "synthetic"
}

variable "synthetic_model" {
  description = "The model the synthetic check's run asks for (provider/model-id), or null for the tenant's default."
  type        = string
  default     = "anthropic/claude-haiku-5-5"
}

locals {
  synthetic        = var.synthetic_enabled ? 1 : 0
  synthetic_secret = "${var.secret_prefix}/operator-token/${var.synthetic_tenant}"
}

data "archive_file" "synthetic" {
  type        = "zip"
  source_file = "${path.module}/../synthetic/check.mjs"
  output_path = "${path.module}/.terraform/synthetic.zip"
}

data "aws_iam_policy_document" "synthetic_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "synthetic" {
  count              = local.synthetic
  name               = "${var.name}-synthetic"
  assume_role_policy = data.aws_iam_policy_document.synthetic_assume.json
}

# Its own logs and its tenant's operator token, nothing else.
resource "aws_iam_role_policy" "synthetic" {
  count = local.synthetic
  role  = aws_iam_role.synthetic[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.synthetic[0].arn}:*" },
      { Effect = "Allow", Action = "secretsmanager:GetSecretValue", Resource = "${local.secret_arn_prefix}/operator-token/${var.synthetic_tenant}-*" },
    ]
  })
}

resource "aws_cloudwatch_log_group" "synthetic" {
  count             = local.synthetic
  name              = "/aws/lambda/${var.name}-synthetic"
  retention_in_days = 14
}

resource "aws_lambda_function" "synthetic" {
  count            = local.synthetic
  function_name    = "${var.name}-synthetic"
  role             = aws_iam_role.synthetic[0].arn
  runtime          = "nodejs22.x"
  handler          = "check.handler"
  filename         = data.archive_file.synthetic.output_path
  source_code_hash = data.archive_file.synthetic.output_base64sha256
  timeout          = 150
  memory_size      = 256
  # One check at a time: a slow one never overlaps the next.
  reserved_concurrent_executions = 1
  environment {
    variables = merge({
      SYNTHETIC_URL          = "https://${var.primary_hostname}"
      SYNTHETIC_SECRET_ID    = local.synthetic_secret
      SYNTHETIC_SERVICE_NAME = local.service_name
    }, var.synthetic_model == null ? {} : { SYNTHETIC_MODEL = var.synthetic_model })
  }
  depends_on = [aws_cloudwatch_log_group.synthetic]
}

resource "aws_cloudwatch_event_rule" "synthetic" {
  count               = local.synthetic
  name                = "${var.name}-synthetic"
  description         = "Runs the synthetic check (synthetic.tf)"
  schedule_expression = "rate(5 minutes)"
}

resource "aws_cloudwatch_event_target" "synthetic" {
  count = local.synthetic
  rule  = aws_cloudwatch_event_rule.synthetic[0].name
  arn   = aws_lambda_function.synthetic[0].arn
  # A failed invocation is a failed check already (no line, then the alarm's missing data): no retries.
  retry_policy {
    maximum_retry_attempts       = 0
    maximum_event_age_in_seconds = 300
  }
}

resource "aws_lambda_permission" "synthetic" {
  count         = local.synthetic
  statement_id  = "events"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.synthetic[0].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.synthetic[0].arn
}

# Two failed checks in a row (two 5-minute periods), or none at all: the check's Lambda not running counts as down.
resource "aws_cloudwatch_metric_alarm" "synthetic" {
  count               = local.synthetic
  alarm_name          = "${var.name}-synthetic"
  alarm_description   = "The synthetic check failed twice in a row, or did not run (GET /healthz then one model turn on https://${var.primary_hostname}, as a customer). Its log group /aws/lambda/${var.name}-synthetic says which step and the API's code. Runbook: infra/terraform/README.md, Synthetic check."
  evaluation_periods  = 2
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = local.critical_topics
  ok_actions          = local.critical_topics

  metric_query {
    id          = "down"
    expression  = "IF(FILL(checks, 0) < 1, 1, FILL(failures, 0) / FILL(checks, 1))"
    label       = "Synthetic check failing (1) or passing (0)"
    return_data = true
  }
  metric_query {
    id = "checks"
    metric {
      namespace   = "AgentRuntime"
      metric_name = "SyntheticChecks"
      dimensions  = local.runtime_metric
      stat        = "Sum"
      period      = 300
    }
  }
  metric_query {
    id = "failures"
    metric {
      namespace   = "AgentRuntime"
      metric_name = "SyntheticFailures"
      dimensions  = local.runtime_metric
      stat        = "Sum"
      period      = 300
    }
  }
}
