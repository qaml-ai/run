// An MCP server for your own AWS account: one Lambda, one Function URL, no shared secret.
//
// camelRun's runtime signs a short-lived token for every tool call naming the tenant, the agent and
// whom it acts for; this function checks that token against the runtime's published keys and then
// makes the read with its own role. Nothing key-shaped ever reaches the agent, and every call is
// attributable to one agent acting for one person.
//
//   terraform init && terraform plan -var 'allowed_tenants=["your-tenant-id"]'
//
// Get your tenant id from GET /v1/me on the runtime (or the SDK's agents.runtime.me()).
terraform {
  required_version = ">= 1.6"
  required_providers {
    aws     = { source = "hashicorp/aws", version = "~> 6.0" }
    archive = { source = "hashicorp/archive", version = "~> 2.4" }
  }
}

provider "aws" { region = var.region }

variable "region" {
  description = "Where the function and its calls run."
  default     = "us-west-2"
}

variable "allowed_tenants" {
  description = "The camelRun tenants whose agents may call this proxy. Anyone else's tokens are refused: any tenant can make an agent and point it at your URL."
  type        = list(string)
}

variable "audience" {
  description = "What the runtime's tokens must be for. Leave empty: the function uses its own URL, which is what the runtime signs. Set it only behind a custom domain, or to match a definition's `audience` name."
  default     = ""
}

variable "function_name" {
  description = "Name of the function, its role and its log group."
  default     = "aws-mcp-proxy"
}

data "archive_file" "handler" {
  type        = "zip"
  source_file = "${path.module}/handler.mjs"
  output_path = "${path.module}/.build/handler.zip"
}

resource "aws_iam_role" "proxy" {
  name = "${var.function_name}-role"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

// Reads only, on the services the proxy speaks. Everything that returns object data, secrets or
// credentials is absent on purpose: the proxy refuses those too, and IAM is the layer that counts.
// Narrow this to what your agents actually need.
resource "aws_iam_role_policy" "reads" {
  name = "${var.function_name}-reads"
  role = aws_iam_role.proxy.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "DescribeWhatIsRunning", Effect = "Allow", Action = ["ec2:Describe*", "ecs:Describe*", "ecs:List*", "sts:GetCallerIdentity"], Resource = "*" },
      { Sid = "MetricsAndAlarms", Effect = "Allow", Action = ["cloudwatch:GetMetricData", "cloudwatch:GetMetricStatistics", "cloudwatch:DescribeAlarms", "cloudwatch:DescribeAlarmHistory", "cloudwatch:ListMetrics", "cloudwatch:ListDashboards", "cloudwatch:GetDashboard"], Resource = "*" },
      { Sid = "LogsInsights", Effect = "Allow", Action = ["logs:DescribeLogGroups", "logs:DescribeLogStreams", "logs:StartQuery", "logs:GetQueryResults", "logs:StopQuery", "logs:DescribeQueries"], Resource = "*" },
      { Sid = "IdentityReads", Effect = "Allow", Action = ["iam:Get*", "iam:List*"], Resource = "*" },
    ]
  })
}

resource "aws_cloudwatch_log_group" "logs" {
  name              = "/aws/lambda/${var.function_name}"
  retention_in_days = 14
}

resource "aws_lambda_function" "proxy" {
  function_name    = var.function_name
  role             = aws_iam_role.proxy.arn
  runtime          = "nodejs22.x"
  handler          = "handler.handler"
  filename         = data.archive_file.handler.output_path
  source_code_hash = data.archive_file.handler.output_base64sha256
  timeout          = 30
  memory_size      = 256
  environment {
    variables = merge(
      { RUNTIME_TENANTS = join(",", var.allowed_tenants) },
      var.audience == "" ? {} : { RUNTIME_AUDIENCE = var.audience },
    )
  }
  depends_on = [aws_cloudwatch_log_group.logs]
}

// Public HTTPS, so camelRun's outbound guard can reach it. The token is the only door: no secret.
resource "aws_lambda_function_url" "url" {
  function_name      = aws_lambda_function.proxy.function_name
  authorization_type = "NONE"
}

resource "aws_lambda_permission" "public" {
  statement_id           = "FunctionURLPublic"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.proxy.function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}

output "url" { value = "${aws_lambda_function_url.url.function_url}mcp" }
output "role_arn" { value = aws_iam_role.proxy.arn }
