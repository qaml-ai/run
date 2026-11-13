# The api tier: camelfsd --role api as an autoscaled Fargate service (Graviton) behind both load balancers (alb.tf).
#
# Fargate over an ASG (the README weighs it): the tier is a stateless Go process that needs no NVMe, no KVM and no
# host-level anything, so the only things an ASG would add are an AMI to bake, a host to patch and an agent to
# enroll; the runtime already runs the same shape on Fargate with a rolling deploy, a circuit breaker and
# alarm-driven rollback, and this module copies that shape so there is one way to run a service here. Cost is a
# wash at this size (2 × 1 vCPU/2 GiB ARM tasks ≈ $58/month against 2 × c8g.large ≈ $117/month, and 2 vCPU/4 GiB
# tasks ≈ $116/month) and Fargate scales by one task where an ASG scales by one instance.
#
# The service exists only once api_image_tag names an image in this module's ECR repository (deploy.sh pushes
# one): with an empty tag there is no task definition, service, autoscaling or service alarm, so the foundation
# (bucket, tables, roles, secrets, balancers, registry) can be applied first and an empty image can never reach
# a task. Terraform registers the first task definition revision; deploy.sh registers every later one and rolls
# the service, so the service ignores task_definition.

locals {
  api_enabled    = var.api_image_tag != ""
  container_name = "camelfsd"
  cluster_name   = "${var.name}-${var.env}"
  service_name   = "${var.name}-${var.env}-api"
  api_image      = "${aws_ecr_repository.camelfsd.repository_url}:${var.api_image_tag}"
  api_data_dir   = "/var/lib/camelfs"

  # What the daemon needs to find its stores and keys. Names, ARNs and a listen address: no secret value is in the
  # environment (the task reads the verify keys itself, by ARN, with its task role).
  api_environment = {
    CAMELFS_ROLE                  = "api"
    CAMELFS_LISTEN                = "0.0.0.0:${var.api_port}"
    CAMELFS_DATA                  = local.api_data_dir
    CAMELFS_STORE                 = "s3://${aws_s3_bucket.objects.bucket}"
    CAMELFS_OBJECTS_TABLE         = local.table_names["objects"]
    CAMELFS_REFS_TABLE            = local.table_names["refs"]
    CAMELFS_LINEAGES_TABLE        = local.table_names["lineages"]
    CAMELFS_TOKEN_KEYS_SECRET_ARN = aws_secretsmanager_secret.token_verify_keys.arn
    CAMELFS_PUBLIC_URL            = "https://${var.hostname}"
    CAMELFS_INTERNAL_URL          = "https://${var.internal_hostname}"
    AWS_REGION                    = var.region
  }
}

# --- Container registry ---

resource "aws_ecr_repository" "camelfsd" {
  name                 = "${var.name}-${var.env}"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

# Keep the last 20 images: a rollback target or two and the history of a bad week; the rest is rebuildable.
resource "aws_ecr_lifecycle_policy" "camelfsd" {
  repository = aws_ecr_repository.camelfsd.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the newest 20 images"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 20 }
      action       = { type = "expire" }
    }]
  })
}

# --- Cluster and logs ---

resource "aws_cloudwatch_log_group" "api" {
  name              = "/ecs/${local.service_name}"
  retention_in_days = var.api_log_retention_days
}

# Container Insights writes task performance events (metrics only) here; declaring it keeps the retention short.
resource "aws_cloudwatch_log_group" "container_insights" {
  name              = "/aws/ecs/containerinsights/${local.cluster_name}/performance"
  retention_in_days = 1
}

resource "aws_ecs_cluster" "camelfs" {
  name = local.cluster_name

  # RunningTaskCount for the running-tasks alarm.
  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  depends_on = [aws_cloudwatch_log_group.container_insights]
}

# --- Network ---

resource "aws_security_group" "api" {
  name        = "${var.name}-${var.env}-api"
  description = "camelFS api tasks: the API port from the two load balancers"
  vpc_id      = data.aws_vpc.default.id
  tags        = { Name = "${var.name}-${var.env}-api" }
}

resource "aws_vpc_security_group_ingress_rule" "api_from_alb" {
  for_each                     = { public = aws_security_group.alb_public.id, internal = aws_security_group.alb_internal.id }
  security_group_id            = aws_security_group.api.id
  referenced_security_group_id = each.value
  ip_protocol                  = "tcp"
  from_port                    = var.api_port
  to_port                      = var.api_port
  description                  = "${each.key} load balancer"
}

