# Email channels (src/channels-email.ts): SES receives mail for var.email_domain,
# stores each message in S3 and notifies an SNS topic, whose HTTPS subscription is
# the runtime's shared route /channels/email/inbound. Replies go out through SES
# from the same domain, signed with Easy DKIM. Everything here exists only when
# var.email_domain is set.
#
# Before the first apply:
# - The account must be out of the SES sandbox in var.region to send to
#   arbitrary addresses (a support case; the sandbox only sends to verified ones).
# - An account has one active receipt rule set per region; activating this one
#   replaces any other.
# The subscription is confirmed by the runtime (it answers SNS's handshake), so it
# must be serving the route with this environment first. Roll out in two steps:
#   1. tofu apply -target=aws_ecs_task_definition.runtime   (the topic, bucket and
#      task definition with AGENT_EMAIL_*), then infra/ecs-deploy.sh
#   2. tofu apply                                          (everything else)

locals {
  email         = var.email_domain != ""
  email_prefix  = "inbound/"
  email_bucket  = "${var.name}-email-${var.account_id}"
  email_enabled = local.email ? 1 : 0
  email_environment = local.email ? {
    AGENT_EMAIL_DOMAIN     = var.email_domain
    AGENT_EMAIL_SNS_TOPICS = aws_sns_topic.email[0].arn
    AGENT_EMAIL_BUCKET     = aws_s3_bucket.email[0].id
    AGENT_EMAIL_REGION     = var.region
  } : {}
}

resource "aws_sesv2_email_identity" "email" {
  count          = local.email_enabled
  email_identity = var.email_domain
}

# Easy DKIM: three CNAMEs SES signs with; DMARC then passes on our replies.
resource "cloudflare_dns_record" "email_dkim" {
  count   = local.email ? 3 : 0
  zone_id = var.cloudflare_zone_id
  name    = "${aws_sesv2_email_identity.email[0].dkim_signing_attributes[0].tokens[count.index]}._domainkey.${var.email_domain}"
  type    = "CNAME"
  content = "${aws_sesv2_email_identity.email[0].dkim_signing_attributes[0].tokens[count.index]}.dkim.amazonses.com"
  ttl     = 3600
  proxied = false
  comment = "${var.name} SES DKIM"
}

resource "cloudflare_dns_record" "email_mx" {
  count    = local.email_enabled
  zone_id  = var.cloudflare_zone_id
  name     = var.email_domain
  type     = "MX"
  content  = "inbound-smtp.${var.region}.amazonaws.com"
  priority = 10
  ttl      = 3600
  comment  = "${var.name} SES receiving"
}

# Nobody else may send as the domain: SES's DKIM is always aligned, so reject the rest.
resource "cloudflare_dns_record" "email_dmarc" {
  count   = local.email_enabled
  zone_id = var.cloudflare_zone_id
  name    = "_dmarc.${var.email_domain}"
  type    = "TXT"
  content = "\"v=DMARC1; p=reject; adkim=s\""
  ttl     = 3600
  comment = "${var.name} email DMARC"
}

# Raw messages, read by the runtime once (and again for each attachment). A week is
# longer than any channel item lives.
resource "aws_s3_bucket" "email" {
  count  = local.email_enabled
  bucket = local.email_bucket
}

resource "aws_s3_bucket_public_access_block" "email" {
  count                   = local.email_enabled
  bucket                  = aws_s3_bucket.email[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "email" {
  count  = local.email_enabled
  bucket = aws_s3_bucket.email[0].id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "email" {
  count  = local.email_enabled
  bucket = aws_s3_bucket.email[0].id
  rule {
    id     = "expire-inbound-mail"
    status = "Enabled"
    filter {
      prefix = local.email_prefix
    }
    expiration {
      days = 7
    }
  }
}

resource "aws_s3_bucket_policy" "email" {
  count  = local.email_enabled
  bucket = aws_s3_bucket.email[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "SesWritesInboundMail"
      Effect    = "Allow"
      Principal = { Service = "ses.amazonaws.com" }
      Action    = "s3:PutObject"
      Resource  = "${aws_s3_bucket.email[0].arn}/${local.email_prefix}*"
      Condition = {
        StringEquals = { "AWS:SourceAccount" = var.account_id }
        ArnLike      = { "AWS:SourceArn" = "arn:aws:ses:${var.region}:${var.account_id}:receipt-rule-set/${var.name}-email:receipt-rule/*" }
      }
    }]
  })
}

resource "aws_sns_topic" "email" {
  count = local.email_enabled
  name  = "${var.name}-email-inbound"
}

resource "aws_sns_topic_policy" "email" {
  count = local.email_enabled
  arn   = aws_sns_topic.email[0].arn
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "SesPublishes"
      Effect    = "Allow"
      Principal = { Service = "ses.amazonaws.com" }
      Action    = "sns:Publish"
      Resource  = aws_sns_topic.email[0].arn
      Condition = { StringEquals = { "AWS:SourceAccount" = var.account_id } }
    }]
  })
}

# The runtime verifies SNS's signature and this topic, and confirms the subscription itself.
resource "aws_sns_topic_subscription" "email" {
  count                  = local.email_enabled
  topic_arn              = aws_sns_topic.email[0].arn
  protocol               = "https"
  endpoint               = "https://${var.hostname}/channels/email/inbound"
  endpoint_auto_confirms = true
}

resource "aws_ses_receipt_rule_set" "email" {
  count         = local.email_enabled
  rule_set_name = "${var.name}-email"
}

resource "aws_ses_active_receipt_rule_set" "email" {
  count         = local.email_enabled
  rule_set_name = aws_ses_receipt_rule_set.email[0].rule_set_name
}

# Every message to the domain is stored whole (any size up to SES's 40 MB) and
# announced on the topic; the runtime drops what no channel's address matches.
resource "aws_ses_receipt_rule" "email" {
  count         = local.email_enabled
  name          = "store-and-notify"
  rule_set_name = aws_ses_receipt_rule_set.email[0].rule_set_name
  recipients    = [var.email_domain]
  enabled       = true
  scan_enabled  = true
  tls_policy    = "Optional"

  s3_action {
    position          = 1
    bucket_name       = aws_s3_bucket.email[0].id
    object_key_prefix = local.email_prefix
    topic_arn         = aws_sns_topic.email[0].arn
  }

  depends_on = [aws_s3_bucket_policy.email, aws_sns_topic_policy.email]
}

resource "aws_iam_role_policy" "task_email" {
  count = local.email_enabled
  name  = "agent-runtime-email"
  role  = aws_iam_role.task.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "SendReplies"
        Effect   = "Allow"
        Action   = ["ses:SendEmail", "ses:SendRawEmail"]
        Resource = aws_sesv2_email_identity.email[0].arn
      },
      {
        Sid      = "ReadInboundMail"
        Effect   = "Allow"
        Action   = "s3:GetObject"
        Resource = "${aws_s3_bucket.email[0].arn}/${local.email_prefix}*"
      },
    ]
  })
}
