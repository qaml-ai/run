# NEW: the runtime as an autoscaled Fargate service behind the ALB (alb.tf).
# Terraform registers the first task definition revision; infra/ecs-deploy.sh
# registers every later one (new image) and rolls the service, so the service
# ignores task_definition. See README.md, "Deploying".

locals {
  runtime_port   = 8790
  container_name = "agent-runtime"

  runtime_image = "${aws_ecr_repository.runtime.repository_url}:${var.runtime_image_tag}"

  runtime_environment = merge(var.runtime_env, {
    AGENT_PUBLIC_URL          = "https://${var.hostname}"
    AGENT_STORAGE             = "s3"
    AGENT_S3_BUCKET           = aws_s3_bucket.state.id
    AGENT_S3_PREFIX           = var.state_prefix
    AWS_REGION                = var.region
    AGENT_DATABASE_HOST       = aws_db_instance.control.address
    AGENT_DATABASE_SECRET_ARN = aws_db_instance.control.master_user_secret[0].secret_arn
    AGENT_DATABASE_CA         = "/etc/ssl/rds-global-bundle.pem"
    AGENT_TENANTS_SECRET_ARN  = aws_secretsmanager_secret.runtime["tenants"].arn
    }, local.executor_enabled ? {
    AGENT_EXECUTOR_URL           = local.executor_url
    AGENT_EXECUTOR_CALLBACK_PORT = tostring(var.executor_callback_port)
  } : {})

  # Injected by ECS at task start from Secrets Manager (execution role).
  github_oauth_arn = aws_secretsmanager_secret.runtime["github-oauth"].arn
  runtime_secrets = merge({
    AGENT_SESSION_SECRET = aws_secretsmanager_secret.runtime["session-secret"].arn
    AGENT_SECRETS_KEY    = aws_secretsmanager_secret.runtime["secrets-key"].arn
    GITHUB_CLIENT_ID     = "${local.github_oauth_arn}:clientId::"
    GITHUB_CLIENT_SECRET = "${local.github_oauth_arn}:clientSecret::"
    }, local.executor_enabled ? {
    AGENT_EXECUTOR_TOKEN = aws_secretsmanager_secret.executor_token[0].arn
  } : {})
}

resource "aws_cloudwatch_log_group" "runtime" {
  name              = "/ecs/${var.name}"
  retention_in_days = 30
}

resource "aws_ecs_cluster" "runtime" {
  name = var.name

  setting {
    name  = "containerInsights"
    value = var.container_insights
  }
}

# --- IAM ---

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:aws:ecs:${var.region}:${var.account_id}:*"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.account_id]
    }
  }
}

# Used by ECS itself: pull the image, write logs, resolve `secrets`.
resource "aws_iam_role" "task_execution" {
  name               = "${var.name}-task-execution"
  description        = "Agent runtime ECS task execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "task_execution" {
  role       = aws_iam_role.task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "task_execution_secrets" {
  name = "agent-runtime-task-secrets"
  role = aws_iam_role.task_execution.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = "secretsmanager:GetSecretValue"
      Resource = distinct([
        for value in values(local.runtime_secrets) : regex("^arn:aws:secretsmanager:[^:]+:[^:]+:secret:[^:]+", value)
      ])
    }]
  })
}

# Used by the runtime process: agent state in S3, the database and tenants
# secrets it reads itself, and ECS Exec.
resource "aws_iam_role" "task" {
  name               = "${var.name}-task"
  description        = "Agent runtime ECS task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy" "task" {
  name = "agent-runtime-task"
  role = aws_iam_role.task.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(local.state_bucket_statements, [
      {
        Sid    = "RuntimeSecrets"
        Effect = "Allow"
        Action = "secretsmanager:GetSecretValue"
        Resource = [
          aws_db_instance.control.master_user_secret[0].secret_arn,
          aws_secretsmanager_secret.runtime["tenants"].arn,
        ]
      },
      {
        Sid    = "EcsExec"
        Effect = "Allow"
        Action = [
          "ssmmessages:CreateControlChannel",
          "ssmmessages:CreateDataChannel",
          "ssmmessages:OpenControlChannel",
          "ssmmessages:OpenDataChannel",
        ]
        Resource = "*"
      },
    ])
  })
}

# --- Network ---

resource "aws_security_group" "task" {
  name        = "${var.name}-task"
  description = "Agent runtime ECS tasks: 8790 from the ALB and each other"
  vpc_id      = data.aws_vpc.default.id
  tags        = { Name = "${var.name}-task" }
}

resource "aws_vpc_security_group_ingress_rule" "task_from_alb" {
  security_group_id            = aws_security_group.task.id
  referenced_security_group_id = aws_security_group.alb.id
  ip_protocol                  = "tcp"
  from_port                    = local.runtime_port
  to_port                      = local.runtime_port
  description                  = "ALB"
}

