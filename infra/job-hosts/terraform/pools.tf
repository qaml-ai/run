# The two host pools. A pool exists only once its AMI is set (build_ami_id / test_ami_id, from slice 1): with an
# empty AMI there is no launch template, ASG or alarm for it, so this module can be applied for its bucket,
# network and role before any image exists, and an empty AMI can never reach a launch.
#
# Both pools are on-demand (Miguel, 2026-11-12). The test pool can move to spot with test_use_spot.

locals {
  pools = {
    build = {
      ami   = var.build_ami_id
      types = [var.build_instance_type]
    }
    test = {
      ami   = var.test_ami_id
      types = var.test_instance_types
    }
  }
  enabled_pools = { for name, pool in local.pools : name => pool if pool.ami != "" }
}

resource "aws_launch_template" "pool" {
  for_each = local.enabled_pools

  name                   = "${var.name}-${each.key}"
  description            = "camelRun ${each.key} job hosts (${var.env})"
  image_id               = each.value.ami
  instance_type          = each.value.types[0]
  update_default_version = true
  ebs_optimized          = true

  # No key pair: no SSH. Operators use SSM Session Manager.

  iam_instance_profile {
    arn = aws_iam_instance_profile.host.arn
  }

  network_interfaces {
    associate_public_ip_address = false
    delete_on_termination       = true
    security_groups             = [aws_security_group.hosts.id]
  }

  # IMDSv2 only, hop limit 1: the host's own agent reads its role credentials and region; a job's microVM (one more
  # hop, and its traffic is dropped on the host anyway) cannot.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "disabled"
  }

  enclave_options {
    enabled = true
  }

  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      volume_type           = "gp3"
      volume_size           = var.root_volume_gib
      encrypted             = true
      delete_on_termination = true
    }
  }

  # The NVMe instance store (the image cache and job disks; slice 1's boot unit formats it as XFS reflink=1).
  # Nitro exposes it as NVMe whatever the device name.
  block_device_mappings {
    device_name  = "/dev/sdb"
    virtual_name = "ephemeral0"
  }

  user_data = base64encode(templatefile("${path.module}/user-data.sh.tftpl", {
    region        = var.region
    ssm_prefix    = local.ssm_parameter_prefix
    pool          = each.key
    images_bucket = aws_s3_bucket.images.id
  }))

  tag_specifications {
    resource_type = "instance"
    tags          = { Name = "${var.name}-${each.key}", Pool = each.key }
  }
  tag_specifications {
    resource_type = "volume"
    tags          = { Name = "${var.name}-${each.key}", Pool = each.key }
  }

  lifecycle {
    precondition {
      condition     = alltrue([for type in each.value.types : can(regex("^[a-z0-9]+g[a-z]*d\\.", type))])
      error_message = "Job-host instance types must be Graviton with NVMe instance store (for example r8gd, c8gd)."
    }
  }
}

locals {
  asg_metrics = ["GroupDesiredCapacity", "GroupInServiceInstances", "GroupPendingInstances", "GroupTerminatingInstances", "GroupTotalInstances"]
  subnet_ids  = [for subnet in aws_subnet.private : subnet.id]
}

# Build: a fixed warm size (slice 8 keeps one build sandbox started on each).
resource "aws_autoscaling_group" "build" {
  count = contains(keys(local.enabled_pools), "build") ? 1 : 0

  name                      = "${var.name}-build"
  min_size                  = var.build_warm_size
  desired_capacity          = var.build_warm_size
  max_size                  = var.build_max_size
  vpc_zone_identifier       = local.subnet_ids
  health_check_type         = "EC2"
  health_check_grace_period = 300
  capacity_rebalance        = false
  enabled_metrics           = local.asg_metrics

  launch_template {
    id      = aws_launch_template.pool["build"].id
    version = aws_launch_template.pool["build"].latest_version
  }

  # A terminating host gets drain_timeout_seconds to finish or hand back its jobs (the agent completes the action
  # when drained; slice 8). CONTINUE: a host that never answers is terminated anyway.
  initial_lifecycle_hook {
    name                 = "drain"
    lifecycle_transition = "autoscaling:EC2_INSTANCE_TERMINATING"
    heartbeat_timeout    = var.drain_timeout_seconds
    default_result       = "CONTINUE"
  }

  tag {
    key                 = "Name"
    value               = "${var.name}-build"
    propagate_at_launch = true
  }

  lifecycle {
    precondition {
      condition     = var.build_warm_size >= 0 && var.build_warm_size <= var.build_max_size
      error_message = "build_warm_size must be between 0 and build_max_size."
    }
  }
}

# Test: min 0; slice 8 scales desired capacity on the runtime's queue depth, so Terraform leaves it alone.
resource "aws_autoscaling_group" "test" {
  count = contains(keys(local.enabled_pools), "test") ? 1 : 0

  name                      = "${var.name}-test"
  min_size                  = 0
  max_size                  = var.test_max_size
  vpc_zone_identifier       = local.subnet_ids
  health_check_type         = "EC2"
  health_check_grace_period = 300
  # Only meaningful on spot; on-demand hosts get no rebalance recommendations.
  capacity_rebalance = var.test_use_spot
  enabled_metrics    = local.asg_metrics

  mixed_instances_policy {
    instances_distribution {
      on_demand_base_capacity                  = 0
      on_demand_percentage_above_base_capacity = var.test_use_spot ? 0 : 100
      on_demand_allocation_strategy            = "prioritized"
      spot_allocation_strategy                 = "price-capacity-optimized"
    }
    launch_template {
      launch_template_specification {
        launch_template_id = aws_launch_template.pool["test"].id
        version            = aws_launch_template.pool["test"].latest_version
      }
      dynamic "override" {
        for_each = var.test_instance_types
        content {
          instance_type = override.value
        }
      }
    }
  }

  initial_lifecycle_hook {
    name                 = "drain"
    lifecycle_transition = "autoscaling:EC2_INSTANCE_TERMINATING"
    heartbeat_timeout    = var.drain_timeout_seconds
    default_result       = "CONTINUE"
  }

  tag {
    key                 = "Name"
    value               = "${var.name}-test"
    propagate_at_launch = true
  }

  lifecycle {
    ignore_changes = [desired_capacity]
  }
}
