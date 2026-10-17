# Service level objectives, their burn-rate alarms and the SLO dashboard.
#
# Each SLO is a share of good events over a 30-day budget (1 - objective). Its burn rate is the bad share now divided
# by that budget: 1 spends the budget in exactly 30 days, 14.4 spends 2% of it in an hour. Alarms are the multiwindow
# pair from Google's SRE workbook, as composites of two windows each, so a short spike alone never alarms and a long
# window stops alarming soon after the problem ends:
# - critical (paging): burn over 14.4 over 1 hour and over 5 minutes;
# - warning: burn over 6 over 6 hours and over 30 minutes.
# The windows are CloudWatch periods, aligned to the clock (a 1-hour window is the hour so far), not sliding. A window
# with fewer events than its `min` counts as burning nothing, so a few failures at night do not page.
#
# Adding an SLO is one entry in local.slos: its metrics (by id), the bad and total expressions over those ids, and the
# least traffic each window needs.

locals {
  slo_windows = {
    "1h"  = { period = 3600, burn = 14.4, severity = "critical" }
    "5m"  = { period = 300, burn = 14.4, severity = "critical" }
    "6h"  = { period = 21600, burn = 6, severity = "warning" }
    "30m" = { period = 1800, burn = 6, severity = "warning" }
  }
  slo_pairs = { critical = ["1h", "5m"], warning = ["6h", "30m"] }

  alb_metric = { LoadBalancer = aws_lb.runtime.arn_suffix }

  slos = {
    # 5xx from the tasks and from the ALB itself, of every request. The week to 2026-10-17: 123 task and 63 ALB 5xx
    # of 1.36M requests (0.014%; the worst day 0.017%), so 99.9% leaves room. Critical at 1.44% for an hour.
    api = {
      title       = "API availability"
      description = "5xx (task or ALB) share of requests to the API"
      objective   = 0.999
      metrics = {
        target = { namespace = "AWS/ApplicationELB", name = "HTTPCode_Target_5XX_Count", dimensions = local.alb_metric }
        elb    = { namespace = "AWS/ApplicationELB", name = "HTTPCode_ELB_5XX_Count", dimensions = local.alb_metric }
        req    = { namespace = "AWS/ApplicationELB", name = "RequestCount", dimensions = local.alb_metric }
      }
      bad   = "FILL(target, 0) + FILL(elb, 0)"
      total = "FILL(req, 0)"
      min   = { "1h" = 600, "5m" = 100, "6h" = 3600, "30m" = 300 }
    }
    # Turns that failed for a cause of ours (turn_metrics Fault=platform: the runtime, its sandbox, the providers; an
    # unknown error counts as ours), of all turns. The caller's causes (an abort, a refusal, a context too long, the
    # tenant's own key or credit) are left out. The week to 2026-10-17: 692 failed turns of 25,285 (2.7%), of which
    # ~630 had a platform class: `other` 455 (276 of them with no model error: often aborts, now Fault=caller by their
    # code), `exception` 159 (100 on 2026-10-12), the rest a few each. So 97% for now; tighten once Fault=platform's
    # baseline is known. Critical at 43% for an hour.
    turns = {
      title       = "Turn success"
      description = "Share of turns that failed for a cause of the platform's (turn_metrics Fault=platform)"
      objective   = 0.97
      metrics = {
        bad   = { namespace = "AgentRuntime", name = "Turns", dimensions = merge(local.runtime_metric, { Fault = "platform" }) }
        turns = { namespace = "AgentRuntime", name = "Turns", dimensions = local.runtime_metric }
      }
      bad   = "FILL(bad, 0)"
      total = "FILL(turns, 0)"
      min   = { "1h" = 20, "5m" = 10, "6h" = 100, "30m" = 20 }
    }
    # Turns whose first token took over 30 s (SlowFirstTokens), of those with a first token. The week to 2026-10-17:
    # p50 1.0-2.6 s, p95 9-41 s; 657 of 23,790 turns over 30 s (2.8%), 214 over 60 s. So 97% within 30 s.
    first_token = {
      title       = "Time to first token"
      description = "Share of turns whose first token took over 30 s"
      objective   = 0.97
      metrics = {
        slow  = { namespace = "AgentRuntime", name = "SlowFirstTokens", dimensions = local.runtime_metric }
        first = { namespace = "AgentRuntime", name = "FirstTokens", dimensions = local.runtime_metric }
      }
      bad   = "FILL(slow, 0)"
      total = "FILL(first, 0)"
      min   = { "1h" = 20, "5m" = 10, "6h" = 100, "30m" = 20 }
    }
  }

  slo_children = merge([for slo, spec in local.slos : { for window, w in local.slo_windows : "${slo}-${window}" => merge(w, { slo = slo, window = window, spec = spec }) }]...)
}

