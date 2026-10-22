# alarms for the load-balanced service. CloudWatch alarms can only notify
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

# A tenant or a node at its agent cap: runs or starts are refused (429 busyAgents
# or agentsPerTenant, 503 agentsPerNode) because every agent there is busy. A
# tenant's maxAgents (or AGENT_MAX_AGENTS_PER_TENANT) counts busy agents across the
# fleet, so this is the signal to raise it or add tasks. Prepaid tenants at their
# usage tier's limit log busy_limit_reached instead, which this does not count.
resource "aws_cloudwatch_log_metric_filter" "quota_rejected" {
  name           = "${var.name}-quota-rejected"
  log_group_name = aws_cloudwatch_log_group.runtime.name
  pattern        = "{ $.type = \"quota_rejected\" }"

  metric_transformation {
    namespace     = "AgentRuntime/Logs"
    name          = "QuotaRejected"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "quota_rejected" {
  alarm_name          = "${var.name}-quota-rejected"
  alarm_description   = "Agent starts refused at a tenant's or node's agent cap (quota_rejected in /ecs/${var.name})"
  namespace           = "AgentRuntime/Logs"
  metric_name         = "QuotaRejected"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_topics
  ok_actions          = local.alarm_topics
}

# Webhook deliveries that failed and will be retried (usage events bill
# chiridion's orgs, run events settle its threads).
resource "aws_cloudwatch_log_metric_filter" "webhook_failed" {
  name           = "${var.name}-webhook-failed"
  log_group_name = aws_cloudwatch_log_group.runtime.name
  pattern        = "{ ($.type = \"webhook_failed\") || ($.type = \"webhook_scan_failed\") }"

  metric_transformation {
    namespace     = "AgentRuntime/Logs"
    name          = "WebhookFailed"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "webhook_failed" {
  alarm_name          = "${var.name}-webhook-failed"
  alarm_description   = "Webhook deliveries are failing (webhook_failed, webhook_scan_failed in /ecs/${var.name}); they retry for 3 days"
  namespace           = "AgentRuntime/Logs"
  metric_name         = "WebhookFailed"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 2
  threshold           = 10
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_topics
  ok_actions          = local.alarm_topics
}

# End users' credit priced or bucketed by a fallback: a call on a model with no
# price, charged at the catalog's or the provider's dearest (end_user_unpriced_model),
# or a metered agent's run that named no bucket anywhere (end_user_default_bucket).
# Either means a tenant's configuration needs a price or a bucket.
resource "aws_cloudwatch_log_metric_filter" "end_user_fallback" {
  name           = "${var.name}-end-user-fallback"
  log_group_name = aws_cloudwatch_log_group.runtime.name
  pattern        = "{ ($.type = \"end_user_unpriced_model\") || ($.type = \"end_user_default_bucket\") }"

  metric_transformation {
    namespace     = "AgentRuntime/Logs"
    name          = "EndUserFallback"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "end_user_fallback" {
  alarm_name          = "${var.name}-end-user-fallback"
  alarm_description   = "End users' calls priced at a fallback (end_user_unpriced_model: a model with no price) or spent from \"default\" (end_user_default_bucket) in /ecs/${var.name}; the tenant should price the model or name a bucket"
  namespace           = "AgentRuntime/Logs"
  metric_name         = "EndUserFallback"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_topics
  ok_actions          = local.alarm_topics
}

# A model call that ended with no usage and no cost from its provider (model_usage_missing): billed at
# the runtime's estimate (its input as estimated at begin, and what it streamed), corrected later only
# where a provider record exists (an OpenRouter generation). A few are a stream closed early; many mean
# a provider (or Pi's adapter for it) stopped reporting usage.
resource "aws_cloudwatch_log_metric_filter" "model_usage_missing" {
  name           = "${var.name}-model-usage-missing"
  log_group_name = aws_cloudwatch_log_group.runtime.name
  pattern        = "{ $.type = \"model_usage_missing\" }"

  metric_transformation {
    namespace     = "AgentRuntime/Logs"
    name          = "ModelUsageMissing"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "model_usage_missing" {
  alarm_name          = "${var.name}-model-usage-missing"
  alarm_description   = "Model calls ended with no usage and no provider cost (model_usage_missing) in /ecs/${var.name}, billed at an estimate; look for a provider or model that stopped reporting usage"
  namespace           = "AgentRuntime/Logs"
  metric_name         = "ModelUsageMissing"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 10
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_topics
  ok_actions          = local.alarm_topics
}

# The control database is a burstable instance (db.t4g), and RDS runs T-class instances in Unlimited
# mode only: when its CPU credit balance runs out it is not held to its baseline, it bursts on surplus
# credits, billed when not earned back within 24 hours. So an empty balance is not the signal (a class
# change also starts the new instance at 0, which used to fire this); a surplus credit balance that
# stays up is: the database has needed more than its baseline CPU for an hour and pays for it, time
# for a fixed-performance class (db.m7g).
resource "aws_cloudwatch_metric_alarm" "database_cpu_credits" {
  alarm_name          = "${var.name}-database-cpu-credits"
  alarm_description   = "The control database has burst past its CPU credits for an hour (Unlimited mode: billed, not throttled); move to a larger or db.m7g class"
  namespace           = "AWS/RDS"
  metric_name         = "CPUSurplusCreditBalance"
  dimensions          = { DBInstanceIdentifier = aws_db_instance.control.identifier }
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 12
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_topics
  ok_actions          = local.alarm_topics
}

# Postgres keeps its working set in memory: as the data outgrows the instance it
# swaps, and every durable write and history read slows with it.
resource "aws_cloudwatch_metric_alarm" "database_memory" {
  alarm_name          = "${var.name}-database-memory"
  alarm_description   = "The control database has under 256 MB of freeable memory for 15 minutes; move to a larger class"
  namespace           = "AWS/RDS"
  metric_name         = "FreeableMemory"
  dimensions          = { DBInstanceIdentifier = aws_db_instance.control.identifier }
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 3
  threshold           = 256 * 1024 * 1024
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_topics
  ok_actions          = local.alarm_topics
}

# The dual read (AGENT_PI_DUAL_READ=log) found an agent whose host transcript and Pi journal disagree beyond what is
# expected while the host writes them both: a bug to explain before reads move to the journal.
resource "aws_cloudwatch_log_metric_filter" "dual_read_mismatches" {
  name           = "${var.name}-dual-read-mismatches"
  log_group_name = aws_cloudwatch_log_group.runtime.name
  pattern        = "{ $.type = \"host_transcript_dual_read_mismatch\" }"

  metric_transformation {
    namespace     = "AgentRuntime/Logs"
    name          = "DualReadMismatches"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "dual_read_mismatches" {
  alarm_name          = "${var.name}-dual-read-mismatches"
  alarm_description   = "An agent's host transcript and Pi journal disagree (host_transcript_dual_read_mismatch in /ecs/${var.name}): a projection bug, which holds back moving history reads to the journal"
  namespace           = "AgentRuntime/Logs"
  metric_name         = "DualReadMismatches"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_topics
  ok_actions          = local.alarm_topics
}

# An agent reading its history from Pi's journal (AGENT_PI_HISTORY_SOURCE_TENANTS) was given a value the journal and its
# host transcript disagree on: the host's was served, and the difference is a bug to explain before the host transcript goes.
resource "aws_cloudwatch_log_metric_filter" "history_source_mismatches" {
  name           = "${var.name}-history-source-mismatches"
  log_group_name = aws_cloudwatch_log_group.runtime.name
  pattern        = "{ $.type = \"history_source_mismatch\" }"

  metric_transformation {
    namespace     = "AgentRuntime/Logs"
    name          = "HistorySourceMismatches"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "history_source_mismatches" {
  alarm_name          = "${var.name}-history-source-mismatches"
  alarm_description   = "An agent reading its history from Pi's journal got a value its host transcript disagrees with (history_source_mismatch in /ecs/${var.name}); the host's was served"
  namespace           = "AgentRuntime/Logs"
  metric_name         = "HistorySourceMismatches"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_topics
  ok_actions          = local.alarm_topics
}
