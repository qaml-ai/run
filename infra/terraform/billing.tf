# Values are set by the launch operator after creating the Stripe portal and mail Worker.
variable "billing_email_worker_url" {
  type        = string
  description = "HTTPS /send URL of the authenticated Cloudflare billing email Worker, or empty to disable email."
  default     = ""
}

variable "billing_stripe_portal_configuration" {
  type        = string
  description = "Dedicated Stripe billing portal configuration ID."
  default     = ""
}

variable "signup_min_account_days" {
  type        = number
  description = "Private deployment policy for signup grants. Required before enabling GitHub starting credit."
  default     = null
}

variable "support_email" {
  type        = string
  description = "Support inbox for the console's Get Help (support@camelai.com), or empty to hide it. Deploy the mail Worker's support sender first; see infra/billing-email/README.md."
  default     = ""
}

locals {
  billing_environment = merge(var.billing_stripe_portal_configuration == "" ? {} : {
    AGENT_STRIPE_PORTAL_CONFIGURATION = var.billing_stripe_portal_configuration
    }, var.signup_min_account_days == null ? {} : {
    AGENT_SIGNUP_MIN_ACCOUNT_DAYS = tostring(var.signup_min_account_days)
    # Billing mail through SES once ses-mail.tf's identity is verified and ses_mail_enabled is set; until then the Worker.
    }, local.ses_mail_live ? {
    AGENT_BILLING_EMAIL_PROVIDER          = "ses"
    AGENT_BILLING_EMAIL_FROM              = local.ses_mail_from.billing
    AGENT_BILLING_EMAIL_NAME              = "camelRun Billing"
    AGENT_BILLING_EMAIL_CONFIGURATION_SET = aws_sesv2_configuration_set.mail[0].configuration_set_name
    AGENT_BILLING_EMAIL_SNS_TOPICS        = aws_sns_topic.mail_feedback[0].arn
    } : var.billing_email_worker_url == "" ? {} : {
    AGENT_BILLING_EMAIL_PROVIDER   = "cloudflare"
    AGENT_BILLING_EMAIL_FROM       = "billing@mail.camelai.com"
    AGENT_BILLING_EMAIL_NAME       = "camelRun Billing"
    AGENT_BILLING_EMAIL_URL        = var.billing_email_worker_url
    AGENT_BILLING_EMAIL_SECRET_ARN = aws_secretsmanager_secret.runtime["billing-email"].arn
    }, var.support_email == "" || (var.billing_email_worker_url == "" && !local.ses_mail_live) ? {} : {
    # Get Help sends the way billing mail does (SES, or the Worker as its SUPPORT_FROM to its SUPPORT_TO), to this inbox.
    AGENT_SUPPORT_EMAIL      = var.support_email
    AGENT_SUPPORT_EMAIL_FROM = local.ses_mail_live ? local.ses_mail_from.support : "no-reply@mail.camelai.com"
    AGENT_SUPPORT_EMAIL_NAME = "camelRun"
    AGENT_SUPPORT_LOG_GROUP  = aws_cloudwatch_log_group.runtime.name
    AGENT_RELEASE            = var.runtime_image_tag
  })
}

variable "billing_slack_team_id" {
  type        = string
  description = "Authorized Amazon Q Slack workspace ID for billing operations."
  default     = null
}

variable "billing_slack_channel_id" {
  type        = string
  description = "Slack billing operations channel ID."
  default     = null
}

locals {
  billing_slack = var.billing_slack_team_id != null && var.billing_slack_channel_id != null
}

resource "aws_sns_topic" "billing" {
  name = "${var.name}-billing"
}

resource "aws_cloudwatch_log_metric_filter" "billing_review" {
  name           = "${var.name}-billing-review"
  log_group_name = aws_cloudwatch_log_group.runtime.name
  pattern        = "{ $.type = \"billing_reconciliation_required\" }"
  metric_transformation {
    namespace     = "AgentRuntime/Billing"
    name          = "ReconciliationRequired"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "billing_review" {
  alarm_name          = "${var.name}-billing-review"
  alarm_description   = "A payment needs manual review. Inspect billing_reconciliation_required in /ecs/${var.name} and docs/operations/billing.md. Verify Stripe payment and ledger before any retry or credit. Alarm returning to OK does not mean the payment was reconciled."
  namespace           = "AgentRuntime/Billing"
  metric_name         = "ReconciliationRequired"
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.billing.arn]
}

resource "aws_cloudwatch_log_metric_filter" "billing_worker_errors" {
  name           = "${var.name}-billing-worker-errors"
  log_group_name = aws_cloudwatch_log_group.runtime.name
  pattern        = "{ ($.type = \"billing_mail_send_failed\") || ($.type = \"billing_mail_poll_failed\") || ($.type = \"auto_topup_poll_failed\") || ($.type = \"auto_topup_step_failed\") }"
  metric_transformation {
    namespace     = "AgentRuntime/Billing"
    name          = "WorkerErrors"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "billing_worker_errors" {
  alarm_name          = "${var.name}-billing-worker-errors"
  alarm_description   = "Repeated billing email or automatic refill worker failures. Inspect /ecs/${var.name}; ordinary card declines do not trigger this alarm."
  namespace           = "AgentRuntime/Billing"
  metric_name         = "WorkerErrors"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 3
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.billing.arn]
}

resource "aws_iam_role" "billing_chatbot" {
  count = local.billing_slack ? 1 : 0
  name  = "${var.name}-billing-chatbot"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = "sts:AssumeRole", Principal = { Service = "chatbot.amazonaws.com" } }]
  })
}

# Only the notification renderer can read alarm graphs. The channel cannot run AWS commands.
resource "aws_iam_role_policy" "billing_chatbot" {
  count = local.billing_slack ? 1 : 0
  role  = aws_iam_role.billing_chatbot[0].id
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = ["cloudwatch:DescribeAlarms", "cloudwatch:GetMetricData", "cloudwatch:GetMetricStatistics", "cloudwatch:ListMetrics"], Resource = "*" }]
  })
}

resource "aws_iam_policy" "billing_no_commands" {
  count = local.billing_slack ? 1 : 0
  name  = "${var.name}-billing-no-commands"
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Deny", Action = "*", Resource = "*" }]
  })
}

resource "aws_chatbot_slack_channel_configuration" "billing" {
  count                 = local.billing_slack ? 1 : 0
  configuration_name    = "${var.name}-billing"
  iam_role_arn          = aws_iam_role.billing_chatbot[0].arn
  slack_team_id         = var.billing_slack_team_id
  slack_channel_id      = var.billing_slack_channel_id
  sns_topic_arns        = [aws_sns_topic.billing.arn]
  guardrail_policy_arns = [aws_iam_policy.billing_no_commands[0].arn]
  logging_level         = "ERROR"
}