# One alarm per SLO and window, with no actions: the composites below carry them.
resource "aws_cloudwatch_metric_alarm" "slo_window" {
  for_each            = local.slo_children
  alarm_name          = "${var.name}-slo-${each.value.slo}-burn-${each.value.window}"
  alarm_description   = "${each.value.spec.title}: burn rate over ${each.value.burn} in the last ${each.value.window} (objective ${each.value.spec.objective * 100}%). One window of the ${each.value.severity} composite ${var.name}-slo-${each.value.slo}-${each.value.severity}."
  evaluation_periods  = 1
  threshold           = each.value.burn
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  metric_query {
    id          = "burn"
    expression  = "IF(${each.value.spec.total} >= ${each.value.spec.min[each.value.window]}, (${each.value.spec.bad}) / (${each.value.spec.total}), 0) / (1 - ${each.value.spec.objective})"
    label       = "${each.value.spec.title} burn rate (${each.value.window})"
    return_data = true
  }
  dynamic "metric_query" {
    for_each = each.value.spec.metrics
    content {
      id = metric_query.key
      metric {
        namespace   = metric_query.value.namespace
        metric_name = metric_query.value.name
        dimensions  = metric_query.value.dimensions
        stat        = "Sum"
        period      = each.value.period
      }
    }
  }
}

resource "aws_cloudwatch_composite_alarm" "slo" {
  for_each          = merge([for slo, spec in local.slos : { for severity, windows in local.slo_pairs : "${slo}-${severity}" => { slo = slo, spec = spec, severity = severity, windows = windows } }]...)
  alarm_name        = "${var.name}-slo-${each.value.slo}-${each.value.severity}"
  alarm_description = "${each.value.spec.title} (${each.value.spec.description}; objective ${each.value.spec.objective * 100}% over 30 days) is burning its error budget ${local.slo_windows[each.value.windows[0]].burn}x over both ${join(" and ", each.value.windows)}. Dashboard ${var.name}-slo; runbook: infra/terraform/README.md, SLOs."
  alarm_rule        = join(" AND ", [for window in each.value.windows : "ALARM(\"${aws_cloudwatch_metric_alarm.slo_window["${each.value.slo}-${window}"].alarm_name}\")"])
  alarm_actions     = each.value.severity == "critical" ? local.critical_topics : local.alarm_topics
  ok_actions        = each.value.severity == "critical" ? local.critical_topics : local.alarm_topics
}

