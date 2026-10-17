# Limits reached: requests the runtime refused at a tenant's or a node's limit (limit_refused, metrics.ts
# recordLimitRefused), and how much of their limits the tenants of the tenants file use (tenant_limits).
#
# Written for two misses on 2026-10-15 and 2026-10-17: camel-bots' tenant at its definitions limit (then 200) had its
# bots' publishes refused for 38 minutes, and end-user credit refusals during a rollout were seen only in camel-bots'
# logs. A limit an operator tenant reaches is a product failing for its users, whichever limit it is.

variable "operator_tenants" {
  description = "Tenants whose refusals at a limit alarm (limits.tf): the platform's own products."
  type        = list(string)
  default     = ["camel-bots", "chiridion-prod"]
}

locals {
  operator_limit_alarms = merge([for tenant in var.operator_tenants : {
    "${tenant}-warning"  = { tenant = tenant, severity = "warning", threshold = 1, periods = 1 }
    "${tenant}-critical" = { tenant = tenant, severity = "critical", threshold = 5, periods = 2 }
  }]...)
}

# Any refusal of an operator tenant at a limit other than its end users' credit (definitions, busy agents, the monthly
# spend cap, a rate limit, the per-node agent cap...): warning at the first in 5 minutes, critical at 5 or more in each
# of two 5-minute periods. End users out of their credit are the product working; their share is the next alarm.
resource "aws_cloudwatch_metric_alarm" "operator_limits" {
  for_each            = local.operator_limit_alarms
  alarm_name          = "${var.name}-limits-${each.value.tenant}-${each.value.severity}"
  alarm_description   = "${each.value.tenant}'s requests are refused at a limit (limit_refused, Limit other than endUserCredit): ${each.value.threshold}+ in ${each.value.periods == 1 ? "5 minutes" : "each of two 5-minute periods"}. The SLO dashboard's operator refusals say which limit; runbook: infra/terraform/README.md, Limits."
  evaluation_periods  = each.value.periods
  threshold           = each.value.threshold
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = each.value.severity == "critical" ? local.critical_topics : local.alarm_topics
  ok_actions          = each.value.severity == "critical" ? local.critical_topics : local.alarm_topics

  metric_query {
    id          = "refused"
    expression  = "SELECT SUM(LimitRefusals) FROM SCHEMA(AgentRuntime, ServiceName, Tenant, Limit) WHERE ServiceName = '${local.service_name}' AND Tenant = '${each.value.tenant}' AND Limit != 'endUserCredit'"
    label       = "${each.value.tenant} limit refusals"
    period      = 300
    return_data = true
  }
}

# An operator tenant's runs refused for its end users' credit, as a share of its runs started and refused: over half
# in each of two 15-minute windows (with at least 10) is a rollout or a bucket gone wrong, not people out of credit.
resource "aws_cloudwatch_metric_alarm" "operator_end_user_credit" {
  for_each            = toset(var.operator_tenants)
  alarm_name          = "${var.name}-limits-${each.value}-end-user-credit"
  alarm_description   = "Over half of ${each.value}'s runs were refused for its end users' credit (limit_refused Limit=endUserCredit, of those and run.started) in each of two 15-minute windows. Check its end-user credit settings and buckets; runbook: infra/terraform/README.md, Limits."
  evaluation_periods  = 2
  threshold           = 0.5
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.critical_topics
  ok_actions          = local.critical_topics

  metric_query {
    id          = "share"
    expression  = "IF(FILL(refused, 0) + FILL(started, 0) >= 10, FILL(refused, 0) / (FILL(refused, 0) + FILL(started, 0)), 0)"
    label       = "Share refused for end users' credit"
    return_data = true
  }
  metric_query {
    id = "refused"
    metric {
      namespace   = "AgentRuntime"
      metric_name = "LimitRefusals"
      dimensions  = merge(local.runtime_metric, { Tenant = each.value, Limit = "endUserCredit" })
      stat        = "Sum"
      period      = 900
    }
  }
  metric_query {
    id = "started"
    metric {
      namespace   = "AgentRuntime"
      metric_name = "RunsStarted"
      dimensions  = merge(local.runtime_metric, { Tenant = each.value })
      stat        = "Sum"
      period      = 900
    }
  }
}

# The most any tenant of the tenants file uses of a limit (definitions, busy agents, the monthly spend cap), every
# 5 minutes from each node: warning at 70%, critical at 85%, each for two readings. The dashboard says which.
resource "aws_cloudwatch_metric_alarm" "tenant_limits" {
  for_each            = { warning = 70, critical = 85 }
  alarm_name          = "${var.name}-tenant-limits-${each.key}"
  alarm_description   = "A tenant of the tenants file uses over ${each.value}% of a limit (tenant_limits TenantLimitUsedPct: definitions, busyAgents or monthlySpend). Raise it in the tenants file, or clean up; the SLO dashboard's limits widget says which. Runbook: infra/terraform/README.md, Limits."
  evaluation_periods  = 2
  threshold           = each.value
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = each.key == "critical" ? local.critical_topics : local.alarm_topics
  ok_actions          = each.key == "critical" ? local.critical_topics : local.alarm_topics

  metric_query {
    id          = "used"
    expression  = "SELECT MAX(TenantLimitUsedPct) FROM SCHEMA(AgentRuntime, ServiceName, Tenant, Limit) WHERE ServiceName = '${local.service_name}'"
    label       = "Largest share of a limit used (%)"
    period      = 300
    return_data = true
  }
}
