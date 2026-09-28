# Alarms on the runtime's own metrics (src/metrics.ts and node_load, namespace
# AgentRuntime, dimension ServiceName), and a dashboard of them with the service's
# ECS, load balancer and database metrics. Alarms notify the regional alerts topic
# (alarms.tf).

locals {
  runtime_metric = { ServiceName = local.service_name }
}

variable "spend_alarm_usd_per_hour" {
  description = "Model spend (all tenants, usage.recorded costs) in one hour that raises the spend alarm."
  type        = number
  default     = 100
}

# More than a fifth of turns failed over 10 minutes (with at least 10 turns).
resource "aws_cloudwatch_metric_alarm" "turn_failures" {
  alarm_name          = "${var.name}-turn-failures"
  alarm_description   = "Over 20% of turns failed in 10 minutes (turn_metrics Outcome=failed; see the dashboard's error classes)"
  evaluation_periods  = 2
  threshold           = 0.2
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_topics
  ok_actions          = local.alarm_topics

  metric_query {
    id          = "rate"
    expression  = "IF(total >= 10, failed / total, 0)"
    label       = "Failed turn share"
    return_data = true
  }
  metric_query {
    id = "failed"
    metric {
      namespace   = "AgentRuntime"
      metric_name = "Turns"
      dimensions  = merge(local.runtime_metric, { Outcome = "failed" })
      stat        = "Sum"
      period      = 300
    }
  }
  metric_query {
    id = "total"
    metric {
      namespace   = "AgentRuntime"
      metric_name = "Turns"
      dimensions  = local.runtime_metric
      stat        = "Sum"
      period      = 300
    }
  }
}

# Providers refusing for rate or load: the free tier has no fallback model.
resource "aws_cloudwatch_metric_alarm" "model_rate_limited" {
  alarm_name          = "${var.name}-model-rate-limited"
  alarm_description   = "Model responses failed with rate limits or overload (model_error ErrorClass rate_limit/overloaded), 10+ in 5 minutes"
  evaluation_periods  = 1
  threshold           = 10
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_topics
  ok_actions          = local.alarm_topics

  metric_query {
    id          = "refused"
    expression  = "FILL(limited, 0) + FILL(overloaded, 0)"
    return_data = true
  }
  metric_query {
    id = "limited"
    metric {
      namespace   = "AgentRuntime"
      metric_name = "ModelErrors"
      dimensions  = merge(local.runtime_metric, { ErrorClass = "rate_limit" })
      stat        = "Sum"
      period      = 300
    }
  }
  metric_query {
    id = "overloaded"
    metric {
      namespace   = "AgentRuntime"
      metric_name = "ModelErrors"
      dimensions  = merge(local.runtime_metric, { ErrorClass = "overloaded" })
      stat        = "Sum"
      period      = 300
    }
  }
}

# Runs a lost node cut short: a crash, an OOM or a drain that ran out of time.
resource "aws_cloudwatch_metric_alarm" "runs_uncertain" {
  alarm_name          = "${var.name}-runs-uncertain"
  alarm_description   = "Runs failed because the runtime restarted during them (run.failed uncertain)"
  namespace           = "AgentRuntime"
  metric_name         = "RunsUncertain"
  dimensions          = local.runtime_metric
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_topics
  ok_actions          = local.alarm_topics
}

# Slow first tokens: the provider is slow, or turns queue for the node.
resource "aws_cloudwatch_metric_alarm" "first_token_slow" {
  alarm_name          = "${var.name}-first-token-slow"
  alarm_description   = "p90 time to first token over 60 s for 15 minutes"
  namespace           = "AgentRuntime"
  metric_name         = "TimeToFirstTokenMs"
  dimensions          = local.runtime_metric
  extended_statistic  = "p90"
  period              = 300
  evaluation_periods  = 3
  threshold           = 60000
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_topics
  ok_actions          = local.alarm_topics
}

# Webhook deliveries waiting: receivers down or slow. Run events settle threads and
# usage events bill them, so ten minutes behind is worth a look.
resource "aws_cloudwatch_metric_alarm" "webhook_lag" {
  alarm_name          = "${var.name}-webhook-lag"
  alarm_description   = "The oldest undelivered webhook event has waited over 10 minutes (webhook_backlog)"
  namespace           = "AgentRuntime"
  metric_name         = "WebhookOldestPendingMs"
  dimensions          = local.runtime_metric
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  threshold           = 600000
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_topics
  ok_actions          = local.alarm_topics
}

