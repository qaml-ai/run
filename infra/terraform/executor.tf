# NEW: the code executor tier, created only when executor_enabled. Executors run
# model-written code under gVisor in private subnets with no internet route:
# they reach AWS through VPC endpoints and the runtime tasks' callback port,
# nothing else. The runtime reaches them through an internal NLB that only
# routes to healthy hosts. The AMI (Packer, infra/executor) carries Docker and
# gVisor; user data (infra/executor/user-data.sh) pulls the image and reads the
# executor token from Secrets Manager at boot, so no secret is in the template.

locals {
  executor_subnet_ids   = [for az in sort(keys(var.executor_private_subnets)) : aws_subnet.executor[az].id if local.executor_enabled]
  executor_endpoint_ids = slice(local.executor_subnet_ids, 0, min(var.executor_endpoint_az_count, length(local.executor_subnet_ids)))
  executor_image        = coalesce(var.executor_image, local.runtime_image)
  executor_url          = local.executor_enabled ? "http://${aws_lb.executor[0].dns_name}:${var.executor_port}" : null

  # Interface endpoints this configuration owns. ssm, ssmmessages and
  # ec2messages already exist in the default VPC with private DNS (see
  # var.shared_ssm_endpoint_security_group_ids); a duplicate would fail.
  executor_interface_endpoints = local.executor_enabled ? toset(["ecr.api", "ecr.dkr", "secretsmanager", "logs"]) : toset([])
}

# The executor token. The runtime tasks receive it through ECS `secrets`
# (ecs.tf); executors read it at boot with their instance role. Set its value
# out of band; see README.md.
resource "aws_secretsmanager_secret" "executor_token" {
  count       = local.executor_enabled ? 1 : 0
  name        = "${var.secret_prefix}/executor-token"
  description = "Bearer token the agent runtime presents to code executor hosts."
}

resource "aws_cloudwatch_log_group" "executor" {
  count             = local.executor_enabled ? 1 : 0
  name              = "/camelai/agent-executor"
  retention_in_days = 30
}

# --- Private subnets ---

data "aws_subnet" "task" {
  for_each = local.executor_enabled ? toset(data.aws_subnets.default.ids) : toset([])
  id       = each.value
}

resource "aws_subnet" "executor" {
  for_each                = local.executor_enabled ? var.executor_private_subnets : {}
  vpc_id                  = data.aws_vpc.default.id
  availability_zone       = each.key
  cidr_block              = each.value
  map_public_ip_on_launch = false
  tags                    = { Name = "${var.executor_name}-${each.key}" }
}

# Only the implicit local route (and the S3 gateway endpoint's prefix list): no internet.
resource "aws_route_table" "executor" {
  count  = local.executor_enabled ? 1 : 0
  vpc_id = data.aws_vpc.default.id
  tags   = { Name = var.executor_name }
}

resource "aws_route_table_association" "executor" {
  for_each       = aws_subnet.executor
  subnet_id      = each.value.id
  route_table_id = aws_route_table.executor[0].id
}

# --- VPC endpoints ---

# Private DNS on an interface endpoint applies to the whole VPC: every workload
# in the default VPC (the runtime, other stacks) then resolves these services
# to it. So it admits the VPC CIDR, not just executors.
resource "aws_security_group" "vpc_endpoints" {
  count       = local.executor_enabled ? 1 : 0
  name        = "${var.executor_name}-endpoints"
  description = "Interface endpoints for the executor subnets; private DNS makes them VPC-wide"
  vpc_id      = data.aws_vpc.default.id
  tags        = { Name = "${var.executor_name}-endpoints" }
}

resource "aws_vpc_security_group_ingress_rule" "vpc_endpoints_https" {
  count             = local.executor_enabled ? 1 : 0
  security_group_id = aws_security_group.vpc_endpoints[0].id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = data.aws_vpc.default.cidr_block
  description       = "HTTPS from the VPC"
}

resource "aws_vpc_endpoint" "executor_interface" {
  for_each            = local.executor_interface_endpoints
  vpc_id              = data.aws_vpc.default.id
  service_name        = "com.amazonaws.${var.region}.${each.key}"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = local.executor_endpoint_ids
  security_group_ids  = [aws_security_group.vpc_endpoints[0].id]
  private_dns_enabled = true
  tags                = { Name = "${var.executor_name}-${each.key}" }
}

# ECR image layers are served from S3.
resource "aws_vpc_endpoint" "executor_s3" {
  count             = local.executor_enabled ? 1 : 0
  vpc_id            = data.aws_vpc.default.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.executor[0].id]
  tags              = { Name = "${var.executor_name}-s3" }
}

# --- Security groups ---

resource "aws_security_group" "executor" {
  count       = local.executor_enabled ? 1 : 0
  name        = var.executor_name
  description = "Code executors: reachable only through the executor NLB; reach only the runtime callback port and AWS endpoints"
  vpc_id      = data.aws_vpc.default.id
  tags        = { Name = var.executor_name }
}

