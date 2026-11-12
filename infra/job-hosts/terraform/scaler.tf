# The scaler: a Lambda that runs every minute, asks the runtime for each pool's demand, and sizes the two ASGs.
# Its code is infra/job-hosts/scaler/index.mjs (export `handler`; ESM, Node 22, only the runtime's bundled
# @aws-sdk/client-auto-scaling and @aws-sdk/client-ssm). It:
# - scales out on waiting jobs, up to the ASG max;
# - scales in hosts idle for IDLE_MINUTES: drains them through the runtime first, then terminates them with
#   ShouldDecrementDesiredCapacity, never below the ASG min;
# - completes a terminating host's lifecycle hook once the runtime reports it has no running jobs or has
#   disconnected (pools.tf; the hook's timeout is the backstop).
# It exists only when at least one pool does.
#
# Its token is the SSM SecureString /camelrun/job-hosts/<env>/scaler-token, created by hand with the same value as
# the runtime's JOB_HOST_SCALER_TOKEN secret (README, "Scaler token"). This module only names it: no secret value in
# state. Use the default aws/ssm key (the scaler role has no kms: permission; SSM decrypts with aws/ssm for it).

locals {
  scaler_enabled         = length(local.enabled_pools) > 0
  scaler_name            = "${var.name}-scaler"
  scaler_token_parameter = "${local.ssm_parameter_prefix}/scaler-token"
  scaler_token_arn       = "arn:aws:ssm:${var.region}:${var.account_id}:parameter${local.scaler_token_parameter}"
  scaler_asg_arns        = concat(aws_autoscaling_group.build[*].arn, aws_autoscaling_group.test[*].arn)
  scaler_log_group_arn   = "arn:aws:logs:${var.region}:${var.account_id}:log-group:/aws/lambda/${local.scaler_name}"

  scaler_trust_policy = {
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  }

  # Exactly this, and nothing else (checked below and in tests/job-hosts.tftest.hcl).
  scaler_policy = {
    Version = "2012-10-17"
    Statement = [
      # Describe calls take no resource-level permissions.
      {
        Sid      = "DescribePools"
        Effect   = "Allow"
        Action   = ["autoscaling:DescribeAutoScalingGroups"]
        Resource = "*"
      },
      {
        Sid      = "SizePools"
        Effect   = "Allow"
        Action   = ["autoscaling:SetDesiredCapacity", "autoscaling:TerminateInstanceInAutoScalingGroup", "autoscaling:CompleteLifecycleAction"]
        Resource = local.scaler_asg_arns
      },
      {
        Sid      = "ReadToken"
        Effect   = "Allow"
        Action   = ["ssm:GetParameter"]
        Resource = [local.scaler_token_arn]
      },
      {
        Sid      = "OwnLogs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = ["${local.scaler_log_group_arn}:*"]
      },
    ]
  }

  scaler_expected_actions = sort([
    "autoscaling:CompleteLifecycleAction", "autoscaling:DescribeAutoScalingGroups", "autoscaling:SetDesiredCapacity",
    "autoscaling:TerminateInstanceInAutoScalingGroup", "logs:CreateLogStream", "logs:PutLogEvents", "ssm:GetParameter",
  ])
}

data "archive_file" "scaler" {
  count       = local.scaler_enabled ? 1 : 0
  type        = "zip"
  source_dir  = "${path.module}/../scaler"
  output_path = "${path.module}/.build/scaler.zip"
}

resource "aws_cloudwatch_log_group" "scaler" {
  count             = local.scaler_enabled ? 1 : 0
  name              = "/aws/lambda/${local.scaler_name}"
  retention_in_days = 14
}