resource "aws_cloudwatch_metric_alarm" "model_spend" {
  alarm_name          = "${var.name}-model-spend"
  alarm_description   = "Model spend over USD ${var.spend_alarm_usd_per_hour} in an hour (model_cost, all tenants)"
  namespace           = "AgentRuntime"
  metric_name         = "ModelCostUsd"
  dimensions          = local.runtime_metric
  statistic           = "Sum"
  period              = 3600
  evaluation_periods  = 1
  threshold           = var.spend_alarm_usd_per_hour
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_topics
  ok_actions          = local.alarm_topics
}

# A task near its memory: inline hosting keeps every agent of the task in one process.
resource "aws_cloudwatch_metric_alarm" "task_memory" {
  alarm_name          = "${var.name}-task-memory"
  alarm_description   = "A runtime task's RSS is over 75% of its memory (node_load rssBytes)"
  namespace           = "AgentRuntime"
  metric_name         = "rssBytes"
  dimensions          = local.runtime_metric
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 3
  threshold           = var.task_memory * 1024 * 1024 * 0.75
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_topics
  ok_actions          = local.alarm_topics
}

# Queries waiting for a database connection: the pool (AGENT_DATABASE_POOL_SIZE) is too small, or the database is slow.
resource "aws_cloudwatch_metric_alarm" "database_pool_waiting" {
  alarm_name          = "${var.name}-database-pool-waiting"
  alarm_description   = "Queries have waited for a database connection for 5 minutes (node_load dbWaiting)"
  namespace           = "AgentRuntime"
  metric_name         = "dbWaiting"
  dimensions          = local.runtime_metric
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 5
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_topics
  ok_actions          = local.alarm_topics
}

locals {
  ns  = "AgentRuntime"
  svc = local.service_name
  # SEARCH over one metric's dimension set, e.g. every Outcome of Turns.
  search = {
    turns_by_outcome   = "SEARCH('{AgentRuntime,ServiceName,Outcome} MetricName=\"Turns\" ServiceName=\"${local.service_name}\"', 'Sum', 300)"
    failed_by_class    = "SEARCH('{AgentRuntime,ServiceName,ErrorClass} MetricName=\"Turns\" ServiceName=\"${local.service_name}\" NOT ErrorClass=\"none\"', 'Sum', 300)"
    model_err_by_model = "SEARCH('{AgentRuntime,ServiceName,Provider,Model} MetricName=\"ModelErrors\" ServiceName=\"${local.service_name}\"', 'Sum', 300)"
    model_err_by_class = "SEARCH('{AgentRuntime,ServiceName,ErrorClass} MetricName=\"ModelErrors\" ServiceName=\"${local.service_name}\"', 'Sum', 300)"
    runs_failed_class  = "SEARCH('{AgentRuntime,ServiceName,Tenant,ErrorClass} MetricName=\"RunsFailedByClass\" ServiceName=\"${local.service_name}\"', 'Sum', 300)"
    cost_by_tenant     = "SEARCH('{AgentRuntime,ServiceName,Tenant} MetricName=\"ModelCostUsd\" ServiceName=\"${local.service_name}\"', 'Sum', 3600)"
    cost_by_model      = "SEARCH('{AgentRuntime,ServiceName,Provider,Model} MetricName=\"ModelCostUsd\" ServiceName=\"${local.service_name}\"', 'Sum', 3600)"
    runs_by_tenant     = "SEARCH('{AgentRuntime,ServiceName,Tenant} MetricName=\"RunsStarted\" ServiceName=\"${local.service_name}\"', 'Sum', 300)"
  }
}