resource "aws_security_group" "executor_lb" {
  count       = local.executor_enabled ? 1 : 0
  name        = "${var.executor_name}-lb"
  description = "Internal executor NLB: from runtime tasks, to executors"
  vpc_id      = data.aws_vpc.default.id
  tags        = { Name = "${var.executor_name}-lb" }
}

resource "aws_vpc_security_group_ingress_rule" "executor_lb_from_task" {
  count                        = local.executor_enabled ? 1 : 0
  security_group_id            = aws_security_group.executor_lb[0].id
  referenced_security_group_id = aws_security_group.task.id
  ip_protocol                  = "tcp"
  from_port                    = var.executor_port
  to_port                      = var.executor_port
  description                  = "Runtime tasks"
}

resource "aws_vpc_security_group_egress_rule" "executor_lb_to_executor" {
  count                        = local.executor_enabled ? 1 : 0
  security_group_id            = aws_security_group.executor_lb[0].id
  referenced_security_group_id = aws_security_group.executor[0].id
  ip_protocol                  = "tcp"
  from_port                    = var.executor_port
  to_port                      = var.executor_port
  description                  = "Executors and their health checks"
}

resource "aws_vpc_security_group_ingress_rule" "executor_from_lb" {
  count                        = local.executor_enabled ? 1 : 0
  security_group_id            = aws_security_group.executor[0].id
  referenced_security_group_id = aws_security_group.executor_lb[0].id
  ip_protocol                  = "tcp"
  from_port                    = var.executor_port
  to_port                      = var.executor_port
  description                  = "Executor NLB"
}

# With client IPs preserved, requests arrive from the tasks themselves; health
# checks arrive from the NLB.
resource "aws_vpc_security_group_ingress_rule" "executor_from_task" {
  count                        = local.executor_enabled ? 1 : 0
  security_group_id            = aws_security_group.executor[0].id
  referenced_security_group_id = aws_security_group.task.id
  ip_protocol                  = "tcp"
  from_port                    = var.executor_port
  to_port                      = var.executor_port
  description                  = "Runtime tasks through the NLB"
}

resource "aws_vpc_security_group_egress_rule" "executor_to_task_callback" {
  count                        = local.executor_enabled ? 1 : 0
  security_group_id            = aws_security_group.executor[0].id
  referenced_security_group_id = aws_security_group.task.id
  ip_protocol                  = "tcp"
  from_port                    = var.executor_callback_port
  to_port                      = var.executor_callback_port
  description                  = "Runtime callback listener"
}

resource "aws_vpc_security_group_egress_rule" "executor_to_endpoints" {
  for_each                     = local.executor_enabled ? toset(concat(["owned"], var.shared_ssm_endpoint_security_group_ids)) : toset([])
  security_group_id            = aws_security_group.executor[0].id
  referenced_security_group_id = each.key == "owned" ? aws_security_group.vpc_endpoints[0].id : each.key
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  description                  = "AWS interface endpoints"
}

resource "aws_vpc_security_group_egress_rule" "executor_to_s3" {
  count             = local.executor_enabled ? 1 : 0
  security_group_id = aws_security_group.executor[0].id
  prefix_list_id    = aws_vpc_endpoint.executor_s3[0].prefix_list_id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "S3 gateway endpoint (ECR layers)"
}

# The runtime tasks accept callbacks from executors only.
resource "aws_vpc_security_group_ingress_rule" "task_executor_callback" {
  count                        = local.executor_enabled ? 1 : 0
  security_group_id            = aws_security_group.task.id
  referenced_security_group_id = aws_security_group.executor[0].id
  ip_protocol                  = "tcp"
  from_port                    = var.executor_callback_port
  to_port                      = var.executor_callback_port
  description                  = "Executor callbacks"
}

# --- Internal load balancer ---

resource "aws_lb" "executor" {
  count                            = local.executor_enabled ? 1 : 0
  name                             = var.executor_name
  load_balancer_type               = "network"
  internal                         = true
  subnets                          = local.executor_subnet_ids
  security_groups                  = [aws_security_group.executor_lb[0].id]
  enable_cross_zone_load_balancing = true
  tags                             = { Name = var.executor_name }
}

resource "aws_lb_target_group" "executor" {
  count       = local.executor_enabled ? 1 : 0
  name        = var.executor_name
  target_type = "instance"
  protocol    = "TCP"
  port        = var.executor_port
  vpc_id      = data.aws_vpc.default.id
  # Executors see the runtime task's IP. Their host firewall (user-data.sh)
  # admits 8790 only from runtime_callback_cidr.
  preserve_client_ip = true
  # An execution's deadline is the tool timeout (60 s) plus a grace period.
  deregistration_delay = 90

  health_check {
    protocol            = "HTTP"
    path                = "/healthz"
    matcher             = "200"
    interval            = 10
    healthy_threshold   = 2
    unhealthy_threshold = 2
  }

  tags = { Name = var.executor_name }
}

