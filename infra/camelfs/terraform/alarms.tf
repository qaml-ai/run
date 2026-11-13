# Alarms to the runtime's us-west-2 alerts topic (infra/terraform/alarms.tf), which emails Miguel. The three the
# brief names (5xx, latency, DynamoDB throttles) plus the two every load-balanced service needs (a target failing
# its health check; fewer tasks than the minimum). The per-op, per-lineage metrics of camel-fs.md §1.12 are the
# daemon's EMF metrics, later; nothing here reads them.

data "aws_sns_topic" "alerts" {
  name = var.alerts_topic_name
}

locals {
  alarm_topics = [data.aws_sns_topic.alerts.arn]
  alb_dimensions = { for key, balancer in local.balancers : key => {
    LoadBalancer = aws_lb.api[key].arn_suffix
    TargetGroup  = aws_lb_target_group.api[key].arn_suffix
  } }
}

# --- Load balancers (public and internal alike) ---

resource "aws_cloudwatch_metric_alarm" "unhealthy_hosts" {
  for_each = local.balancers

  alarm_name          = "${var.name}-${var.env}-${each.key}-unhealthy-hosts"
  alarm_description   = "A camelFS api task has failed its ${var.api_health_path} check on the ${each.key} load balancer for 3 minutes"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "UnHealthyHostCount"
  dimensions          = local.alb_dimensions[each.key]
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_topics
  ok_actions          = local.alarm_topics
}

# 5xx the balancer generates itself (no healthy target, target reset or timeout).
resource "aws_cloudwatch_metric_alarm" "alb_5xx" {
  for_each = local.balancers

  alarm_name          = "${var.name}-${var.env}-${each.key}-alb-5xx"
  alarm_description   = "The camelFS ${each.key} load balancer returned 5xx (502/503/504) to clients"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_ELB_5XX_Count"
  dimensions          = { LoadBalancer = aws_lb.api[each.key].arn_suffix }
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
  for_each = local.balancers

  alarm_name          = "${var.name}-${var.env}-${each.key}-target-5xx"
  alarm_description   = "camelFS api tasks returned 5xx on the ${each.key} load balancer"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_Target_5XX_Count"
  dimensions          = local.alb_dimensions[each.key]
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 25
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_topics
  ok_actions          = local.alarm_topics
}

# p99 of the targets' response time, for 3 of 5 minutes. The budget is §1.6's (50–300 ms per op from the tier's
# seat); a sustained second means S3 or DynamoDB is slow, a merge is runaway, or the tier is undersized.
resource "aws_cloudwatch_metric_alarm" "target_latency" {
  for_each = local.balancers

  alarm_name          = "${var.name}-${var.env}-${each.key}-latency-p99"
  alarm_description   = "camelFS api p99 response time on the ${each.key} load balancer has exceeded ${var.api_latency_p99_ms} ms for 3 of 5 minutes"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "TargetResponseTime"
  dimensions          = local.alb_dimensions[each.key]
  extended_statistic  = "p99"
  period              = 60
  evaluation_periods  = 5
  datapoints_to_alarm = 3
  threshold           = var.api_latency_p99_ms / 1000
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_topics
  ok_actions          = local.alarm_topics
}

# --- DynamoDB ---

# On-demand tables throttle only when a partition's limit (1,000 WCU/s, 3,000 RCU/s) or the table's previous peak
# doubling is exceeded: a hot lineage (a swarm on one ref) or a misbehaving writer. §1.11's runbook: adaptive
# capacity usually splits it; otherwise rate-limit the token.
resource "aws_cloudwatch_metric_alarm" "dynamodb_throttles" {
  for_each = { for pair in setproduct(keys(local.tables), ["Read", "Write"]) : "${pair[0]}-${lower(pair[1])}" => { table = pair[0], kind = pair[1] } }

  alarm_name          = "${var.name}-${var.env}-${each.value.table}-${lower(each.value.kind)}-throttles"
  alarm_description   = "DynamoDB ${local.table_names[each.value.table]} throttled ${lower(each.value.kind)}s in the last 5 minutes"
  namespace           = "AWS/DynamoDB"
  metric_name         = "${each.value.kind}ThrottleEvents"
  dimensions          = { TableName = local.table_names[each.value.table] }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_topics
  ok_actions          = local.alarm_topics
}

# 5xx from DynamoDB itself (per table, every operation): the service's problem, not ours, but it fails writes loudly
# (§1.11: no degraded mode) and someone should know.
resource "aws_cloudwatch_metric_alarm" "dynamodb_system_errors" {
  for_each = local.tables

  alarm_name          = "${var.name}-${var.env}-${each.key}-system-errors"
  alarm_description   = "DynamoDB ${local.table_names[each.key]} returned system errors (5xx) in the last 5 minutes"
  namespace           = "AWS/DynamoDB"
  metric_name         = "SystemErrors"
  dimensions          = { TableName = local.table_names[each.key] }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_topics
  ok_actions          = local.alarm_topics
}

# --- Service (once it exists) ---

# Container Insights metric (the cluster setting in ecs.tf must stay enabled).
resource "aws_cloudwatch_metric_alarm" "running_tasks" {
  count = local.scaling_enabled ? 1 : 0

  alarm_name          = "${var.name}-${var.env}-api-running-tasks"
  alarm_description   = "Fewer camelFS api tasks are running than the service minimum"
  namespace           = "ECS/ContainerInsights"
  metric_name         = "RunningTaskCount"
  dimensions          = { ClusterName = aws_ecs_cluster.camelfs.name, ServiceName = aws_ecs_service.api[0].name }
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 5
  threshold           = var.api_min_count
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = local.alarm_topics
  ok_actions          = local.alarm_topics
}