# S3, DynamoDB, Secrets Manager, ECR and CloudWatch Logs, over the internet gateway (the default subnets have no
# NAT and no gateway endpoints; the runtime's tasks go the same way). In-region S3 and DynamoDB transfer is free.
resource "aws_vpc_security_group_egress_rule" "api_https" {
  security_group_id = aws_security_group.api.id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
  description       = "S3, DynamoDB, Secrets Manager, ECR, logs"
}

# --- Task definition and service (once an image is named) ---

resource "aws_ecs_task_definition" "api" {
  count = local.api_enabled ? 1 : 0

  family                   = local.service_name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.api_cpu
  memory                   = var.api_memory
  execution_role_arn       = aws_iam_role.api_execution.arn
  task_role_arn            = aws_iam_role.api.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }

  # The only writable path: the task's ephemeral storage, for the daemon's host-local SQLite caches (CAMELFS_DATA).
  # Nothing on it is truth (camel-fs.md §1.11); a replaced task starts empty.
  volume {
    name = "data"
  }

  container_definitions = jsonencode([{
    name         = local.container_name
    image        = local.api_image
    command      = var.api_command
    essential    = true
    portMappings = [{ containerPort = var.api_port, protocol = "tcp" }]
    environment  = [for name in sort(keys(local.api_environment)) : { name = name, value = local.api_environment[name] }]
    mountPoints  = [{ sourceVolume = "data", containerPath = local.api_data_dir, readOnly = false }]
    # The image runs as a non-root user; everything but the data volume is read-only.
    readonlyRootFilesystem = true
    # SIGTERM: finish in-flight requests (seconds); SIGKILL after this.
    stopTimeout     = 30
    linuxParameters = { initProcessEnabled = true }
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.api.name
        awslogs-region        = var.region
        awslogs-stream-prefix = "api"
        mode                  = "non-blocking"
        max-buffer-size       = "25m"
      }
    }
  }])
}

resource "aws_ecs_service" "api" {
  count = local.api_enabled ? 1 : 0

  name                   = local.service_name
  cluster                = aws_ecs_cluster.camelfs.id
  task_definition        = aws_ecs_task_definition.api[0].arn
  desired_count          = var.api_min_count
  launch_type            = "FARGATE"
  platform_version       = "LATEST"
  enable_execute_command = true
  propagate_tags         = "SERVICE"

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  health_check_grace_period_seconds  = 30
  availability_zone_rebalancing      = "ENABLED"

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  # A release whose tasks pass the health check but fail requests rolls back while the deployment is watched.
  alarms {
    enable   = true
    rollback = true
    alarm_names = [
      aws_cloudwatch_metric_alarm.target_5xx["public"].alarm_name,
      aws_cloudwatch_metric_alarm.unhealthy_hosts["public"].alarm_name,
    ]
  }

  network_configuration {
    subnets          = data.aws_subnets.default.ids
    assign_public_ip = true
    security_groups  = [aws_security_group.api.id]
  }

  dynamic "load_balancer" {
    for_each = aws_lb_target_group.api
    content {
      target_group_arn = load_balancer.value.arn
      container_name   = local.container_name
      container_port   = var.api_port
    }
  }

  depends_on = [aws_lb_listener.api_https]

  lifecycle {
    # deploy.sh rolls new task definition revisions; autoscaling owns the count.
    ignore_changes = [task_definition, desired_count]
  }
}

# --- Autoscaling ---

resource "aws_appautoscaling_target" "api" {
  count = local.api_enabled ? 1 : 0

  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.camelfs.name}/${aws_ecs_service.api[0].name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = var.api_min_count
  max_capacity       = var.api_max_count
}

resource "aws_appautoscaling_policy" "api_cpu" {
  count = local.api_enabled ? 1 : 0

  name               = "${local.service_name}-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.api[0].service_namespace
  resource_id        = aws_appautoscaling_target.api[0].resource_id
  scalable_dimension = aws_appautoscaling_target.api[0].scalable_dimension

  target_tracking_scaling_policy_configuration {
    target_value       = var.api_cpu_target
    scale_out_cooldown = 60
    scale_in_cooldown  = 300

    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}
