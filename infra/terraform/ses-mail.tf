# All of camelRun's outgoing mail through Amazon SES: billing (billing@), Get Help
# (no-reply@) and account mail (accounts@: email sign-up, password reset, adding a
# password), from the domain identity var.ses_mail_domain, signed with Easy DKIM, with
# MAIL FROM bounce.<domain> so SPF aligns too. Bounces and complaints are published by
# the configuration set to an SNS topic whose HTTPS subscription is the runtime's
# /v1/billing/email/feedback (src/billing-mailer.ts; verifySns checks each message),
# which suppresses billing contacts; SES's account-level suppression list keeps every
# sender off addresses that bounce or complain. The account is out of the SES sandbox in
# us-west-2 (checked 2026-10-05: 50,000 a day, 14 a second).
#
# DNS for camelai.com is added by hand in Cloudflare, so this rolled out in stages
# (docs/operations/account-email.md, "Runbook"); all three are on in production:
#   1. ses_mail_domain set: identity, MAIL FROM, configuration set, topic and the task
#      role's send permission.
#      Add the records `tofu output ses_mail_dns_records` lists; wait for SES to verify.
#   2. ses_mail_enabled = true: the task sends billing, Get Help and account mail through
#      SES (AGENT_BILLING_EMAIL_PROVIDER=ses, AGENT_ACCOUNT_EMAIL_FROM, ...). Deploy.
#   3. ses_mail_feedback = true: the topic's subscription, which the runtime (now serving
#      SNS on the feedback route) confirms.

variable "ses_mail_domain" {
  type        = string
  description = "Domain camelRun's mail is sent from through SES, verified with Easy DKIM (mail.camelai.com). Empty: none of ses-mail.tf."
  default     = ""
}

variable "ses_mail_enabled" {
  type        = bool
  description = "Stage 2: billing, Get Help and account mail through SES (without it the runtime sends no mail). Only once SES shows ses_mail_domain verified."
  default     = false
}

variable "ses_mail_feedback" {
  type        = bool
  description = "Stage 3: subscribe the runtime's /v1/billing/email/feedback to the bounce and complaint topic. Only once a deploy with ses_mail_enabled serves it."
  default     = false
}

locals {
  ses_mail      = var.ses_mail_domain != ""
  ses_mail_live = local.ses_mail && var.ses_mail_enabled
  # Senders, all at the one identity: the policy allows these and no other.
  ses_mail_from = {
    billing = "billing@${var.ses_mail_domain}"
    support = "no-reply@${var.ses_mail_domain}"
    account = "accounts@${var.ses_mail_domain}"
  }
  ses_mail_from_domain = "bounce.${var.ses_mail_domain}"
  # Account mail; billing's and Get Help's are in billing.tf, which switches them here.
  account_email_environment = local.ses_mail_live ? {
    AGENT_ACCOUNT_EMAIL_FROM              = local.ses_mail_from.account
    AGENT_ACCOUNT_EMAIL_NAME              = "camelRun"
    AGENT_ACCOUNT_EMAIL_CONFIGURATION_SET = aws_sesv2_configuration_set.mail[0].configuration_set_name
  } : {}
}

resource "aws_sesv2_email_identity" "mail" {
  count          = local.ses_mail ? 1 : 0
  email_identity = var.ses_mail_domain
}

# Bounces return to bounce.<domain>; if its MX goes missing SES falls back to amazonses.com rather than failing.
resource "aws_sesv2_email_identity_mail_from_attributes" "mail" {
  count                  = local.ses_mail ? 1 : 0
  email_identity         = aws_sesv2_email_identity.mail[0].email_identity
  mail_from_domain       = local.ses_mail_from_domain
  behavior_on_mx_failure = "USE_DEFAULT_VALUE"
}

resource "aws_sesv2_configuration_set" "mail" {
  count                  = local.ses_mail ? 1 : 0
  configuration_set_name = "${var.name}-mail"
  delivery_options {
    tls_policy = "REQUIRE"
  }
  reputation_options {
    reputation_metrics_enabled = true
  }
  sending_options {
    sending_enabled = true
  }
}

resource "aws_sns_topic" "mail_feedback" {
  count = local.ses_mail ? 1 : 0
  name  = "${var.name}-mail-feedback"
}

resource "aws_sns_topic_policy" "mail_feedback" {
  count = local.ses_mail ? 1 : 0
  arn   = aws_sns_topic.mail_feedback[0].arn
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "SesPublishes"
      Effect    = "Allow"
      Principal = { Service = "ses.amazonaws.com" }
      Action    = "sns:Publish"
      Resource  = aws_sns_topic.mail_feedback[0].arn
      Condition = {
        StringEquals = { "AWS:SourceAccount" = var.account_id }
        StringLike   = { "AWS:SourceArn" = "arn:aws:ses:${var.region}:${var.account_id}:configuration-set/${aws_sesv2_configuration_set.mail[0].configuration_set_name}" }
      }
    }]
  })
}

