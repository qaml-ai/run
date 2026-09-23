# Public health check and its alert path. Route 53 health check metrics are
# only published in us-east-1, so the alarm and topic live there.

resource "aws_sns_topic" "alerts" {
  provider = aws.us_east_1
  name     = "${var.name}-alerts"
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
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}
