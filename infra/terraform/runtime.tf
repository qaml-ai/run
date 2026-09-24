# The single runtime host and what it needs, as infra/provision.sh created it.
# Everything here already exists and is adopted by the blocks in imports.tf.

locals {
  secret_arn_prefix = "arn:aws:secretsmanager:${var.region}:${var.account_id}:secret:${var.secret_prefix}"
}

data "aws_vpc" "default" {
  default = true
}

# --- Container registry ---

resource "aws_ecr_repository" "runtime" {
  name                 = var.name
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }
}

resource "aws_ecr_lifecycle_policy" "runtime" {
  repository = aws_ecr_repository.runtime.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the last 30 images"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 30 }
      action       = { type = "expire" }
    }]
  })
}

# --- IAM ---

resource "aws_iam_role" "runtime" {
  name        = var.name
  description = "Agent runtime EC2 host"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "runtime_ssm" {
  role       = aws_iam_role.runtime.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# Secrets, and pull access to the runtime's own repository. S3 access for agent
# state is a separate policy (state-bucket.tf).
resource "aws_iam_role_policy" "runtime" {
  name = "agent-runtime"
  role = aws_iam_role.runtime.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = "secretsmanager:GetSecretValue"
        Resource = [for secret in ["session-secret", "tenants", "secrets-key", "github-oauth"] : "${local.secret_arn_prefix}/${secret}-*"]
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
    ]
  })
}

resource "aws_iam_instance_profile" "runtime" {
  name = var.name
  role = aws_iam_role.runtime.name
}

# --- Network ---

# Rules are separate resources (below) rather than inline.
resource "aws_security_group" "runtime" {
  name        = var.name
  description = "Agent runtime: HTTPS only, no SSH"
  vpc_id      = data.aws_vpc.default.id
  tags        = { Name = var.name }
}

resource "aws_vpc_security_group_ingress_rule" "runtime_https_ipv4" {
  security_group_id = aws_security_group.runtime.id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_ingress_rule" "runtime_https_ipv6" {
  security_group_id = aws_security_group.runtime.id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv6         = "::/0"
}

resource "aws_vpc_security_group_egress_rule" "runtime_all_ipv4" {
  security_group_id = aws_security_group.runtime.id
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "runtime_all_ipv6" {
  security_group_id = aws_security_group.runtime.id
  ip_protocol       = "-1"
  cidr_ipv6         = "::/0"
}

# --- Host ---

resource "aws_instance" "runtime" {
  ami                     = "ami-0bf3181a6c05c7e0b"
  instance_type           = var.instance_type
  subnet_id               = "subnet-09d354d571eba09e1"
  vpc_security_group_ids  = [aws_security_group.runtime.id]
  iam_instance_profile    = aws_iam_instance_profile.runtime.name
  disable_api_termination = true

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 2
    instance_metadata_tags      = "disabled"
  }

  root_block_device {
    volume_size           = var.root_volume_gb
    volume_type           = "gp3"
    encrypted             = true
    delete_on_termination = false
    # The Backup tag is what the snapshot policy selects on.
    tags = { Name = var.name, Backup = var.name }
  }

  tags = { Name = var.name }

  lifecycle {
    # Agent state lives on this host's root volume: never replace it from here.
    # The AMI is whatever was current at launch, and user_data only ran at first
    # boot; deploy.sh configures the host over SSM.
    prevent_destroy = true
    ignore_changes  = [ami, user_data, user_data_base64, user_data_replace_on_change]
  }
}

resource "aws_eip" "runtime" {
  domain = "vpc"
  tags   = { Name = var.name }

  lifecycle {
    # agents.camelai.dev points at this address.
    prevent_destroy = true
  }
}

resource "aws_eip_association" "runtime" {
  allocation_id = aws_eip.runtime.allocation_id
  instance_id   = aws_instance.runtime.id
}

# --- Snapshots ---

data "aws_iam_role" "dlm_default" {
  name = "AWSDataLifecycleManagerDefaultRole"
}

resource "aws_dlm_lifecycle_policy" "runtime" {
  description        = "${var.name} snapshots"
  execution_role_arn = data.aws_iam_role.dlm_default.arn
  state              = "ENABLED"

  policy_details {
    policy_type    = "EBS_SNAPSHOT_MANAGEMENT"
    resource_types = ["VOLUME"]
    target_tags    = { Backup = var.name }

    schedule {
      name      = "hourly"
      copy_tags = true
      create_rule {
        interval      = 1
        interval_unit = "HOURS"
        # AWS picked this start time when the policy was created without one.
        times = ["00:39"]
      }
      retain_rule {
        count = 48
      }
    }

    schedule {
      name      = "daily"
      copy_tags = true
      create_rule {
        interval      = 24
        interval_unit = "HOURS"
        times         = ["09:00"]
      }
      retain_rule {
        count = 7
      }
    }
  }
}

# --- Self-healing ---

resource "aws_cloudwatch_metric_alarm" "system_check" {
  alarm_name          = "${var.name}-system-check"
  alarm_description   = "Recover ${var.name} onto healthy hardware"
  namespace           = "AWS/EC2"
  metric_name         = "StatusCheckFailed_System"
  dimensions          = { InstanceId = aws_instance.runtime.id }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 2
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  alarm_actions       = ["arn:aws:automate:${var.region}:ec2:recover"]
}

resource "aws_cloudwatch_metric_alarm" "instance_check" {
  alarm_name          = "${var.name}-instance-check"
  alarm_description   = "Reboot ${var.name} when its OS stops responding"
  namespace           = "AWS/EC2"
  metric_name         = "StatusCheckFailed_Instance"
  dimensions          = { InstanceId = aws_instance.runtime.id }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  alarm_actions       = ["arn:aws:automate:${var.region}:ec2:reboot"]
}
