# All cloud calls are mocked: these runs never read or touch AWS or Cloudflare. Run with `tofu test` from
# infra/camelfs/terraform (after `tofu init -backend=false`).

mock_provider "aws" {
  mock_data "aws_vpc" {
    defaults = { id = "vpc-0123456789abcdef0", cidr_block = "172.31.0.0/16" }
  }
  mock_data "aws_subnets" {
    defaults = { ids = ["subnet-0123456789abcdef0", "subnet-0123456789abcdef1", "subnet-0123456789abcdef2"] }
  }
  mock_data "aws_sns_topic" {
    defaults = { arn = "arn:aws:sns:us-west-2:904534089871:camelai-agent-runtime-alerts" }
  }
  # The api roles' trust policy, as iam.tf builds it (the mock would otherwise be a random string, not JSON).
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"sts:AssumeRole\",\"Principal\":{\"Service\":\"ecs-tasks.amazonaws.com\"}}]}"
    }
  }
  # The live role the check block reads: as this module creates it.
  mock_data "aws_iam_role" {
    defaults = {
      assume_role_policy = "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Sid\":\"EC2Only\",\"Effect\":\"Allow\",\"Principal\":{\"Service\":\"ec2.amazonaws.com\"},\"Action\":\"sts:AssumeRole\"}]}"
    }
  }
  mock_resource "aws_s3_bucket" {
    defaults = { arn = "arn:aws:s3:::camelfs-prod-904534089871" }
  }
  mock_resource "aws_kms_key" {
    defaults = { arn = "arn:aws:kms:us-west-2:904534089871:key/11111111-2222-3333-4444-555555555555" }
  }
  mock_resource "aws_dynamodb_table" {
    defaults = { arn = "arn:aws:dynamodb:us-west-2:904534089871:table/mocked" }
  }
  mock_resource "aws_acm_certificate" {
    defaults = {
      arn = "arn:aws:acm:us-west-2:904534089871:certificate/11111111-2222-3333-4444-555555555555"
      domain_validation_options = [
        { domain_name = "fs.camelai.dev", resource_record_name = "_a.fs.camelai.dev.", resource_record_type = "CNAME", resource_record_value = "_b.acm-validations.aws." },
        { domain_name = "fs-internal.camelai.dev", resource_record_name = "_c.fs-internal.camelai.dev.", resource_record_type = "CNAME", resource_record_value = "_d.acm-validations.aws." },
      ]
    }
  }
  mock_resource "aws_lb" {
    defaults = { arn = "arn:aws:elasticloadbalancing:us-west-2:904534089871:loadbalancer/app/mocked/0123456789abcdef", arn_suffix = "app/mocked/0123456789abcdef", dns_name = "mocked.us-west-2.elb.amazonaws.com" }
  }
  mock_resource "aws_lb_target_group" {
    defaults = { arn = "arn:aws:elasticloadbalancing:us-west-2:904534089871:targetgroup/mocked/0123456789abcdef", arn_suffix = "targetgroup/mocked/0123456789abcdef" }
  }
  mock_resource "aws_ecr_repository" {
    defaults = { repository_url = "904534089871.dkr.ecr.us-west-2.amazonaws.com/camelfs-prod", arn = "arn:aws:ecr:us-west-2:904534089871:repository/camelfs-prod" }
  }
  mock_resource "aws_secretsmanager_secret" {
    defaults = { arn = "arn:aws:secretsmanager:us-west-2:904534089871:secret:camelfs/prod/mocked-AbCdEf" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::904534089871:role/mocked" }
  }
  mock_resource "aws_iam_policy" {
    defaults = { arn = "arn:aws:iam::904534089871:policy/mocked" }
  }
  mock_resource "aws_ecs_cluster" {
    defaults = { arn = "arn:aws:ecs:us-west-2:904534089871:cluster/camelfs-prod", id = "arn:aws:ecs:us-west-2:904534089871:cluster/camelfs-prod" }
  }
  mock_resource "aws_ecs_task_definition" {
    defaults = { arn = "arn:aws:ecs:us-west-2:904534089871:task-definition/camelfs-prod-api:1" }
  }
}

mock_provider "cloudflare" {
  mock_data "cloudflare_ip_ranges" {
    defaults = { ipv4_cidrs = ["173.245.48.0/20", "103.21.244.0/22", "104.16.0.0/13"] }
  }
}

# --- Foundation: everything but the service, with no image named ---

