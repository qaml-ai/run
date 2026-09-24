# GitHub Actions deploys main (.github/workflows/deploy.yml) by assuming this role
# through the account's existing GitHub OIDC provider. Only jobs in the repository's
# `production` environment can assume it; add required reviewers to that environment
# in GitHub to gate deploys on an approval.

data "aws_iam_openid_connect_provider" "github" {
  url = "https://token.actions.githubusercontent.com"
}

resource "aws_iam_role" "github_deploy" {
  name = "${var.name}-github-deploy"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = data.aws_iam_openid_connect_provider.github.arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          "token.actions.githubusercontent.com:sub" = "repo:${var.github_repository}:environment:production"
        }
      }
    }]
  })
}

# What infra/ecs-deploy.sh does: push the image, register a task definition
# revision copied from the latest, roll the service and watch it become healthy.
resource "aws_iam_role_policy" "github_deploy" {
  name = "ecs-deploy"
  role = aws_iam_role.github_deploy.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = "ecr:GetAuthorizationToken", Resource = "*" },
      {
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:CompleteLayerUpload", "ecr:DescribeImages",
          "ecr:GetDownloadUrlForLayer", "ecr:InitiateLayerUpload", "ecr:PutImage", "ecr:UploadLayerPart",
        ]
        Resource = aws_ecr_repository.runtime.arn
      },
      # Task definitions can't be scoped by family for these two actions.
      { Effect = "Allow", Action = ["ecs:DescribeTaskDefinition", "ecs:RegisterTaskDefinition"], Resource = "*" },
      { Effect = "Allow", Action = ["ecs:TagResource"], Resource = "arn:aws:ecs:${var.region}:${var.account_id}:task-definition/${var.name}:*" },
      {
        Effect   = "Allow"
        Action   = ["ecs:DescribeServices", "ecs:UpdateService"]
        Resource = "arn:aws:ecs:${var.region}:${var.account_id}:service/${var.name}/${var.name}"
      },
      {
        Effect    = "Allow"
        Action    = ["ecs:ListTasks", "ecs:DescribeTasks"]
        Resource  = "*"
        Condition = { ArnEquals = { "ecs:cluster" = "arn:aws:ecs:${var.region}:${var.account_id}:cluster/${var.name}" } }
      },
      {
        Effect    = "Allow"
        Action    = "iam:PassRole"
        Resource  = [aws_iam_role.task.arn, aws_iam_role.task_execution.arn]
        Condition = { StringEquals = { "iam:PassedToService" = "ecs-tasks.amazonaws.com" } }
      },
      {
        Effect   = "Allow"
        Action   = ["elasticloadbalancing:DescribeTargetGroups", "elasticloadbalancing:DescribeTargetHealth", "elasticloadbalancing:DescribeLoadBalancers"]
        Resource = "*"
      },
    ]
  })
}

output "github_deploy_role_arn" {
  description = "Set as the AWS_DEPLOY_ROLE_ARN variable of the repository's production environment."
  value       = aws_iam_role.github_deploy.arn
}