resource "aws_cloudwatch_dashboard" "launch" {
  dashboard_name = "${var.name}-launch"
  dashboard_body = jsonencode({
    widgets = [
      { type = "text", x = 0, y = 0, width = 24, height = 2, properties = { markdown = "## ${var.name}: turns, models, webhooks, capacity\nMetrics from `turn_metrics`, `model_error`, `run_events`, `model_cost`, `webhook_*` and `node_load` log lines (src/metrics.ts, src/ecs.ts). Alarms go to SNS `${aws_sns_topic.alerts_regional.name}`." } },

      { type = "metric", x = 0, y = 2, width = 8, height = 6, properties = { title = "Turns by outcome (5 min)", region = var.region, view = "timeSeries", stacked = true,
      metrics = [[{ expression = local.search.turns_by_outcome, id = "t", label = "" }]] } },
      { type = "metric", x = 8, y = 2, width = 8, height = 6, properties = { title = "Failed turns by error class", region = var.region, view = "timeSeries", stacked = true,
      metrics = [[{ expression = local.search.failed_by_class, id = "f", label = "" }]] } },
      { type = "metric", x = 16, y = 2, width = 8, height = 6, properties = { title = "Time to first token / turn duration (ms)", region = var.region, view = "timeSeries",
        metrics = [
          [local.ns, "TimeToFirstTokenMs", "ServiceName", local.svc, { stat = "p50", label = "TTFT p50" }],
          [local.ns, "TimeToFirstTokenMs", "ServiceName", local.svc, { stat = "p90", label = "TTFT p90" }],
          [local.ns, "TurnDurationMs", "ServiceName", local.svc, { stat = "p50", label = "duration p50", yAxis = "right" }],
          [local.ns, "TurnDurationMs", "ServiceName", local.svc, { stat = "p90", label = "duration p90", yAxis = "right" }],
      ], period = 300 } },

      { type = "metric", x = 0, y = 8, width = 8, height = 6, properties = { title = "Model errors by provider/model", region = var.region, view = "timeSeries", stacked = true,
      metrics = [[{ expression = local.search.model_err_by_model, id = "m", label = "" }]] } },
      { type = "metric", x = 8, y = 8, width = 8, height = 6, properties = { title = "Model errors by class; retries", region = var.region, view = "timeSeries",
        metrics = [
          [{ expression = local.search.model_err_by_class, id = "c", label = "" }],
          [local.ns, "ModelRetries", "ServiceName", local.svc, { stat = "Sum", label = "retries", id = "r" }],
      ], period = 300 } },
      { type = "metric", x = 16, y = 8, width = 8, height = 6, properties = { title = "Tool calls and errors", region = var.region, view = "timeSeries",
        metrics = [
          [local.ns, "ToolCalls", "ServiceName", local.svc, { stat = "Sum", label = "tool calls" }],
          [local.ns, "ToolErrors", "ServiceName", local.svc, { stat = "Sum", label = "tool errors", yAxis = "right" }],
      ], period = 300 } },

      { type = "metric", x = 0, y = 14, width = 8, height = 6, properties = { title = "Runs: started, resumed, uncertain", region = var.region, view = "timeSeries",
        metrics = [
          [local.ns, "RunsStarted", "ServiceName", local.svc, { stat = "Sum", label = "started" }],
          [local.ns, "RunsResumed", "ServiceName", local.svc, { stat = "Sum", label = "resumed (lost node)", yAxis = "right" }],
          [local.ns, "RunsUncertain", "ServiceName", local.svc, { stat = "Sum", label = "uncertain (restart)", yAxis = "right" }],
          [local.ns, "RunsFailed", "ServiceName", local.svc, { stat = "Sum", label = "failed", yAxis = "right" }],
      ], period = 300 } },
      { type = "metric", x = 8, y = 14, width = 8, height = 6, properties = { title = "Failed runs by tenant and class", region = var.region, view = "timeSeries", stacked = true,
      metrics = [[{ expression = local.search.runs_failed_class, id = "rf", label = "" }]] } },
      { type = "metric", x = 16, y = 14, width = 8, height = 6, properties = { title = "Runs started by tenant", region = var.region, view = "timeSeries", stacked = true,
      metrics = [[{ expression = local.search.runs_by_tenant, id = "rt", label = "" }]] } },

      { type = "metric", x = 0, y = 20, width = 8, height = 6, properties = { title = "Webhooks: delivered, failed, backlog", region = var.region, view = "timeSeries",
        metrics = [
          [local.ns, "WebhooksDelivered", "ServiceName", local.svc, { stat = "Sum", label = "delivered" }],
          [local.ns, "WebhooksFailed", "ServiceName", local.svc, { stat = "Sum", label = "failed", yAxis = "right" }],
          [local.ns, "WebhookBacklog", "ServiceName", local.svc, { stat = "Maximum", label = "backlog", yAxis = "right" }],
      ], period = 300 } },
      { type = "metric", x = 8, y = 20, width = 8, height = 6, properties = { title = "Webhook lag (ms)", region = var.region, view = "timeSeries",
        metrics = [
          [local.ns, "WebhookDeliveryLagMs", "ServiceName", local.svc, { stat = "p50", label = "lag p50" }],
          [local.ns, "WebhookDeliveryLagMs", "ServiceName", local.svc, { stat = "p99", label = "lag p99" }],
          [local.ns, "WebhookOldestPendingMs", "ServiceName", local.svc, { stat = "Maximum", label = "oldest pending" }],
      ], period = 300 } },
      { type = "metric", x = 16, y = 20, width = 8, height = 6, properties = { title = "Model spend by tenant (USD/hour)", region = var.region, view = "timeSeries", stacked = true,
      metrics = [[{ expression = local.search.cost_by_tenant, id = "ct", label = "" }]] } },

      { type = "metric", x = 0, y = 26, width = 8, height = 6, properties = { title = "Agents, running turns, watchers (per node, max); 429s", region = var.region, view = "timeSeries",
        metrics = [
          [local.ns, "hostedAgents", "ServiceName", local.svc, { stat = "Maximum", label = "hosted agents" }],
          [local.ns, "runningTurns", "ServiceName", local.svc, { stat = "Maximum", label = "running turns" }],
          [local.ns, "watchers", "ServiceName", local.svc, { stat = "Maximum", label = "watchers" }],
          [local.ns, "WatchersRefused", "ServiceName", local.svc, { stat = "Sum", label = "watchers refused (429)", yAxis = "right" }],
      ], period = 60 } },
      { type = "metric", x = 8, y = 26, width = 8, height = 6, properties = { title = "Task memory and CPU", region = var.region, view = "timeSeries",
        metrics = [
          [local.ns, "rssBytes", "ServiceName", local.svc, { stat = "Maximum", label = "RSS max (bytes)" }],
          ["AWS/ECS", "CPUUtilization", "ClusterName", aws_ecs_cluster.runtime.name, "ServiceName", aws_ecs_service.runtime.name, { stat = "Maximum", label = "CPU % max", yAxis = "right" }],
          ["AWS/ECS", "MemoryUtilization", "ClusterName", aws_ecs_cluster.runtime.name, "ServiceName", aws_ecs_service.runtime.name, { stat = "Maximum", label = "memory % max", yAxis = "right" }],
          ["ECS/ContainerInsights", "RunningTaskCount", "ClusterName", aws_ecs_cluster.runtime.name, "ServiceName", aws_ecs_service.runtime.name, { stat = "Minimum", label = "tasks", yAxis = "right" }],
      ], period = 60 } },
      { type = "metric", x = 16, y = 26, width = 8, height = 6, properties = { title = "Load balancer", region = var.region, view = "timeSeries",
        metrics = [
          ["AWS/ApplicationELB", "HTTPCode_Target_5XX_Count", "LoadBalancer", aws_lb.runtime.arn_suffix, { stat = "Sum", label = "target 5xx" }],
          ["AWS/ApplicationELB", "HTTPCode_ELB_5XX_Count", "LoadBalancer", aws_lb.runtime.arn_suffix, { stat = "Sum", label = "ALB 5xx" }],
          ["AWS/ApplicationELB", "HTTPCode_Target_4XX_Count", "LoadBalancer", aws_lb.runtime.arn_suffix, { stat = "Sum", label = "target 4xx", yAxis = "right" }],
          ["AWS/ApplicationELB", "TargetResponseTime", "LoadBalancer", aws_lb.runtime.arn_suffix, { stat = "p90", label = "response p90 (s)", yAxis = "right" }],
      ], period = 300 } },

      { type = "metric", x = 0, y = 32, width = 8, height = 6, properties = { title = "Database", region = var.region, view = "timeSeries",
        metrics = [
          ["AWS/RDS", "CPUUtilization", "DBInstanceIdentifier", aws_db_instance.control.identifier, { stat = "Maximum", label = "CPU %" }],
          ["AWS/RDS", "DatabaseConnections", "DBInstanceIdentifier", aws_db_instance.control.identifier, { stat = "Maximum", label = "connections", yAxis = "right" }],
          ["AWS/RDS", "CPUCreditBalance", "DBInstanceIdentifier", aws_db_instance.control.identifier, { stat = "Minimum", label = "CPU credits", yAxis = "right" }],
          [local.ns, "dbWaiting", "ServiceName", local.svc, { stat = "Maximum", label = "pool waiting (max node)", yAxis = "right" }],
      ], period = 300 } },
      { type = "log", x = 8, y = 32, width = 16, height = 6, properties = { title = "Runtime errors and refusals (last 3 h)", region = var.region, view = "table",
      query = "SOURCE '${aws_cloudwatch_log_group.runtime.name}' | fields type | filter type in [\"quota_rejected\",\"webhook_failed\",\"webhook_scan_failed\",\"run_event_failed\",\"agent_resume_failed\",\"orphan_sweep_failed\",\"self_fence\",\"heartbeat_renew_failed\",\"database_connection_error\",\"database_listen_failed\",\"mcp_tools_unavailable\",\"codemode_workers_dying\",\"tool_failed\",\"model_error\"] | stats count() as n by type | sort n desc" } },
    ]
  })
}