# Node-to-node forwarding to the task that owns an agent.
resource "aws_vpc_security_group_ingress_rule" "task_from_task" {
  security_group_id            = aws_security_group.task.id
  referenced_security_group_id = aws_security_group.task.id
  ip_protocol                  = "tcp"
  from_port                    = local.runtime_port
  to_port                      = local.runtime_port
  description                  = "Runtime nodes"
}

# Model providers, S3, RDS, Secrets Manager and executors.
resource "aws_vpc_security_group_egress_rule" "task_all_ipv4" {
  security_group_id = aws_security_group.task.id
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_ingress_rule" "database_from_task" {
  security_group_id            = aws_security_group.database.id
  referenced_security_group_id = aws_security_group.task.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "Postgres from runtime ECS tasks"
}

# --- Task definition and service ---

resource "aws_ecs_task_definition" "runtime" {
  family                   = var.name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }

  container_definitions = jsonencode([{
    name      = local.container_name
    image     = local.runtime_image
    essential = true
    portMappings = concat(
      [{ containerPort = local.runtime_port, protocol = "tcp" }],
      local.executor_enabled ? [{ containerPort = var.executor_callback_port, protocol = "tcp" }] : [],
    )
    environment = [for name in sort(keys(local.runtime_environment)) : { name = name, value = local.runtime_environment[name] }]
    secrets     = [for name in sort(keys(local.runtime_secrets)) : { name = name, valueFrom = local.runtime_secrets[name] }]
    # SIGTERM starts the runtime's drain (about 100 s); SIGKILL follows after this.
    stopTimeout = 120
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.runtime.name
        awslogs-region        = var.region
        awslogs-stream-prefix = "runtime"
        mode                  = "non-blocking"
        max-buffer-size       = "25m"
      }
    }
  }])
}

resource "aws_ecs_service" "runtime" {
  name                   = var.name
  cluster                = aws_ecs_cluster.runtime.id
  task_definition        = aws_ecs_task_definition.runtime.arn
  desired_count          = var.service_min_count
  launch_type            = "FARGATE"
  platform_version       = "LATEST"
  enable_execute_command = true
  propagate_tags         = "SERVICE"

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  health_check_grace_period_seconds  = 60
  availability_zone_rebalancing      = "ENABLED"

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets = data.aws_subnets.default.ids
    # No NAT: tasks reach model providers through the internet gateway.
    assign_public_ip = true
    security_groups  = [aws_security_group.task.id]
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.runtime.arn
    container_name   = local.container_name
    container_port   = local.runtime_port
  }

  depends_on = [aws_lb_listener.https]

  lifecycle {
    # infra/ecs-deploy.sh rolls new task definition revisions; autoscaling owns the count.
    ignore_changes = [task_definition, desired_count]
  }
}

# --- Autoscaling ---

resource "aws_appautoscaling_target" "runtime" {
  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.runtime.name}/${aws_ecs_service.runtime.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = var.service_min_count
  max_capacity       = var.service_max_count
}

resource "aws_appautoscaling_policy" "runtime" {
  for_each = {
    cpu    = { metric = "ECSServiceAverageCPUUtilization", target = var.service_cpu_target }
    memory = { metric = "ECSServiceAverageMemoryUtilization", target = var.service_memory_target }
  }
  name               = "${var.name}-${each.key}"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.runtime.service_namespace
  resource_id        = aws_appautoscaling_target.runtime.resource_id
  scalable_dimension = aws_appautoscaling_target.runtime.scalable_dimension

  target_tracking_scaling_policy_configuration {
    target_value       = each.value.target
    scale_out_cooldown = 60
    # Scale-in drains agents off a task; don't do it on a brief dip.
    scale_in_cooldown = 300

    predefined_metric_specification {
      predefined_metric_type = each.value.metric
    }
  }
}

# Example: scale on a runtime EMF metric (namespace AgentRuntime) instead of,
# or as well as, CPU and memory. The metric must be an average per task for
# target tracking to work; set its name and dimensions to what the runtime emits.
#
# resource "aws_appautoscaling_policy" "runtime_active_agents" {
#   name               = "${var.name}-active-agents"
#   policy_type        = "TargetTrackingScaling"
#   service_namespace  = aws_appautoscaling_target.runtime.service_namespace
#   resource_id        = aws_appautoscaling_target.runtime.resource_id
#   scalable_dimension = aws_appautoscaling_target.runtime.scalable_dimension
#
#   target_tracking_scaling_policy_configuration {
#     target_value       = 40
#     scale_out_cooldown = 60
#     scale_in_cooldown  = 300
#
#     customized_metric_specification {
#       namespace   = "AgentRuntime"
#       metric_name = "ActiveAgents"
#       statistic   = "Average"
#       dimensions {
#         name  = "Service"
#         value = aws_ecs_service.runtime.name
#       }
#     }
#   }
# }