resource "aws_cloudwatch_dashboard" "slo" {
  dashboard_name = "${var.name}-slo"
  dashboard_body = jsonencode({
    widgets = concat(
      [{ type = "text", x = 0, y = 0, width = 24, height = 2, properties = { markdown = "## ${var.name}: SLOs, limits, synthetic check\nEach SLO's good share (1 hour), against its objective, and its burn rate (1 means the 30-day budget lasts exactly 30 days; 14.4 over an hour and 6 over 6 hours alarm). infra/terraform/slo.tf, limits.tf, synthetic.tf. Critical alarms go to SNS `${aws_sns_topic.alerts_critical_regional.name}`, warnings to `${aws_sns_topic.alerts_regional.name}`." } }],
      flatten([for i, slo in keys(local.slos) : [
        { type = "metric", x = 0, y = 2 + i * 6, width = 12, height = 6, properties = {
          title       = "${local.slos[slo].title}: good share, 1 h (objective ${local.slos[slo].objective * 100}%)", region = var.region, view = "timeSeries",
          annotations = { horizontal = [{ value = local.slos[slo].objective, label = "objective" }] },
          metrics = concat(
            [for id, m in local.slos[slo].metrics : concat([m.namespace, m.name], flatten([for k, v in m.dimensions : [k, v]]), [{ id = id, stat = "Sum", visible = false }])],
            [[{ expression = "IF(${local.slos[slo].total} > 0, 1 - (${local.slos[slo].bad}) / (${local.slos[slo].total}), 1)", id = "good", label = "good share" }]],
        ), period = 3600 } },
        { type = "metric", x = 12, y = 2 + i * 6, width = 12, height = 6, properties = {
          title       = "${local.slos[slo].title}: burn rate", region = var.region, view = "timeSeries",
          annotations = { horizontal = [{ value = 14.4, label = "critical (1 h, 5 min)" }, { value = 6, label = "warning (6 h, 30 min)" }] },
          metrics = concat(
            [[{ expression = "IF(${local.slos[slo].total} > 0, (${local.slos[slo].bad}) / (${local.slos[slo].total}), 0) / (1 - ${local.slos[slo].objective})", id = "burn", label = "burn rate (5 min)" }]],
            [for id, m in local.slos[slo].metrics : concat([m.namespace, m.name], flatten([for k, v in m.dimensions : [k, v]]), [{ id = id, stat = "Sum", visible = false }])],
        ), period = 300 } },
      ]]),
      [
        { type = "metric", x = 0, y = 2 + length(local.slos) * 6, width = 8, height = 6, properties = {
          title = "Time to first token (ms)", region = var.region, view = "timeSeries",
          metrics = [
            [local.ns, "TimeToFirstTokenMs", "ServiceName", local.svc, { stat = "p50", label = "p50" }],
            [local.ns, "TimeToFirstTokenMs", "ServiceName", local.svc, { stat = "p95", label = "p95" }],
            [local.ns, "TimeToFirstTokenMs", "ServiceName", local.svc, { stat = "p99", label = "p99" }],
        ], period = 300 } },
        { type = "metric", x = 8, y = 2 + length(local.slos) * 6, width = 8, height = 6, properties = {
          title = "Turns by fault (5 min)", region = var.region, view = "timeSeries", stacked = true,
        metrics = [[{ expression = "SEARCH('{AgentRuntime,ServiceName,Fault} MetricName=\"Turns\" ServiceName=\"${local.svc}\"', 'Sum', 300)", id = "f", label = "" }]] } },
        { type = "metric", x = 16, y = 2 + length(local.slos) * 6, width = 8, height = 6, properties = {
          title = "Saturation: running turns, hosted agents (max node); 429/503 at caps", region = var.region, view = "timeSeries",
          metrics = [
            [local.ns, "runningTurns", "ServiceName", local.svc, { stat = "Maximum", label = "running turns" }],
            [local.ns, "hostedAgents", "ServiceName", local.svc, { stat = "Maximum", label = "hosted agents" }],
            ["AgentRuntime/Logs", "QuotaRejected", { stat = "Sum", label = "quota_rejected", yAxis = "right" }],
        ], period = 300 } },
        { type = "metric", x = 0, y = 8 + length(local.slos) * 6, width = 8, height = 6, properties = {
          title = "Limit refusals by limit (5 min)", region = var.region, view = "timeSeries", stacked = true,
        metrics = [[{ expression = "SEARCH('{AgentRuntime,ServiceName,Limit} MetricName=\"LimitRefusals\" ServiceName=\"${local.svc}\"', 'Sum', 300)", id = "l", label = "" }]] } },
        { type = "metric", x = 8, y = 8 + length(local.slos) * 6, width = 8, height = 6, properties = {
          title = "Operator tenants' limit refusals (5 min)", region = var.region, view = "timeSeries", stacked = true,
        metrics = [[{ expression = "SEARCH('{AgentRuntime,ServiceName,Tenant,Limit} MetricName=\"LimitRefusals\" ServiceName=\"${local.svc}\" (${join(" OR ", [for t in var.operator_tenants : "Tenant=\"${t}\""])})', 'Sum', 300)", id = "o", label = "" }]] } },
        { type = "metric", x = 16, y = 8 + length(local.slos) * 6, width = 8, height = 6, properties = {
          title       = "Tenants' use of their limits, % (largest tenant)", region = var.region, view = "timeSeries",
          annotations = { horizontal = [{ value = 70, label = "warning" }, { value = 85, label = "critical" }] },
        metrics = [[{ expression = "SEARCH('{AgentRuntime,ServiceName,Limit} MetricName=\"TenantLimitUsedPct\" ServiceName=\"${local.svc}\"', 'Maximum', 300)", id = "u", label = "" }]] } },
        { type = "metric", x = 0, y = 14 + length(local.slos) * 6, width = 12, height = 6, properties = {
          title = "Synthetic check (run.camelai.com: health, one model turn)", region = var.region, view = "timeSeries",
          metrics = [
            [local.ns, "SyntheticChecks", "ServiceName", local.svc, { stat = "Sum", label = "checks" }],
            [local.ns, "SyntheticFailures", "ServiceName", local.svc, { stat = "Sum", label = "failures" }],
            [local.ns, "SyntheticRunMs", "ServiceName", local.svc, { stat = "Maximum", label = "turn ms (max)", yAxis = "right" }],
        ], period = 300 } },
        { type = "alarm", x = 12, y = 14 + length(local.slos) * 6, width = 12, height = 6, properties = {
          title  = "SLO and limit alarms",
          alarms = concat([for alarm in aws_cloudwatch_composite_alarm.slo : alarm.arn], [for alarm in aws_cloudwatch_metric_alarm.operator_limits : alarm.arn], [for alarm in aws_cloudwatch_metric_alarm.tenant_limits : alarm.arn], [for alarm in aws_cloudwatch_metric_alarm.synthetic : alarm.arn])
        } },
      ],
    )
  })
}
