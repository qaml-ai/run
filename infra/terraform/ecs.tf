# the runtime as an autoscaled Fargate service behind the ALB (alb.tf).
# Terraform registers the first task definition revision; infra/ecs-deploy.sh
# registers every later one (new image) and rolls the service, so the service
# ignores task_definition. See README.md, "Deploying".

locals {
  runtime_port   = 8790
  container_name = "agent-runtime"
  # Names, not resource references: the task definition must not depend on the
  # service that runs it.
  cluster_name = var.name
  service_name = var.name

  runtime_image = "${aws_ecr_repository.runtime.repository_url}:${var.runtime_image_tag}"

  runtime_environment = merge(var.runtime_env, local.email_environment, local.account_email_environment, local.billing_environment, local.admin_environment, var.openai_apps_challenge == "" ? {} : {
    AGENT_OPENAI_APPS_CHALLENGE = var.openai_apps_challenge
    }, var.storage_gc_enabled ? {
    AGENT_GC_ENABLED = "true"
    AGENT_GC_DRY_RUN = tostring(var.storage_gc_dry_run)
    } : {}, var.discord_managed_enabled ? {
    AGENT_DISCORD_MANAGED_ENABLED    = "true"
    AGENT_DISCORD_MANAGED_SECRET_ARN = aws_secretsmanager_secret.runtime["discord-managed"].arn
    } : {}, {
    # Where people are sent; the other hostname is served too, and the issuer
    # stays the first hostname, which tool servers and MCP clients check.
    AGENT_PUBLIC_URL     = "https://${var.public_hostname}"
    AGENT_PUBLIC_ALIASES = join(",", [for host in [var.hostname, var.primary_hostname] : "https://${host}" if host != var.public_hostname])
    AGENT_ISSUER         = "https://${var.hostname}"
    AGENT_STORAGE        = "s3"
    AGENT_S3_BUCKET      = aws_s3_bucket.state.id
    AGENT_S3_PREFIX      = var.state_prefix
    AWS_REGION           = var.region
    # Only Cloudflare reaches the ALB (alb.tf), so CF-Connecting-IP is the client's address; per-address rate limits key on it.
    AGENT_TRUST_CF_CONNECTING_IP = "true"
    # Through RDS Proxy (rds-proxy.tf). The bundle holds the RDS CAs and the
    # Amazon Trust Services roots that sign the proxy's certificate.
    AGENT_DATABASE_HOST       = aws_db_proxy.control.endpoint
    AGENT_DATABASE_NAME       = aws_db_instance.control.db_name
    AGENT_DATABASE_SECRET_ARN = aws_db_instance.control.master_user_secret[0].secret_arn
    AGENT_DATABASE_CA         = "/etc/ssl/rds-global-bundle.pem"
    # Notifications (a node that loads an agent tells the others) on the instance itself:
    # RDS Proxy does not carry LISTEN reliably. A missed one is caught by a 20 s check.
    AGENT_DATABASE_LISTEN_HOST = aws_db_instance.control.address
    # Longer than the database is away in a Multi-AZ failover, so nodes ride it
    # out instead of fencing; only crash takeover waits this long.
    AGENT_LEASE_TTL_MS       = "90000"
    AGENT_TENANTS_SECRET_ARN = aws_secretsmanager_secret.runtime["tenants"].arn
    # The runtime reads these itself (task role), so no secret value is in its
    # environment, where a sandbox child with the same uid could read it.
    AGENT_SESSION_SECRET_ARN      = aws_secretsmanager_secret.runtime["session-secret"].arn
    AGENT_SECRETS_KEY_ARN         = aws_secretsmanager_secret.runtime["secrets-key"].arn
    AGENT_GITHUB_OAUTH_SECRET_ARN = aws_secretsmanager_secret.runtime["github-oauth"].arn
    # Google sign-in stays off until infra/google-oauth.sh stores a value in it.
    AGENT_GOOGLE_OAUTH_SECRET_ARN = aws_secretsmanager_secret.runtime["google-oauth"].arn
    # Credit purchases stay off until infra/stripe.sh stores a value in it.
    AGENT_STRIPE_SECRET_ARN = aws_secretsmanager_secret.runtime["stripe"].arn
    # tools.search: embeddings rank the catalog by meaning, then Jev drops irrelevant tools, with the
    # platform's OpenRouter key (tenants secret) unless infra/tool-search.sh stores a dedicated one.
    # A stage that fails is skipped per search.
    AGENT_TOOL_SEARCH            = "embeddings,jev"
    AGENT_TOOL_SEARCH_SECRET_ARN = aws_secretsmanager_secret.runtime["tool-search"].arn
    # Scale-in protection while turns run, and retirement once superseded.
    AGENT_ECS_CLUSTER = local.cluster_name
    AGENT_ECS_SERVICE = local.service_name
    # ServiceName dimension on the AgentRuntime EMF metrics.
    AGENT_SERVICE_NAME = local.service_name
    # Tool sources (MCP servers, HTTP tools, web_fetch) never reach the VPC, on top of the private ranges the runtime always refuses.
    AGENT_OUTBOUND_BLOCK_CIDRS = data.aws_vpc.default.cidr_block
  })
}