resource "aws_iam_role" "scaler" {
  count              = local.scaler_enabled ? 1 : 0
  name               = local.scaler_name
  description        = "The job-host scaler Lambda. Trusts lambda.amazonaws.com only."
  assume_role_policy = jsonencode(local.scaler_trust_policy)

  lifecycle {
    precondition {
      condition = alltrue([for statement in local.scaler_trust_policy.Statement :
        statement.Effect == "Allow" && statement.Action == "sts:AssumeRole" && keys(statement.Principal) == ["Service"] && statement.Principal.Service == "lambda.amazonaws.com"
      ])
      error_message = "The scaler role must trust only lambda.amazonaws.com."
    }
  }
}

resource "aws_iam_role_policy" "scaler" {
  count  = local.scaler_enabled ? 1 : 0
  name   = "scaler"
  role   = aws_iam_role.scaler[0].id
  policy = jsonencode(local.scaler_policy)

  lifecycle {
    precondition {
      condition = (
        sort(flatten([for statement in local.scaler_policy.Statement : statement.Action])) == local.scaler_expected_actions
        && alltrue([for statement in local.scaler_policy.Statement : statement.Effect == "Allow"])
        # Only Describe may use "*"; everything else names its resources.
        && alltrue([for statement in local.scaler_policy.Statement :
          statement.Sid == "DescribePools" ? statement.Action == ["autoscaling:DescribeAutoScalingGroups"] : !contains(flatten([statement.Resource]), "*")
        ])
      )
      error_message = "The scaler may only describe the ASGs, size and terminate in the two pools, complete their lifecycle hooks, read its token and write its own logs."
    }
  }
}

resource "aws_lambda_function" "scaler" {
  count         = local.scaler_enabled ? 1 : 0
  function_name = local.scaler_name
  description   = "Sizes the camelRun job-host pools from the runtime's demand, every minute."
  role          = aws_iam_role.scaler[0].arn

  filename         = data.archive_file.scaler[0].output_path
  source_code_hash = data.archive_file.scaler[0].output_base64sha256
  handler          = "index.handler"
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  memory_size      = 128
  timeout          = 50
  # One run at a time: two scalers deciding at once could double a scale-out or drain the same host twice.
  reserved_concurrent_executions = 1

  environment {
    variables = {
      RUNTIME_URL     = local.runtime_url
      TOKEN_PARAMETER = local.scaler_token_parameter
      BUILD_ASG       = try(aws_autoscaling_group.build[0].name, "")
      TEST_ASG        = try(aws_autoscaling_group.test[0].name, "")
      IDLE_MINUTES    = tostring(var.scaler_idle_minutes)
      BUILD_SLOTS     = "1"
      TEST_SLOTS      = "8"
    }
  }

  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.scaler[0].name
  }

  depends_on = [aws_iam_role_policy.scaler, aws_cloudwatch_log_group.scaler]
}

resource "aws_cloudwatch_event_rule" "scaler" {
  count               = local.scaler_enabled ? 1 : 0
  name                = local.scaler_name
  description         = "Runs the job-host scaler every minute."
  schedule_expression = "rate(1 minute)"
}

resource "aws_cloudwatch_event_target" "scaler" {
  count = local.scaler_enabled ? 1 : 0
  rule  = aws_cloudwatch_event_rule.scaler[0].name
  arn   = aws_lambda_function.scaler[0].arn
}

resource "aws_lambda_permission" "scaler" {
  count         = local.scaler_enabled ? 1 : 0
  statement_id  = "EveryMinute"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.scaler[0].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.scaler[0].arn
}

# Failing runs for 15 minutes in a row: the pools stop following demand (no scale-out, no drain, hooks left to time
# out). A single failed minute does not page.
resource "aws_cloudwatch_metric_alarm" "scaler_errors" {
  count               = local.scaler_enabled ? 1 : 0
  alarm_name          = "${local.scaler_name}-errors"
  alarm_description   = "The job-host scaler has failed every 5 minutes for 15 minutes (see its log group)"
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.scaler[0].function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [data.aws_sns_topic.alerts.arn]
  ok_actions          = [data.aws_sns_topic.alerts.arn]
}