resource "aws_lb_listener" "executor" {
  count             = local.executor_enabled ? 1 : 0
  load_balancer_arn = aws_lb.executor[0].arn
  port              = var.executor_port
  protocol          = "TCP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.executor[0].arn
  }
}

# --- Instance role ---

resource "aws_iam_role" "executor" {
  count       = local.executor_enabled ? 1 : 0
  name        = var.executor_name
  description = "Code executor hosts: SSM, executor token, image pull, logs"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "executor_ssm" {
  count      = local.executor_enabled ? 1 : 0
  role       = aws_iam_role.executor[0].name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "executor" {
  count = local.executor_enabled ? 1 : 0
  name  = "agent-executor"
  role  = aws_iam_role.executor[0].name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = "secretsmanager:GetSecretValue"
        Resource = aws_secretsmanager_secret.executor_token[0].arn
      },
      {
        Effect   = "Allow"
        Action   = "ecr:GetAuthorizationToken"
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"]
        Resource = aws_ecr_repository.runtime.arn
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"]
        Resource = "${aws_cloudwatch_log_group.executor[0].arn}:*"
      },
    ]
  })
}

resource "aws_iam_instance_profile" "executor" {
  count = local.executor_enabled ? 1 : 0
  name  = var.executor_name
  role  = aws_iam_role.executor[0].name
}

# --- Hosts ---

resource "aws_launch_template" "executor" {
  count                  = local.executor_enabled ? 1 : 0
  name                   = var.executor_name
  description            = "Code executor host: private subnet, no public IP, IMDSv2 hop limit 1"
  image_id               = var.executor_ami_id
  instance_type          = var.executor_instance_type
  update_default_version = true

  user_data = base64encode(templatefile("${path.module}/../executor/user-data.sh", {
    region                = var.region
    image                 = local.executor_image
    token_secret_arn      = aws_secretsmanager_secret.executor_token[0].arn
    log_group             = aws_cloudwatch_log_group.executor[0].name
    runtime_callback_cidr = var.executor_runtime_callback_cidr
    max_concurrency       = var.executor_max_concurrency
  }))

  iam_instance_profile {
    arn = aws_iam_instance_profile.executor[0].arn
  }

  network_interfaces {
    associate_public_ip_address = false
    security_groups             = [aws_security_group.executor[0].id]
    delete_on_termination       = true
  }

  # IMDS answers only the host itself: hop limit 1 keeps containers out.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      volume_size           = 16
      volume_type           = "gp3"
      encrypted             = true
      delete_on_termination = true
    }
  }

  tag_specifications {
    resource_type = "instance"
    tags          = { Name = var.executor_name }
  }

  tag_specifications {
    resource_type = "volume"
    tags          = { Name = var.executor_name }
  }

  lifecycle {
    precondition {
      condition     = var.executor_ami_id != null
      error_message = "executor_enabled needs executor_ami_id (the Packer executor AMI)."
    }
    # The host firewall admits 8790 only from runtime_callback_cidr, and the
    # executor may call back only into it: it must hold the task subnets
    # (requests, callbacks) and the executor subnets (NLB health checks).
    precondition {
      condition = alltrue([
        for cidr in concat(values(data.aws_subnet.task)[*].cidr_block, values(var.executor_private_subnets)) :
        cidrcontains(var.executor_runtime_callback_cidr, cidr)
      ])
      error_message = "executor_runtime_callback_cidr must contain every task subnet and every executor subnet."
    }
  }
}

resource "aws_autoscaling_group" "executor" {
  count                     = local.executor_enabled ? 1 : 0
  name                      = var.executor_name
  vpc_zone_identifier       = local.executor_subnet_ids
  min_size                  = var.executor_min_size
  max_size                  = var.executor_max_size
  target_group_arns         = [aws_lb_target_group.executor[0].arn]
  health_check_type         = "ELB"
  health_check_grace_period = 180
  default_instance_warmup   = 120

  launch_template {
    id      = aws_launch_template.executor[0].id
    version = aws_launch_template.executor[0].latest_version
  }

  # A new launch template version (AMI, image, settings) replaces hosts gradually.
  instance_refresh {
    strategy = "Rolling"
    preferences {
      min_healthy_percentage = 50
      instance_warmup        = 120
    }
  }

  tag {
    key                 = "Name"
    value               = var.executor_name
    propagate_at_launch = true
  }

  lifecycle {
    # The scaling policy owns the running count.
    ignore_changes = [desired_capacity]
  }
}

resource "aws_autoscaling_policy" "executor_cpu" {
  count                  = local.executor_enabled ? 1 : 0
  name                   = "${var.executor_name}-cpu"
  autoscaling_group_name = aws_autoscaling_group.executor[0].name
  policy_type            = "TargetTrackingScaling"

  target_tracking_configuration {
    target_value = var.executor_cpu_target
    predefined_metric_specification {
      predefined_metric_type = "ASGAverageCPUUtilization"
    }
  }
}