resource "aws_sesv2_configuration_set_event_destination" "mail_feedback" {
  count                  = local.ses_mail ? 1 : 0
  configuration_set_name = aws_sesv2_configuration_set.mail[0].configuration_set_name
  event_destination_name = "bounces-and-complaints"
  event_destination {
    enabled              = true
    matching_event_types = ["BOUNCE", "COMPLAINT"]
    sns_destination {
      topic_arn = aws_sns_topic.mail_feedback[0].arn
    }
  }
  depends_on = [aws_sns_topic_policy.mail_feedback]
}

# The runtime verifies SNS's signature and this topic, and confirms the subscription itself.
resource "aws_sns_topic_subscription" "mail_feedback" {
  count                  = local.ses_mail_live && var.ses_mail_feedback ? 1 : 0
  topic_arn              = aws_sns_topic.mail_feedback[0].arn
  protocol               = "https"
  endpoint               = "https://${var.public_hostname}/v1/billing/email/feedback"
  endpoint_auto_confirms = true
}

# Only SendEmail, only from this identity, through this configuration set, and only as the three senders.
resource "aws_iam_role_policy" "task_ses_mail" {
  count = local.ses_mail ? 1 : 0
  name  = "agent-runtime-ses-mail"
  role  = aws_iam_role.task.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "SendMail"
      Effect    = "Allow"
      Action    = "ses:SendEmail"
      Resource  = [aws_sesv2_email_identity.mail[0].arn, aws_sesv2_configuration_set.mail[0].arn]
      Condition = { StringEquals = { "ses:FromAddress" = values(local.ses_mail_from) } }
    }]
  })
}

output "ses_mail_dns_records" {
  description = "The DNS records SES mail needs, for camelai.com's Cloudflare zone (DNS only, not proxied)."
  value = local.ses_mail ? concat(
    [for token in aws_sesv2_email_identity.mail[0].dkim_signing_attributes[0].tokens : {
      type = "CNAME", name = "${token}._domainkey.${var.ses_mail_domain}", content = "${token}.dkim.amazonses.com"
    }],
    [
      { type = "MX", name = local.ses_mail_from_domain, content = "feedback-smtp.${var.region}.amazonses.com", priority = 10 },
      { type = "TXT", name = local.ses_mail_from_domain, content = "v=spf1 include:amazonses.com ~all" },
    ],
  ) : []
}

# Mail health, on the regional alerts topic (alarms.tf). SES pauses an account's sending at a bounce rate of
# 10% or a complaint rate of 0.5%, and reviews it from 5% and 0.1%: these fire at the review thresholds.
resource "aws_cloudwatch_metric_alarm" "ses_bounce_rate" {
  count               = local.ses_mail ? 1 : 0
  alarm_name          = "${var.name}-ses-bounce-rate"
  alarm_description   = "SES reputation bounce rate is over 5% (SES reviews the account from 5%, pauses sending at 10%). Check sign-up abuse and billing contacts."
  namespace           = "AWS/SES"
  metric_name         = "Reputation.BounceRate"
  statistic           = "Maximum"
  period              = 3600
  evaluation_periods  = 1
  threshold           = 0.05
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_topics
  ok_actions          = local.alarm_topics
}

resource "aws_cloudwatch_metric_alarm" "ses_complaint_rate" {
  count               = local.ses_mail ? 1 : 0
  alarm_name          = "${var.name}-ses-complaint-rate"
  alarm_description   = "SES reputation complaint rate is over 0.1% (SES reviews the account from 0.1%, pauses sending at 0.5%)."
  namespace           = "AWS/SES"
  metric_name         = "Reputation.ComplaintRate"
  statistic           = "Maximum"
  period              = 3600
  evaluation_periods  = 1
  threshold           = 0.001
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_topics
  ok_actions          = local.alarm_topics
}

# A send SES refused (account mail, billing mail), from the runtime's log.
resource "aws_cloudwatch_log_metric_filter" "mail_send_failed" {
  count          = local.ses_mail ? 1 : 0
  name           = "${var.name}-mail-send-failed"
  log_group_name = aws_cloudwatch_log_group.runtime.name
  pattern        = "{ ($.type = \"account_mail_failed\") || ($.type = \"billing_mail_send_failed\") }"
  metric_transformation {
    namespace     = "AgentRuntime/Mail"
    name          = "SendFailures"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "mail_send_failed" {
  count               = local.ses_mail ? 1 : 0
  alarm_name          = "${var.name}-mail-send-failed"
  alarm_description   = "A mail send failed in the last 15 minutes (account_mail_failed or billing_mail_send_failed in /ecs/${var.name}): look at the error class; SES throttling, the sender's identity or the task's permission."
  namespace           = "AgentRuntime/Mail"
  metric_name         = "SendFailures"
  statistic           = "Sum"
  period              = 900
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_topics
  ok_actions          = local.alarm_topics
}
