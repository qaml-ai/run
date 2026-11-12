# All cloud calls are mocked: these runs never read or touch AWS. Run with `tofu test` from infra/job-hosts/terraform.

mock_provider "aws" {
  mock_data "aws_vpc" {
    defaults = { id = "vpc-0123456789abcdef0", cidr_block = "172.31.0.0/16" }
  }
  mock_data "aws_internet_gateway" {
    defaults = { id = "igw-0123456789abcdef0" }
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
    defaults = { arn = "arn:aws:iam::904534089871:instance-profile/mocked" }
  }
  mock_resource "aws_launch_template" {
    defaults = { id = "lt-0123456789abcdef0", latest_version = 1 }
  }
}

variables {
  build_ami_id = "ami-0123456789abcdef0"
  test_ami_id  = "ami-0fedcba9876543210"
}

run "roles_trust_only_ec2" {
  command = apply
  assert {
    condition     = { for pool, role in aws_iam_role.host : pool => role.name } == { build = "camelrun-job-hosts-build-prod", test = "camelrun-job-hosts-test-prod" }
    error_message = "One host role per pool: camelrun-job-hosts-build-prod and camelrun-job-hosts-test-prod."
  }
  assert {
    condition = alltrue([for role in aws_iam_role.host : jsondecode(role.assume_role_policy) == {
      Version = "2012-10-17"
      Statement = [{
        Sid       = "EC2Only"
        Effect    = "Allow"
        Principal = { Service = "ec2.amazonaws.com" }
        Action    = "sts:AssumeRole"
      }]
    }])
    error_message = "Each job-host role must trust exactly ec2.amazonaws.com and nothing else (docs/design/job-hosts-plan.md, \"Required trust policy\")."
  }
  assert {
    condition     = output.job_host_role_arns == "build=${aws_iam_role.host["build"].arn},test=${aws_iam_role.host["test"].arn}"
    error_message = "job_host_role_arns is JOB_HOST_ROLE_ARNS exactly: pool=arn pairs, comma-separated."
  }
  assert {
    condition     = { for pool, profile in aws_iam_instance_profile.host : pool => profile.role } == { build = "camelrun-job-hosts-build-prod", test = "camelrun-job-hosts-test-prod" }
    error_message = "Each pool has its own instance profile for its own role."
  }
}

# The roles exist without AMIs too: JOB_HOST_ROLE_ARNS does not change when an AMI is set.
run "roles_exist_before_the_pools" {
  command = plan
  variables {
    build_ami_id = ""
    test_ami_id  = ""
  }
  assert {
    condition     = toset(keys(aws_iam_role.host)) == toset(["build", "test"]) && length(aws_iam_instance_profile.host) == 2
    error_message = "Both pools' roles and profiles exist whether or not a pool does."
  }
}

run "role_permissions_are_exactly_these" {
  command = apply
  assert {
    condition     = [for attachment in aws_iam_role_policy_attachment.host : attachment.policy_arn] == ["arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore", "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"] && toset([for attachment in aws_iam_role_policy_attachment.host : attachment.role]) == toset(["camelrun-job-hosts-build-prod", "camelrun-job-hosts-test-prod"])
    error_message = "Each role's only managed policy is AmazonSSMManagedInstanceCore."
  }
  assert {
    condition     = aws_iam_role_policy.host["build"].policy == aws_iam_role_policy.host["test"].policy && toset([for policy in aws_iam_role_policy.host : policy.role]) == toset([for role in aws_iam_role.host : role.id])
    error_message = "Both roles carry the same host policy."
  }
  assert {
    condition = [for statement in jsondecode(aws_iam_role_policy.host["build"].policy).Statement : statement.Sid] == [
      "ReadImagesAndSnapshots", "ListImagesAndSnapshots", "DecryptImagesThroughS3", "ReadOwnParameters", "CompleteOwnDrain", "NoOtherParameters", "NoAssumeRole",
    ]
    error_message = "The inline policy's statements changed; review them against the role's rule (no secrets, no database, no STS)."
  }
  assert {
    condition = alltrue([for statement in jsondecode(aws_iam_role_policy.host["build"].policy).Statement :
      statement.Effect == "Deny" || alltrue([for action in flatten([statement.Action]) :
        !startswith(action, "sts:") && !startswith(action, "secretsmanager:") && !startswith(action, "rds") && !startswith(action, "iam:") && action != "*"
    ])])
    error_message = "No Allow may grant STS, Secrets Manager, RDS, IAM or *."
  }
  assert {
    condition = alltrue([for statement in jsondecode(aws_iam_role_policy.host["build"].policy).Statement :
      statement.Effect == "Deny" || !contains(flatten([statement.Action]), "s3:PutObject")
    ])
    error_message = "Hosts write to the bucket only through presigned URLs."
  }
  assert {
    condition = one([for statement in jsondecode(aws_iam_role_policy.host["build"].policy).Statement : statement if statement.Sid == "ReadOwnParameters"]).Resource == [
      "arn:aws:ssm:us-west-2:904534089871:parameter/camelrun/job-hosts/prod/runtime-url",
      "arn:aws:ssm:us-west-2:904534089871:parameter/camelrun/job-hosts/prod/enrollment-audience",
    ] && one([for statement in jsondecode(aws_iam_role_policy.host["build"].policy).Statement : statement if statement.Sid == "NoOtherParameters"]).NotResource == one([for statement in jsondecode(aws_iam_role_policy.host["build"].policy).Statement : statement if statement.Sid == "ReadOwnParameters"]).Resource
    error_message = "A host reads exactly its two parameters, by name, not the whole prefix."
  }
  assert {
    condition     = one([for statement in jsondecode(aws_iam_role_policy.host["build"].policy).Statement : statement if statement.Sid == "NoAssumeRole"]).Effect == "Deny"
    error_message = "The role denies itself sts:AssumeRole."
  }
}