run "foundation_without_an_image" {
  command = plan

  assert {
    condition     = length(aws_ecs_task_definition.api) == 0 && length(aws_ecs_service.api) == 0 && length(aws_appautoscaling_target.api) == 0 && length(aws_cloudwatch_metric_alarm.running_tasks) == 0
    error_message = "With api_image_tag empty there is no task definition, service, autoscaling or service alarm."
  }
  assert {
    condition     = output.service_name == ""
    error_message = "service_name is empty until an image is named."
  }
  assert {
    condition     = aws_s3_bucket.objects.bucket == "camelfs-prod-904534089871"
    error_message = "The bucket is camelfs-<env>-<account id>: globally unique, and not the prototype's."
  }
  assert {
    condition     = output.table_names == { objects = "camelfs-prod-objects", refs = "camelfs-prod-refs", lineages = "camelfs-prod-lineages" }
    error_message = "Three tables: objects, refs, lineages."
  }
}

# --- The tables' contract with the daemon ---

run "tables_keys_and_protection" {
  command = plan

  assert {
    condition = (
      aws_dynamodb_table.camelfs["objects"].hash_key == "lineage" && aws_dynamodb_table.camelfs["objects"].range_key == "id"
      && aws_dynamodb_table.camelfs["refs"].hash_key == "lineage" && aws_dynamodb_table.camelfs["refs"].range_key == "name"
      && aws_dynamodb_table.camelfs["lineages"].hash_key == "lineage" && aws_dynamodb_table.camelfs["lineages"].range_key == null
    )
    error_message = "Key schemas: objects (lineage, id), refs (lineage, name), lineages (lineage)."
  }
  assert {
    condition     = alltrue([for table in aws_dynamodb_table.camelfs : table.billing_mode == "PAY_PER_REQUEST" && table.point_in_time_recovery[0].enabled && table.deletion_protection_enabled])
    error_message = "Every table is on-demand, with PITR and deletion protection."
  }
  assert {
    condition     = alltrue([for table in aws_dynamodb_table.camelfs : length(table.ttl) == 0 || !try(table.ttl[0].enabled, false)])
    error_message = "No DynamoDB TTL on any table: expiry is the service's decision."
  }
}

# --- Load balancers: HTTP/1.1 only, TLS on both, the right sources ---

run "balancers" {
  command = plan

  assert {
    condition     = alltrue([for balancer in aws_lb.api : balancer.enable_http2 == false])
    error_message = "HTTP/2 is off on both load balancers (the 2026-10-24 stall)."
  }
  assert {
    condition     = aws_lb.api["public"].internal == false && aws_lb.api["internal"].internal == true
    error_message = "One internet-facing balancer for the runtime, one internal balancer for the hosts."
  }
  assert {
    condition     = alltrue([for listener in aws_lb_listener.api_https : listener.protocol == "HTTPS" && listener.port == 443])
    error_message = "Both listeners are HTTPS on 443."
  }
  assert {
    condition     = length(aws_vpc_security_group_ingress_rule.alb_public_cloudflare) == 3 && alltrue([for rule in aws_vpc_security_group_ingress_rule.alb_public_cloudflare : rule.from_port == 443 && rule.to_port == 443])
    error_message = "The public balancer admits 443 from each Cloudflare IPv4 range and nothing else."
  }
  assert {
    condition     = length(aws_vpc_security_group_ingress_rule.alb_internal_hosts) == 0
    error_message = "With no host security groups named, the internal balancer admits nothing."
  }
  assert {
    condition     = cloudflare_dns_record.api_public.proxied == true && cloudflare_dns_record.api_internal.proxied == false
    error_message = "The public name is proxied through Cloudflare; the internal name is DNS only."
  }
  assert {
    condition     = alltrue([for group in aws_lb_target_group.api : group.health_check[0].path == "/v0/health" && group.health_check[0].matcher == "200"])
    error_message = "Both target groups probe the daemon's health route for 200."
  }
}

run "internal_balancer_admits_the_hosts" {
  command = plan
  variables {
    host_security_group_ids = ["sg-0123456789abcdef0", "sg-0fedcba9876543210"]
  }

  assert {
    condition     = toset([for rule in aws_vpc_security_group_ingress_rule.alb_internal_hosts : rule.referenced_security_group_id]) == toset(["sg-0123456789abcdef0", "sg-0fedcba9876543210"])
    error_message = "Each host security group gets one 443 rule on the internal balancer."
  }
}

# --- IAM: least privilege, and the trust invariant ---

