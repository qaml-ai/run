# The api tier: camelfsd api as an autoscaled Fargate service (Graviton) behind the public ALB (alb.tf), the
# hosts' NLB and the enrollment listener of the internal ALB (mtls.tf).
#
# Fargate over an ASG (the README weighs it): the tier is a stateless Go process that needs no NVMe, no KVM and no
# host-level anything, so the only things an ASG would add are an AMI to bake, a host to patch and an agent to
# enroll; the runtime already runs the same shape on Fargate with a rolling deploy, a circuit breaker and
# alarm-driven rollback, and this module copies that shape so there is one way to run a service here. Cost is a
# wash at this size (2 × 1 vCPU/2 GiB ARM tasks ≈ $58/month against 2 × c8g.large ≈ $117/month, and 2 vCPU/4 GiB
# tasks ≈ $116/month) and Fargate scales by one task where an ASG scales by one instance.
#
# The service is created with the listeners (certificate_issued: a target group must belong to a balancer with a
# listener before a service can register with it) and runs api_min_count tasks: 0 by default, so it exists before
# any image does and nothing pulls the placeholder tag; autoscaling exists only with a minimum above 0. Terraform
# registers its own task definition revision, and the service RUNS it until the first deploy.sh
# (service_task_definition_arn empty): port mappings and settings Terraform adds reach the service without a deploy
# (2026-11-13: the enrollment port 8793 did not, when the service ignored task_definition and still ran an older
# revision). deploy.sh registers every later revision, rolls the service, and after a COMPLETED deployment saves
# its ARN as service_task_definition_arn in prod.tfvars, so a plan pins the revision deploy.sh chose and
# Terraform's later revision changes ship with the next deploy (which copies the family's latest revision).

