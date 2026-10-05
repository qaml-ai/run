# Account mail (src/account-mail.ts): the links email sign-up, password reset and
# adding a password send, through SES as var.account_email_from, signed with Easy
# DKIM for the domain identity var.account_email_domain, with a custom MAIL FROM
# (bounce.<domain>) so SPF aligns too. The account is out of the SES sandbox in
# us-west-2 (checked 2026-10-05: production access, 50,000 a day, 14 a second).
#
# DNS for camelai.com is added by hand in Cloudflare, so this rolls out in two steps:
#   1. account_email_domain (and account_email_from) set: the identity, its MAIL FROM
#      and the task role's permission. The runtime is unchanged. Add the records
#      `tofu output account_email_dns_records` lists, and wait until SES shows the
#      identity verified and its MAIL FROM successful.
#   2. account_email_enabled = true: the task gets AGENT_ACCOUNT_EMAIL_*, and after
#      the next deploy the console and the consent page offer sign-up (with
#      AGENT_OPEN_SIGNUP=true) and password reset.
# Bounces and complaints land on the account-level suppression list, which SES
# then never sends to again.

variable "account_email_domain" {
  type        = string
  description = "Domain account mail is sent from, verified in SES with Easy DKIM (e.g. mail.camelai.com). Empty: no identity, no account mail."
  default     = ""
}

variable "account_email_from" {
  type        = string
  description = "Sender of account mail, an address at account_email_domain (e.g. accounts@mail.camelai.com)."
  default     = ""
  validation {
    condition     = var.account_email_from == "" || can(regex("^[^@\\s]+@[^@\\s]+$", var.account_email_from))
    error_message = "account_email_from must be an email address."
  }
}

variable "account_email_enabled" {
  type        = bool
  description = "Give the runtime AGENT_ACCOUNT_EMAIL_* (step 2): only once SES shows account_email_domain verified."
  default     = false
}

locals {
  account_email           = var.account_email_domain != ""
  account_email_mail_from = "bounce.${var.account_email_domain}"
  account_email_environment = local.account_email && var.account_email_enabled ? {
    AGENT_ACCOUNT_EMAIL_FROM = var.account_email_from
    AGENT_ACCOUNT_EMAIL_NAME = "camelRun"
  } : {}
}

resource "aws_sesv2_email_identity" "account" {
  count          = local.account_email ? 1 : 0
  email_identity = var.account_email_domain

  lifecycle {
    precondition {
      condition     = endswith(lower(var.account_email_from), "@${lower(var.account_email_domain)}")
      error_message = "account_email_from must be an address at account_email_domain."
    }
  }
}

# Bounces return to bounce.<domain>, so SPF passes for our domain and aligns under its
# relaxed DMARC; if its MX goes missing SES falls back to amazonses.com rather than failing.
resource "aws_sesv2_email_identity_mail_from_attributes" "account" {
  count                  = local.account_email ? 1 : 0
  email_identity         = aws_sesv2_email_identity.account[0].email_identity
  mail_from_domain       = local.account_email_mail_from
  behavior_on_mx_failure = "USE_DEFAULT_VALUE"
}

# Only SendEmail, only from this identity, only as the one sender.
resource "aws_iam_role_policy" "task_account_email" {
  count = local.account_email ? 1 : 0
  name  = "agent-runtime-account-email"
  role  = aws_iam_role.task.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "SendAccountMail"
      Effect    = "Allow"
      Action    = "ses:SendEmail"
      Resource  = aws_sesv2_email_identity.account[0].arn
      Condition = { StringEquals = { "ses:FromAddress" = var.account_email_from } }
    }]
  })
}

output "account_email_dns_records" {
  description = "The DNS records account mail needs, for camelai.com's Cloudflare zone (DNS only, not proxied)."
  value = local.account_email ? concat(
    [for token in aws_sesv2_email_identity.account[0].dkim_signing_attributes[0].tokens : {
      type = "CNAME", name = "${token}._domainkey.${var.account_email_domain}", content = "${token}.dkim.amazonses.com"
    }],
    [
      { type = "MX", name = local.account_email_mail_from, content = "feedback-smtp.${var.region}.amazonses.com", priority = 10 },
      { type = "TXT", name = local.account_email_mail_from, content = "v=spf1 include:amazonses.com ~all" },
    ],
  ) : []
}
