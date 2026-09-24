# NEW: alarms for the load-balanced service. CloudWatch alarms can only notify
# an SNS topic in their own region, so these use a us-west-2 twin of the
# us-east-1 alerts topic (monitoring.tf). Subscribe to both.

resource "aws_sns_topic" "alerts_regional" {
  name = "${var.name}-alerts"
}

locals {
  alarm_topics = [aws_sns_topic.alerts_regional.arn]
  alb_dimensions = {
    LoadBalancer = aws_lb.runtime.arn_suffix
    TargetGroup  = aws_lb_target_group.runtime.arn_suffix
  }
}

resource "aws_cloudwatch_metric_alarm" "alb_unhealthy_hosts" {
  alarm_name          = "${var.name}-unhealthy-hosts"
  alarm_description   = "A runtime task has failed its /healthz check for 3 minutes"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "UnHealthyHostCount"
  dimensions          = local.alb_dimensions
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_topics
  ok_actions          = local.alarm_topics
}

# 5xx the ALB generates itself (no healthy target, target reset or timeout).
resource "aws_cloudwatch_metric_alarm" "alb_5xx" {
  alarm_name          = "${var.name}-alb-5xx"
  alarm_description   = "The load balancer returned 5xx (502/503/504) to clients"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_ELB_5XX_Count"
  dimensions          = { LoadBalancer = aws_lb.runtime.arn_suffix }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 10
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_topics
  ok_actions          = local.alarm_topics
}

resource "aws_cloudwatch_metric_alarm" "target_5xx" {
  alarm_name          = "${var.name}-target-5xx"
  alarm_description   = "Runtime tasks returned 5xx"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_Target_5XX_Count"
  dimensions          = local.alb_dimensions
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 25
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_topics
  ok_actions          = local.alarm_topics
}

# Container Insights metric (var.container_insights must stay enabled).
resource "aws_cloudwatch_metric_alarm" "running_tasks" {
  alarm_name          = "${var.name}-running-tasks"
  alarm_description   = "Fewer runtime tasks are running than the service minimum"
  namespace           = "ECS/ContainerInsights"
  metric_name         = "RunningTaskCount"
  dimensions          = { ClusterName = aws_ecs_cluster.runtime.name, ServiceName = aws_ecs_service.runtime.name }
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 5
  threshold           = var.service_min_count
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = local.alarm_topics
  ok_actions          = local.alarm_topics
}

# The runtime logs {"type": ...} JSON lines when it cannot protect its task or
# read its service's deployments (missing IAM shows up here). Without either,
# scale-in can stop tasks mid-turn and superseded tasks never retire.
resource "aws_cloudwatch_log_metric_filter" "ecs_control_errors" {
  name           = "${var.name}-ecs-control-errors"
  log_group_name = aws_cloudwatch_log_group.runtime.name
  pattern        = "{ ($.type = \"task_protection_failed\") || ($.type = \"ecs_service_check_failed\") || ($.type = \"ecs_service_unavailable\") }"

  metric_transformation {
    namespace     = "AgentRuntime/Logs"
    name          = "EcsControlErrors"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "ecs_control_errors" {
  alarm_name          = "${var.name}-ecs-control-errors"
  alarm_description   = "Runtime tasks fail to set task protection or read the ECS service (task_protection_failed, ecs_service_check_failed, ecs_service_unavailable in /ecs/${var.name})"
  namespace           = "AgentRuntime/Logs"
  metric_name         = "EcsControlErrors"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 2
  threshold           = 3
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_topics
  ok_actions          = local.alarm_topics
}
