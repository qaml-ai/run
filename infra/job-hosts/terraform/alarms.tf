# Alarms on the pools, to the runtime's us-west-2 alerts topic (infra/terraform/alarms.tf), which emails Miguel.
# Modest on purpose: "hosts the pool wants are not in service" (failed boots, quota or capacity errors, hosts dying)
# and failed EC2 status checks; the scaler's own errors are in scaler.tf. Heartbeat loss as the runtime sees it and
# stuck leases are runtime metrics, alarmed on the runtime's side.

data "aws_sns_topic" "alerts" {
  name = var.alerts_topic_name
}

locals {
  pool_asgs = merge(
    { for asg in aws_autoscaling_group.build : "build" => asg.name },
    { for asg in aws_autoscaling_group.test : "test" => asg.name },
  )
}

# Desired minus in service, for 15 minutes: launches failing (bad AMI, boot failing EC2 checks, vCPU quota, no
# capacity) or hosts dying faster than they are replaced. Longer than a boot plus a drain hook.
resource "aws_cloudwatch_metric_alarm" "pool_short" {
  for_each = local.pool_asgs

  alarm_name          = "${var.name}-${each.key}-short"
  alarm_description   = "The ${each.key} job-host pool has had fewer hosts in service than desired for 15 minutes (see the ASG's activity history)"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  evaluation_periods  = 15
  datapoints_to_alarm = 15
  treat_missing_data  = "notBreaching"
  alarm_actions       = [data.aws_sns_topic.alerts.arn]
  ok_actions          = [data.aws_sns_topic.alerts.arn]

  metric_query {
    id          = "short"
    expression  = "desired - inservice"
    label       = "Hosts short"
    return_data = true
  }
  metric_query {
    id = "desired"
    metric {
      namespace   = "AWS/AutoScaling"
      metric_name = "GroupDesiredCapacity"
      dimensions  = { AutoScalingGroupName = each.value }
      period      = 60
      stat        = "Maximum"
    }
  }
  metric_query {
    id = "inservice"
    metric {
      namespace   = "AWS/AutoScaling"
      metric_name = "GroupInServiceInstances"
      dimensions  = { AutoScalingGroupName = each.value }
      period      = 60
      stat        = "Minimum"
    }
  }
}

# Any host in the pool failing its EC2 status checks for 10 minutes (EC2 publishes the metric per ASG).
resource "aws_cloudwatch_metric_alarm" "pool_status_check" {
  for_each = local.pool_asgs

  alarm_name          = "${var.name}-${each.key}-status-check"
  alarm_description   = "A ${each.key} job host has failed its EC2 status checks for 10 minutes"
  namespace           = "AWS/EC2"
  metric_name         = "StatusCheckFailed"
  dimensions          = { AutoScalingGroupName = each.value }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [data.aws_sns_topic.alerts.arn]
  ok_actions          = [data.aws_sns_topic.alerts.arn]
}