resource "aws_cloudwatch_log_group" "runtime" {
  name              = "/ecs/${var.name}"
  retention_in_days = 30
}

# Container Insights writes task and container performance events (metrics only, no
# application output) here. ECS creates the group with 1-day retention when it is
# missing; declaring it keeps that retention in code. Metrics derived from it are kept
# by CloudWatch Metrics, not this group. An existing group is imported, not recreated.
resource "aws_cloudwatch_log_group" "container_insights" {
  name              = "/aws/ecs/containerinsights/${local.cluster_name}/performance"
  retention_in_days = 1
}

resource "aws_ecs_cluster" "runtime" {
  name = local.cluster_name

  setting {
    name  = "containerInsights"
    value = var.container_insights
  }

  # So a new cluster finds the group with its retention, not one ECS made without it.
  depends_on = [aws_cloudwatch_log_group.container_insights]
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

# Used by ECS itself: pull the image and write logs.
resource "aws_iam_role" "task_execution" {
  name               = "${var.name}-task-execution"
  description        = "Agent runtime ECS task execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "task_execution" {
  role       = aws_iam_role.task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Used by the runtime process: agent state in S3, the secrets it reads itself,
# its own task's scale-in protection, the service's deployments (to notice it
# has been superseded), and ECS Exec.
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
          aws_secretsmanager_secret.runtime["session-secret"].arn,
          aws_secretsmanager_secret.runtime["secrets-key"].arn,
          aws_secretsmanager_secret.runtime["github-oauth"].arn,
          aws_secretsmanager_secret.runtime["google-oauth"].arn,
          aws_secretsmanager_secret.runtime["stripe"].arn,
          aws_secretsmanager_secret.runtime["tool-search"].arn,
          aws_secretsmanager_secret.runtime["discord-managed"].arn,
        ]
      },
      {
        Sid      = "OwnTaskProtection"
        Effect   = "Allow"
        Action   = ["ecs:UpdateTaskProtection", "ecs:GetTaskProtection"]
        Resource = "arn:aws:ecs:${var.region}:${var.account_id}:task/${local.cluster_name}/*"
      },
      {
        Sid      = "ServiceDeployments"
        Effect   = "Allow"
        Action   = "ecs:DescribeServices"
        Resource = "arn:aws:ecs:${var.region}:${var.account_id}:service/${local.cluster_name}/${local.service_name}"
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

# Model providers, S3, RDS and Secrets Manager.
resource "aws_vpc_security_group_egress_rule" "task_all_ipv4" {
  security_group_id = aws_security_group.task.id
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

# The runtime connects through the proxy (rds-proxy.tf); this keeps the
# instance endpoint reachable from a task for debugging and manual migrations.
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
    name         = local.container_name
    image        = local.runtime_image
    essential    = true
    portMappings = [{ containerPort = local.runtime_port, protocol = "tcp" }]
    environment  = [for name in sort(keys(local.runtime_environment)) : { name = name, value = local.runtime_environment[name] }]
    # SIGTERM starts the runtime's drain (about 100 s); SIGKILL follows after this.
    stopTimeout = 120
    # An init as PID 1 forwards signals and reaps the sandbox children. The
    # image's entrypoint (agent-launcher) starts as root and needs Fargate's
    # default SETUID, SETGID, CHOWN and KILL capabilities to run the runtime and
    # the js_exec sandbox processes as their own uids: set no `user` here and
    # drop none of those.
    linuxParameters = { initProcessEnabled = true }
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
  name                   = local.service_name
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

  # The runtime protects its task from scale-in while turns run, and ECS waits
  # for protected old tasks during a deploy: a deploy can last as long as the
  # longest turn (the runtime caps it at AGENT_RETIRE_MAX_MS, default 6 h). The
  # circuit breaker counts failed task launches, not elapsed time, so waiting
  # on protected tasks never trips it.
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

# Example: scale on the runtime's EMF metric AgentRuntime/hostedAgents (agents
# started per task, what AGENT_MAX_AGENTS caps; dimension ServiceName from
# AGENT_SERVICE_NAME) instead of, or as well as, CPU and memory. The metric
# `sessions` counts agents loaded per task, hosted or not; `agents` is the older
# name of hostedAgents. Pick target_value from observed load.
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
#       metric_name = "hostedAgents"
#       statistic   = "Average"
#       dimensions {
#         name  = "ServiceName"
#         value = aws_ecs_service.runtime.name
#       }
#     }
#   }
# }