run "roles_and_policies" {
  command = plan

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
    error_message = "The host role trusts exactly ec2.amazonaws.com and nothing else."
  }
  assert {
    condition     = aws_iam_instance_profile.host.role == "camelfs-prod-host" && aws_iam_role.host.name == "camelfs-prod-host"
    error_message = "The host role and its instance profile are camelfs-prod-host."
  }
  assert {
    condition = !anytrue(flatten([
      for policy in [jsondecode(aws_iam_role_policy.api.policy), jsondecode(aws_iam_policy.host.policy)] : [
        for statement in policy.Statement : statement.Effect == "Allow" && anytrue([
          for action in flatten([statement.Action]) : action == "s3:DeleteObject" || action == "s3:*" || action == "dynamodb:*" || startswith(action, "sts:")
        ])
      ]
    ]))
    error_message = "Neither the api nor the host policy deletes objects, wildcards a service, or allows sts."
  }
  assert {
    condition = (
      length([for statement in jsondecode(aws_iam_policy.host.policy).Statement : statement if statement.Effect == "Allow" && contains(flatten([statement.Action]), "dynamodb:PutItem")]) == 1
      && length([for statement in jsondecode(aws_iam_policy.host.policy).Statement : statement if statement.Sid == "NoRefsOrLineages" && statement.Effect == "Deny"]) == 1
    )
    error_message = "The host policy writes the objects table only and explicitly denies refs and lineages."
  }
  assert {
    condition = (
      !anytrue([for statement in concat(jsondecode(aws_iam_role_policy.api.policy).Statement, jsondecode(aws_iam_policy.host.policy).Statement) : anytrue([for action in flatten([statement.Action]) : startswith(action, "secretsmanager:")])])
      && [for statement in jsondecode(aws_iam_role_policy.api_execution_jwks.policy).Statement : statement.Action] == [["secretsmanager:GetSecretValue"]]
    )
    error_message = "Neither the api task role nor the host policy reads a secret; the execution role reads the one JWKS secret for the injection."
  }
}

# --- The service, once an image is named ---

run "service_with_an_image" {
  command = plan
  variables {
    api_image_tag           = "0123456789ab"
    host_security_group_ids = ["sg-0123456789abcdef0"]
  }

  assert {
    condition     = length(aws_ecs_service.api) == 1 && length(aws_ecs_task_definition.api) == 1 && length(aws_appautoscaling_target.api) == 1 && length(aws_cloudwatch_metric_alarm.running_tasks) == 1
    error_message = "Naming an image creates the task definition, service, autoscaling and service alarm."
  }
  # The mock gives both target groups one ARN, so the service's load_balancer set collapses to one element here;
  # the dynamic block iterates every group (alb.tf has two), and each registration names the api container.
  assert {
    condition     = length(aws_lb_target_group.api) == 2 && alltrue([for registration in aws_ecs_service.api[0].load_balancer : registration.container_name == "camelfsd" && registration.container_port == 8790])
    error_message = "The service registers the api container with the target groups."
  }
  assert {
    condition     = aws_ecs_task_definition.api[0].runtime_platform[0].cpu_architecture == "ARM64" && contains(aws_ecs_task_definition.api[0].requires_compatibilities, "FARGATE")
    error_message = "The tier is Fargate on Graviton."
  }
  assert {
    condition = (
      jsondecode(aws_ecs_task_definition.api[0].container_definitions)[0].image == "904534089871.dkr.ecr.us-west-2.amazonaws.com/camelfs-prod:0123456789ab"
      && jsondecode(aws_ecs_task_definition.api[0].container_definitions)[0].command == ["api", "--listen", "0.0.0.0:8790", "--data", "/var/lib/camelfs", "--store", "s3://camelfs-prod-904534089871", "--region", "us-west-2", "--token-issuer", "https://run-pilot.camelai.dev", "--refs-table", "camelfs-prod-refs"]
    )
    error_message = "The task runs the named image as `camelfsd api` with the daemon's flags (proto-block, 2026-11-13)."
  }
  assert {
    condition = (
      [for secret in jsondecode(aws_ecs_task_definition.api[0].container_definitions)[0].secrets : secret.name] == ["CAMELFS_JWKS"]
      && !anytrue([for pair in jsondecode(aws_ecs_task_definition.api[0].container_definitions)[0].environment : startswith(pair.name, "CAMELFS_")])
    )
    error_message = "The JWKS is injected from Secrets Manager as CAMELFS_JWKS; no key material is in the environment."
  }
  assert {
    condition     = aws_appautoscaling_target.api[0].min_capacity == 2 && aws_appautoscaling_target.api[0].max_capacity == 8
    error_message = "Autoscaling between api_min_count and api_max_count."
  }
}