# A trust policy changed outside Terraform (here, also trusting an account) fails the check against the live role,
# for either pool.
run "live_trust_drift_fails_the_build_check" {
  command = plan
  override_data {
    target = data.aws_iam_role.host_live_build
    values = {
      assume_role_policy = "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Principal\":{\"Service\":\"ec2.amazonaws.com\",\"AWS\":\"arn:aws:iam::904534089871:root\"},\"Action\":\"sts:AssumeRole\"}]}"
    }
  }
  expect_failures = [check.host_role_trust_build]
}

run "live_trust_drift_fails_the_test_check" {
  command = plan
  override_data {
    target = data.aws_iam_role.host_live_test
    values = {
      assume_role_policy = "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Principal\":{\"AWS\":\"arn:aws:iam::904534089871:role/camelrun-job-hosts-build-prod\"},\"Action\":\"sts:AssumeRole\"}]}"
    }
  }
  expect_failures = [check.host_role_trust_test]
}

run "launch_templates_harden_the_host" {
  command = apply
  assert {
    condition = alltrue([for pool, template in aws_launch_template.pool :
      template.metadata_options[0].http_tokens == "required"
      && template.metadata_options[0].http_put_response_hop_limit == 1
      && template.enclave_options[0].enabled
      && template.key_name == null
      && template.network_interfaces[0].associate_public_ip_address == "true"
      && template.iam_instance_profile[0].name == "camelrun-job-hosts-${pool}-prod"
      && anytrue([for mapping in template.block_device_mappings : mapping.virtual_name == "ephemeral0"])
    ])
    error_message = "Both launch templates need IMDSv2 with hop limit 1, Nitro Enclaves, no key pair, a public IP (no NAT), its own pool's host profile and the instance store."
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

run "network_public_without_nat" {
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
    condition     = length(aws_subnet.pool) == 3 && alltrue([for subnet in aws_subnet.pool : subnet.map_public_ip_on_launch])
    error_message = "The pools get three dedicated public subnets."
  }
  assert {
    condition     = aws_route.pools_default.destination_cidr_block == "0.0.0.0/0" && aws_route.pools_default.gateway_id == "igw-0123456789abcdef0" && aws_route.pools_default.nat_gateway_id == null
    error_message = "The pools route to the VPC's existing internet gateway, not a NAT."
  }
  assert {
    condition     = length(aws_vpc_endpoint.s3) == 1 && aws_vpc_endpoint_route_table_association.s3.route_table_id == aws_route_table.pools.id
    error_message = "S3 goes through a gateway endpoint on the pools' route table."
  }
  assert {
    condition     = toset(aws_network_acl.pools.subnet_ids) == toset([for subnet in aws_subnet.pool : subnet.id])
    error_message = "The network ACL covers every pool subnet."
  }
  assert {
    condition     = [for rule in [aws_network_acl_rule.in_return_tcp, aws_network_acl_rule.in_fragmentation_needed] : [rule.egress, rule.protocol, rule.rule_action]] == [[false, "tcp", "allow"], [false, "icmp", "allow"]] && aws_network_acl_rule.in_return_tcp.from_port == 1024 && aws_network_acl_rule.in_return_tcp.to_port == 65535 && aws_network_acl_rule.in_fragmentation_needed.icmp_type == 3 && aws_network_acl_rule.in_fragmentation_needed.icmp_code == 4
    error_message = "Inbound, the ACL allows only TCP return traffic (1024-65535) and ICMP fragmentation-needed."
  }
  assert {
    condition     = aws_network_acl_rule.out_https.egress && aws_network_acl_rule.out_https.from_port == 443 && aws_network_acl_rule.out_https.to_port == 443 && aws_network_acl_rule.out_ephemeral.egress && aws_network_acl_rule.out_ephemeral.from_port == 1024 && aws_network_acl_rule.out_ephemeral.to_port == 65535
    error_message = "Outbound, the ACL allows only TCP 443 and the ephemeral reply ports."
  }
}

run "pools_on_demand_with_maxima" {
  command = apply
  assert {
    condition     = aws_autoscaling_group.build[0].min_size == 0 && aws_autoscaling_group.build[0].desired_capacity == 0 && aws_autoscaling_group.build[0].max_size == 4
    error_message = "Build pool: warm 0 by default (scale from zero), max 4."
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

run "warm_build_hosts_are_a_variable" {
  command = plan
  variables {
    build_warm_size = 2
  }
  assert {
    condition     = aws_autoscaling_group.build[0].min_size == 2 && aws_autoscaling_group.build[0].desired_capacity == 2
    error_message = "build_warm_size sets the build pool's min and desired."
  }
}

run "metal_and_medium_are_refused" {
  command = plan
  variables {
    test_instance_types = ["c8gd.metal-24xl"]
  }
  expect_failures = [aws_launch_template.pool["test"]]
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
    build_warm_size = 2
    build_max_size  = 1
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
