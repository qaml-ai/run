# Public health check and its alert path (critical: the API is down for everyone). Route 53 health check metrics are
# only published in us-east-1, so the alarm and topic live there.

resource "aws_sns_topic" "alerts" {
  provider = aws.us_east_1
  name     = "${var.name}-alerts"
}

resource "aws_sns_topic" "alerts_critical" {
  provider = aws.us_east_1
  name     = "${var.name}-alerts-critical"
}

resource "aws_sns_topic_subscription" "alerts_pager" {
  provider               = aws.us_east_1
  count                  = var.alerts_pager_url != null ? 1 : 0
  topic_arn              = aws_sns_topic.alerts_critical.arn
  protocol               = "https"
  endpoint               = var.alerts_pager_url
  endpoint_auto_confirms = true
}

resource "aws_route53_health_check" "healthz" {
  type              = "HTTPS"
  fqdn              = var.hostname
  port              = 443
  resource_path     = "/healthz"
  request_interval  = 30
  failure_threshold = 3
  enable_sni        = true
  tags              = { Name = var.name }
}

resource "aws_cloudwatch_metric_alarm" "healthz" {
  provider            = aws.us_east_1
  alarm_name          = "${var.name}-healthz"
  alarm_description   = "Health check of ${var.hostname}/healthz is failing"
  namespace           = "AWS/Route53"
  metric_name         = "HealthCheckStatus"
  dimensions          = { HealthCheckId = aws_route53_health_check.healthz.id }
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.alerts_critical.arn]
  ok_actions          = [aws_sns_topic.alerts_critical.arn]
}
