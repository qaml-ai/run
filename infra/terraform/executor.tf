# NEW: the code executor tier from infra/executor/provision.sh. Nothing here
# exists until executor_count > 0. The hosts themselves stay with
# infra/executor/deploy.sh: they are immutable, replaced on every deploy, and
# their user data carries the executor token, which must not enter Terraform
# state. The launch template records their non-secret launch settings.

# The only secret an executor host holds. The runtime role may read it (see the
# executor-token grant in runtime.tf). Set its value out of band; see README.md.
resource "aws_secretsmanager_secret" "executor_token" {
  count       = local.executor_enabled ? 1 : 0
  name        = "${var.secret_prefix}/executor-token"
  description = "Bearer token the agent runtime presents to code executor hosts."
}

# In: executor port from the runtime only. Out: the runtime's callback port only.
# Declaring egress replaces the default allow-all egress rule.
resource "aws_security_group" "executor" {
  count       = local.executor_enabled ? 1 : 0
  name        = var.executor_name
  description = "Code executors: reachable only from the agent runtime, and reach only its callback port"
  vpc_id      = data.aws_vpc.default.id
  tags        = { Name = var.executor_name }

  ingress {
    protocol        = "tcp"
    from_port       = var.executor_port
    to_port         = var.executor_port
    security_groups = [aws_security_group.runtime.id]
  }

  egress {
    protocol        = "tcp"
    from_port       = var.executor_callback_port
    to_port         = var.executor_callback_port
    security_groups = [aws_security_group.runtime.id]
  }
}

# Attached only while a new host installs Docker, gVisor and the image;
# deploy.sh detaches it once the host is healthy.
resource "aws_security_group" "executor_bootstrap" {
  count       = local.executor_enabled ? 1 : 0
  name        = "${var.executor_name}-bootstrap"
  description = "Code executor first boot only; deploy.sh detaches it once the host is healthy"
  vpc_id      = data.aws_vpc.default.id
  tags        = { Name = "${var.executor_name}-bootstrap" }

  egress {
    protocol    = "tcp"
    from_port   = 443
    to_port     = 443
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    protocol    = "tcp"
    from_port   = 80
    to_port     = 80
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# The runtime accepts executor callbacks from the executor group only.
resource "aws_vpc_security_group_ingress_rule" "runtime_executor_callback" {
  count                        = local.executor_enabled ? 1 : 0
  security_group_id            = aws_security_group.runtime.id
  ip_protocol                  = "tcp"
  from_port                    = var.executor_callback_port
  to_port                      = var.executor_callback_port
  referenced_security_group_id = aws_security_group.executor[0].id
}

# deploy.sh supplies the AMI, the count and the (secret-bearing) user data at
# launch: `aws ec2 run-instances --launch-template LaunchTemplateName=<name>`.
resource "aws_launch_template" "executor" {
  count                  = local.executor_enabled ? 1 : 0
  name                   = var.executor_name
  description            = "Code executor host: no instance profile, no SSH, IMDSv2 hop limit 1"
  instance_type          = var.executor_instance_type
  update_default_version = true

  network_interfaces {
    subnet_id                   = aws_instance.runtime.subnet_id
    associate_public_ip_address = true
    security_groups             = [aws_security_group.executor[0].id, aws_security_group.executor_bootstrap[0].id]
    delete_on_termination       = true
  }

  # IMDS answers only the host itself (hop limit 1 keeps containers out);
  # deploy.sh switches it off entirely once the host is healthy.
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
}
