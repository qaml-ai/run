# All cloud calls are mocked: these runs never read or touch AWS. Run with `tofu test` from infra/job-hosts/terraform.

mock_provider "aws" {
  mock_data "aws_vpc" {
    defaults = { id = "vpc-0123456789abcdef0", cidr_block = "172.31.0.0/16" }
  }
  mock_data "aws_subnet" {
    defaults = { id = "subnet-0123456789abcdef0" }
  }
  mock_data "aws_sns_topic" {
    defaults = { arn = "arn:aws:sns:us-west-2:904534089871:camelai-agent-runtime-alerts" }
  }
  # The live role the check block reads: as this module creates it.
  mock_data "aws_iam_role" {
    defaults = {
      assume_role_policy = "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Sid\":\"EC2Only\",\"Effect\":\"Allow\",\"Principal\":{\"Service\":\"ec2.amazonaws.com\"},\"Action\":\"sts:AssumeRole\"}]}"
    }
  }
  mock_resource "aws_s3_bucket" {
    defaults = { arn = "arn:aws:s3:::camelrun-job-images-prod" }
  }
  mock_resource "aws_kms_key" {
    defaults = { arn = "arn:aws:kms:us-west-2:904534089871:key/11111111-2222-3333-4444-555555555555" }
  }
  mock_resource "aws_iam_instance_profile" {
    defaults = { arn = "arn:aws:iam::904534089871:instance-profile/camelrun-job-hosts-prod" }
  }
  mock_resource "aws_launch_template" {
    defaults = { id = "lt-0123456789abcdef0", latest_version = 1 }
  }
}

variables {
  build_ami_id = "ami-0123456789abcdef0"
  test_ami_id  = "ami-0fedcba9876543210"
}

run "role_trusts_only_ec2" {
  command = apply
  assert {
    condition = jsondecode(aws_iam_role.host.assume_role_policy) == {
      Version = "2012-10-17"
      Statement = [{
        Sid       = "EC2Only"
        Effect    = "Allow"
        Principal = { Service = "ec2.amazonaws.com" }
        Action    = "sts:AssumeRole"
      }]
    }
    error_message = "The job-host role must trust exactly ec2.amazonaws.com and nothing else (docs/design/job-hosts-plan.md, \"Required trust policy\")."
  }
  assert {
    condition     = output.host_role_arn == aws_iam_role.host.arn
    error_message = "host_role_arn is the role JOB_HOST_ROLE_ARNS lists."
  }
}

run "role_permissions_are_exactly_these" {
  command = apply
  assert {
    condition     = [for attachment in aws_iam_role_policy_attachment.host : attachment.policy_arn] == ["arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"]
    error_message = "The only managed policy is AmazonSSMManagedInstanceCore."
  }
  assert {
    condition = [for statement in jsondecode(aws_iam_role_policy.host.policy).Statement : statement.Sid] == [
      "ReadImagesAndSnapshots", "ListImagesAndSnapshots", "DecryptImagesThroughS3", "ReadOwnParameters", "CompleteOwnDrain", "NoOtherParameters", "NoAssumeRole",
    ]
    error_message = "The inline policy's statements changed; review them against the role's rule (no secrets, no database, no STS)."
  }
  assert {
    condition = alltrue([for statement in jsondecode(aws_iam_role_policy.host.policy).Statement :
      statement.Effect == "Deny" || alltrue([for action in flatten([statement.Action]) :
        !startswith(action, "sts:") && !startswith(action, "secretsmanager:") && !startswith(action, "rds") && !startswith(action, "iam:") && action != "*"
    ])])
    error_message = "No Allow may grant STS, Secrets Manager, RDS, IAM or *."
  }
  assert {
    condition = alltrue([for statement in jsondecode(aws_iam_role_policy.host.policy).Statement :
      statement.Effect == "Deny" || !contains(flatten([statement.Action]), "s3:PutObject")
    ])
    error_message = "Hosts write to the bucket only through presigned URLs."
  }
  assert {
    condition     = one([for statement in jsondecode(aws_iam_role_policy.host.policy).Statement : statement if statement.Sid == "NoAssumeRole"]).Effect == "Deny"
    error_message = "The role denies itself sts:AssumeRole."
  }
}

# A trust policy changed outside Terraform (here, also trusting an account) fails the check against the live role.
run "live_trust_drift_fails_the_check" {
  command = plan
  override_data {
    target = data.aws_iam_role.host_live
    values = {
      assume_role_policy = "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Principal\":{\"Service\":\"ec2.amazonaws.com\",\"AWS\":\"arn:aws:iam::904534089871:root\"},\"Action\":\"sts:AssumeRole\"}]}"
    }
  }
  expect_failures = [check.host_role_trust]
}