locals {
  service_enabled = var.certificate_issued
  scaling_enabled = var.certificate_issued && var.api_min_count > 0
  # The enrollment and hosts target groups are registered only once the daemon listens on their ports (K4c, api_features
  # "compute"): registered earlier, their health checks (on the api port) still passed through the balancers' groups
  # only where a rule allowed it, and 2026-11-14 showed what a group without one does — Target.Timeout and ECS
  # replacing healthy tasks every few minutes.
  compute_enabled = contains(var.api_features, "compute")
  container_name  = "camelfsd"
  cluster_name    = "${var.name}-${var.env}"
  service_name    = "${var.name}-${var.env}-api"
  api_image       = "${aws_ecr_repository.camelfsd.repository_url}:${var.api_image_tag}"
  api_data_dir    = "/var/lib/camelfs"

  # The daemon's CLI, as merged on files-model. C1 (deployed first): `camelfsd api --listen --data --store --region
  # --token-issuer` with the runtime's JWKS from CAMELFS_JWKS. C2 adds --refs-table (api_features "refs");
  # --objects-table / --lineages-table come with L74 (api_extra_args until the flags exist). K4c adds
  # --listen-enroll (the enrollment-only port behind the plain-TLS listener), --listen-hosts (host routes, mutual
  # TLS terminated by the tier, behind the NLB in TCP passthrough) and --hosts-ca (the Private CA the tier issues
  # host certificates and its own from; the key stays in memory, no file flags in production: wf-durable,
  # 2026-11-14) (api_features "compute"). Go's flag package exits on an unknown flag, so a feature is switched on in
  # the same apply as the deploy that carries it. The runtime's verify JWKS is not a
  # flag: ECS injects it as CAMELFS_JWKS (the daemon also takes --jwks-file), so no key material is in the task
  # definition and the task role reads no secret. The tier's own client certificate comes from the CA at boot.
  api_command = concat(
    [
      "api",
      "--listen", "0.0.0.0:${var.api_port}",
      "--data", local.api_data_dir,
      "--store", "s3://${aws_s3_bucket.objects.bucket}",
      "--region", var.region,
      "--token-issuer", var.token_issuer,
    ],
    contains(var.api_features, "refs") ? ["--refs-table", local.table_names["refs"], "--lineages-table", local.table_names["lineages"], "--marks-table", local.table_names["marks"]] : [],
    # K4c (wf-durable's flag set, 2026-11-14): the four compute tables, the pools and their enrollment roles, the
    # enrollment and hosts listeners, the CA, and the notify webhook (its HMAC key is injected as CAMELFS_NOTIFY_KEY).
    contains(var.api_features, "compute") ? [
      "--vms-table", local.table_names["vms"],
      "--hosts-table", local.table_names["hosts"],
      "--deliveries-table", local.table_names["deliveries"],
      "--usage-table", local.table_names["usage"],
      "--pools", join(",", var.pools),
      "--listen-hosts", "0.0.0.0:${var.hosts_port}",
      "--hosts-ca", aws_acmpca_certificate_authority.hosts.arn,
      "--listen-enroll", "0.0.0.0:${var.enroll_port}",
      "--enroll-audience", "camelfs:enroll",
      "--enroll-roles", join(",", [for pool in sort(keys(var.enroll_roles)) : "${pool}=${var.enroll_roles[pool]}"]),
      "--runtime-notify-url", "${var.token_issuer}/v1/internal/camelfs/notify",
      "--guest-images", join(",", var.guest_images),
    ] : [],
    var.api_extra_args,
  )

  api_environment = {
    AWS_REGION = var.region
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
  # (The description predates the enrollment and hosts ports; changing it would replace the group.)
  vpc_id = data.aws_vpc.default.id
  tags   = { Name = "${var.name}-${var.env}-api" }
}

resource "aws_vpc_security_group_ingress_rule" "api_from_alb" {
  for_each                     = { public = aws_security_group.alb_public.id }
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

# Health checks of the enrollment and hosts target groups probe /v1/health on the API PORT (the enrollment and hosts
# ports serve no unauthenticated route), so the internal ALB's and the NLB's groups must reach the tasks on 8790
# for that one purpose. No listener forwards host traffic to 8790 (the internal ALB's only listener forwards
# POST /v1/hosts/enroll to the enrollment port; the NLB forwards to the hosts port), so these rules carry health
# checks and nothing else.
resource "aws_vpc_security_group_ingress_rule" "api_health_from_internal" {
  for_each                     = { alb_internal = aws_security_group.alb_internal.id, nlb_hosts = aws_security_group.nlb_hosts.id }
  security_group_id            = aws_security_group.api.id
  referenced_security_group_id = each.value
  ip_protocol                  = "tcp"
  from_port                    = var.api_port
  to_port                      = var.api_port
  description                  = "${each.key}: health checks on the api port"
}

resource "aws_vpc_security_group_egress_rule" "internal_health_to_api" {
  for_each                     = { alb_internal = aws_security_group.alb_internal.id, nlb_hosts = aws_security_group.nlb_hosts.id }
  security_group_id            = each.value
  referenced_security_group_id = aws_security_group.api.id
  ip_protocol                  = "tcp"
  from_port                    = var.api_port
  to_port                      = var.api_port
  description                  = "API tasks: health checks on the api port"
}

# The hosts' compute listener (K4): boot/stop pushed in-VPC. The matching ingress is on each host group (alb.tf).
resource "aws_vpc_security_group_egress_rule" "api_to_hosts_compute" {
  for_each                     = toset(var.host_security_group_ids)
  security_group_id            = aws_security_group.api.id
  referenced_security_group_id = each.value
  ip_protocol                  = "tcp"
  from_port                    = var.host_compute_port
  to_port                      = var.host_compute_port
  description                  = "Hosts' compute listener (boot/stop)"
}

# --- Task definition and service ---

resource "aws_ecs_task_definition" "api" {
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

  # No bind volume and no read-only root (2026-11-14): a Fargate bind mount (`host {}`) is an empty root-owned
  # directory, so the daemon (uid 1000) could not create storage.db under it and every task crash-looped with
  # "unable to open database file". The daemon writes only under --data, which is the image's own
  # /var/lib/camelfs (owned by camelfs) on the task's ephemeral storage; nothing on it is truth (camel-fs.md
  # §1.11), and a replaced task starts empty.

  container_definitions = jsonencode([{
    name         = local.container_name
    image        = local.api_image
    command      = local.api_command
    essential    = true
    portMappings = [{ containerPort = var.api_port, protocol = "tcp" }, { containerPort = var.enroll_port, protocol = "tcp" }, { containerPort = var.hosts_port, protocol = "tcp" }]
    environment  = [for name in sort(keys(local.api_environment)) : { name = name, value = local.api_environment[name] }]
    # Read by the execution role at task start: the runtime's public JWKS (a rotation is jwks.sh set + a roll) and
    # the notify webhook's HMAC key (§9.11; notify-key.sh; the runtime holds the same value).
    secrets = [
      { name = "CAMELFS_JWKS", valueFrom = aws_secretsmanager_secret.token_verify_keys.arn },
      { name = "CAMELFS_NOTIFY_KEY", valueFrom = aws_secretsmanager_secret.notify_key.arn },
    ]
    # The image runs as a non-root user that owns /var/lib/camelfs (the Dockerfile); see the volume note above.
    readonlyRootFilesystem = false
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
  count = local.service_enabled ? 1 : 0

  name                   = local.service_name
  cluster                = aws_ecs_cluster.camelfs.id
  task_definition        = var.service_task_definition_arn != "" ? var.service_task_definition_arn : aws_ecs_task_definition.api.arn
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

  # The enrollment port, behind the internal balancer's plain-TLS listener, and the hosts port, behind the NLB in
  # TCP passthrough (mtls.tf): registered once "compute" is on and the daemon listens there.
  dynamic "load_balancer" {
    for_each = local.compute_enabled ? { enroll = { group = aws_lb_target_group.enroll.arn, port = var.enroll_port }, hosts = { group = aws_lb_target_group.hosts.arn, port = var.hosts_port } } : {}
    content {
      target_group_arn = load_balancer.value.group
      container_name   = local.container_name
      container_port   = load_balancer.value.port
    }
  }

  depends_on = [aws_lb_listener.api_https, aws_lb_listener.enroll, aws_lb_listener.hosts]

  lifecycle {
    # Autoscaling owns the count. task_definition is NOT ignored: before the first deploy it is Terraform's
    # revision, after it the one deploy.sh saved (service_task_definition_arn).
    ignore_changes = [desired_count]
  }
}

# --- Autoscaling ---

resource "aws_appautoscaling_target" "api" {
  count = local.scaling_enabled ? 1 : 0

  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.camelfs.name}/${aws_ecs_service.api[0].name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = var.api_min_count
  max_capacity       = var.api_max_count
}

resource "aws_appautoscaling_policy" "api_cpu" {
  count = local.scaling_enabled ? 1 : 0

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
