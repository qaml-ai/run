# Optional: the alerts topics (alarms.tf in this region, monitoring.tf in us-east-1)
# posted to a Slack channel by AWS Chatbot (Amazon Q Developer in chat applications).
# Off until both ids are set. Authorize the Slack workspace once in the Chatbot
# console (it shows the workspace id), invite @Amazon Q to the channel, then set
# alerts_slack_team_id and alerts_slack_channel_id.

variable "alerts_slack_team_id" {
  description = "Slack workspace id authorized in AWS Chatbot (e.g. T0123ABCD), or null for no Slack alerts."
  type        = string
  default     = null
}

variable "alerts_slack_channel_id" {
  description = "Slack channel id alerts are posted to (e.g. C0123ABCD), or null for no Slack alerts."
  type        = string
  default     = null
}

locals {
  slack_alerts = var.alerts_slack_team_id != null && var.alerts_slack_channel_id != null
}

data "aws_iam_policy_document" "chatbot_assume" {
  count = local.slack_alerts ? 1 : 0
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["chatbot.amazonaws.com"]
    }
  }
}

# Chatbot only posts; its role may read CloudWatch to render alarm charts, nothing else.
resource "aws_iam_role" "chatbot" {
  count              = local.slack_alerts ? 1 : 0
  name               = "${var.name}-chatbot"
  assume_role_policy = data.aws_iam_policy_document.chatbot_assume[0].json
}

resource "aws_iam_role_policy_attachment" "chatbot_read_only" {
  count      = local.slack_alerts ? 1 : 0
  role       = aws_iam_role.chatbot[0].name
  policy_arn = "arn:aws:iam::aws:policy/CloudWatchReadOnlyAccess"
}

resource "aws_chatbot_slack_channel_configuration" "alerts" {
  count                 = local.slack_alerts ? 1 : 0
  configuration_name    = "${var.name}-alerts"
  iam_role_arn          = aws_iam_role.chatbot[0].arn
  slack_team_id         = var.alerts_slack_team_id
  slack_channel_id      = var.alerts_slack_channel_id
  sns_topic_arns        = [aws_sns_topic.alerts_regional.arn, aws_sns_topic.alerts.arn]
  guardrail_policy_arns = ["arn:aws:iam::aws:policy/ReadOnlyAccess"]
  logging_level         = "ERROR"
}