run "launch_templates_harden_the_host" {
  command = apply
  assert {
    condition = alltrue([for template in aws_launch_template.pool :
      template.metadata_options[0].http_tokens == "required"
      && template.metadata_options[0].http_put_response_hop_limit == 1
      && template.enclave_options[0].enabled
      && template.key_name == null
      && template.network_interfaces[0].associate_public_ip_address == "false"
      && template.iam_instance_profile[0].arn == aws_iam_instance_profile.host.arn
      && anytrue([for mapping in template.block_device_mappings : mapping.virtual_name == "ephemeral0"])
    ])
    error_message = "Both launch templates need IMDSv2 with hop limit 1, Nitro Enclaves, no key pair, no public IP, the host profile and the instance store."
  }
  assert {
    condition     = aws_launch_template.pool["build"].instance_type == "r8gd.4xlarge" && aws_launch_template.pool["test"].instance_type == "c8gd.4xlarge"
    error_message = "Default instance types: r8gd.4xlarge (build), c8gd.4xlarge (test)."
  }
  assert {
    condition     = strcontains(base64decode(aws_launch_template.pool["build"].user_data), "/camelrun/job-hosts/prod/runtime-url") && strcontains(base64decode(aws_launch_template.pool["build"].user_data), "CAMELRUN_JOB_HOST_POOL=build")
    error_message = "User data writes the runtime URL from SSM into the agent's env file."
  }
}

run "network_has_no_inbound_and_443_out" {
  command = apply
  assert {
    condition     = length(aws_security_group.hosts.ingress) == 0
    error_message = "The host security group has no inbound rule."
  }
  assert {
    condition     = aws_vpc_security_group_egress_rule.hosts_https.from_port == 443 && aws_vpc_security_group_egress_rule.hosts_https.to_port == 443 && aws_vpc_security_group_egress_rule.hosts_https.ip_protocol == "tcp"
    error_message = "The only egress rule is TCP 443."
  }
  assert {
    condition     = alltrue([for subnet in aws_subnet.private : !subnet.map_public_ip_on_launch])
    error_message = "Pool subnets are private."
  }
  assert {
    condition     = length(aws_vpc_endpoint.s3) == 1
    error_message = "With no existing endpoint named, an S3 gateway endpoint is created."
  }
}

run "pools_on_demand_with_maxima" {
  command = apply
  assert {
    condition     = aws_autoscaling_group.build[0].min_size == 2 && aws_autoscaling_group.build[0].desired_capacity == 2 && aws_autoscaling_group.build[0].max_size == 4
    error_message = "Build pool: warm 2, max 4."
  }
  assert {
    condition     = aws_autoscaling_group.test[0].min_size == 0 && aws_autoscaling_group.test[0].max_size == 16
    error_message = "Test pool: min 0, max 16."
  }
  assert {
    condition     = aws_autoscaling_group.test[0].mixed_instances_policy[0].instances_distribution[0].on_demand_percentage_above_base_capacity == 100 && !aws_autoscaling_group.test[0].capacity_rebalance && !aws_autoscaling_group.build[0].capacity_rebalance
    error_message = "Both pools are on-demand, with capacity rebalance off."
  }
  assert {
    condition = alltrue([for asg in [aws_autoscaling_group.build[0], aws_autoscaling_group.test[0]] :
      one(asg.initial_lifecycle_hook).lifecycle_transition == "autoscaling:EC2_INSTANCE_TERMINATING" && one(asg.initial_lifecycle_hook).heartbeat_timeout == 900
    ])
    error_message = "Both pools drain through a 15-minute termination lifecycle hook."
  }
  assert {
    condition     = length(aws_cloudwatch_metric_alarm.pool_short) == 2 && length(aws_cloudwatch_metric_alarm.pool_status_check) == 2
    error_message = "Each pool has its alarms."
  }
}

run "spot_is_opt_in" {
  command = plan
  variables {
    test_use_spot = true
  }
  assert {
    condition     = aws_autoscaling_group.test[0].mixed_instances_policy[0].instances_distribution[0].on_demand_percentage_above_base_capacity == 0 && aws_autoscaling_group.test[0].capacity_rebalance
    error_message = "test_use_spot moves the test pool to spot with capacity rebalance."
  }
}

run "no_ami_no_pool" {
  command = apply
  variables {
    build_ami_id = ""
    test_ami_id  = ""
  }
  assert {
    condition     = length(aws_launch_template.pool) == 0 && length(aws_autoscaling_group.build) == 0 && length(aws_autoscaling_group.test) == 0 && length(aws_cloudwatch_metric_alarm.pool_short) == 0
    error_message = "Without an AMI there is no launch template, ASG or alarm."
  }
  assert {
    condition     = output.build_asg_name == "" && output.test_asg_name == "" && output.images_bucket == "camelrun-job-images-prod"
    error_message = "The foundation (bucket, role) exists without the pools."
  }
}

run "warm_above_max_is_refused" {
  command = plan
  variables {
    build_max_size = 1
  }
  expect_failures = [aws_autoscaling_group.build]
}

run "maxima_are_capped" {
  command = plan
  variables {
    build_max_size = 5
    test_max_size  = 17
  }
  expect_failures = [var.build_max_size, var.test_max_size]
}

run "audience_matches_the_runtime" {
  command = apply
  assert {
    condition     = aws_ssm_parameter.enrollment_audience.value == "camelrun-job-host:https://run-pilot.camelai.dev" && aws_ssm_parameter.runtime_url.value == "https://run-pilot.camelai.dev"
    error_message = "The audience is camelrun-job-host:<AGENT_PUBLIC_URL> (backends/workers/src/jobs/hosts.ts)."
  }
}
