# All cloud calls are mocked: these runs never read or touch AWS, nor fetch Cloudflare's ranges. Run with
# `tofu test` from infra/camelfs/terraform (after `tofu init -backend=false`).

mock_provider "aws" {
  mock_data "aws_vpc" {
    defaults = { id = "vpc-0123456789abcdef0", cidr_block = "172.31.0.0/16" }
  }
  mock_data "aws_subnets" {
    defaults = { ids = ["subnet-0123456789abcdef0", "subnet-0123456789abcdef1", "subnet-0123456789abcdef2"] }
  }
  mock_data "aws_iam_openid_connect_provider" {
    defaults = { arn = "arn:aws:iam::904534089871:oidc-provider/token.actions.githubusercontent.com" }
  }
  mock_data "aws_partition" {
    defaults = { partition = "aws" }
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
  mock_resource "aws_acmpca_certificate_authority" {
    defaults = { arn = "arn:aws:acm-pca:us-west-2:904534089871:certificate-authority/11111111-2222-3333-4444-555555555555", certificate_signing_request = "-----BEGIN CERTIFICATE REQUEST-----\nmock\n-----END CERTIFICATE REQUEST-----\n" }
  }
  mock_resource "aws_acmpca_certificate" {
    defaults = { certificate = "-----BEGIN CERTIFICATE-----\nmock\n-----END CERTIFICATE-----\n", certificate_chain = "" }
  }
  mock_resource "aws_s3_object" {
    defaults = { version_id = "mockversion1" }
  }
  mock_resource "aws_lb_listener" {
    defaults = { arn = "arn:aws:elasticloadbalancing:us-west-2:904534089871:listener/app/mocked/0123456789abcdef/0123456789abcdef" }
  }
  mock_resource "aws_lb_trust_store" {
    defaults = { arn = "arn:aws:elasticloadbalancing:us-west-2:904534089871:truststore/mocked/0123456789abcdef" }
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

mock_provider "http" {
  mock_data "http" {
    defaults = { status_code = 200, response_body = "173.245.48.0/20\n103.21.244.0/22\n104.16.0.0/13\n104.24.0.0/14\n172.64.0.0/13\n131.0.72.0/22\n141.101.64.0/18\n108.162.192.0/18\n190.93.240.0/20\n188.114.96.0/20\n197.234.240.0/22\n198.41.128.0/17\n162.158.0.0/15\n" }
  }
}

# --- The first apply: certificate requested, no listener, no service ---

run "first_apply_before_the_certificate" {
  command = plan

  assert {
    condition     = length(aws_acm_certificate_validation.api) == 0 && length(aws_lb_listener.api_https) == 0 && length(aws_lb_listener.enroll) == 0 && length(aws_ecs_service.api) == 0 && length(aws_appautoscaling_target.api) == 0 && length(aws_cloudwatch_metric_alarm.running_tasks) == 0
    error_message = "Before certificate_issued there is no validation wait, no HTTPS or enrollment listener, no service, no autoscaling and no service alarm: the first apply never hangs on DNS."
  }
  assert {
    condition     = length(aws_lb_trust_store.aop) == 0 && aws_acmpca_certificate_authority.hosts.usage_mode == "SHORT_LIVED_CERTIFICATE" && aws_acmpca_certificate_authority.hosts.type == "ROOT" && aws_lb_trust_store.hosts.ca_certificates_bundle_s3_key == "hosts-ca.pem"
    error_message = "The hosts' CA is a short-lived-mode root with its certificate pinned in the hosts trust store; no AOP trust store until aop_ca_version is set."
  }
  assert {
    condition     = output.service_name == "" && aws_acm_certificate.api.validation_method == "DNS" && aws_acm_certificate.api.domain_name == "fs.camelai.dev" && aws_acm_certificate.api.subject_alternative_names == toset(["fs-internal.camelai.dev"])
    error_message = "The certificate covers both names and is DNS-validated; the service waits for the listeners."
  }
  assert {
    condition     = length(aws_vpc_security_group_ingress_rule.hosts_compute_from_api) == 0 && length(aws_vpc_security_group_egress_rule.api_to_hosts_compute) == 0
    error_message = "With no host security groups named, no compute-port rule exists on either side."
  }
  assert {
    condition     = aws_s3_bucket.objects.bucket == "camelfs-prod-904534089871"
    error_message = "The bucket is camelfs-<env>-<account id>: globally unique, and not the prototype's."
  }
  assert {
    condition     = output.table_names == { objects = "camelfs-prod-objects", refs = "camelfs-prod-refs", lineages = "camelfs-prod-lineages", deliveries = "camelfs-prod-deliveries", hosts = "camelfs-prod-hosts", vms = "camelfs-prod-vms", usage = "camelfs-prod-usage" }
    error_message = "Seven tables: objects, refs, lineages, deliveries, hosts, vms, usage."
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
      && aws_dynamodb_table.camelfs["deliveries"].hash_key == "shard" && aws_dynamodb_table.camelfs["deliveries"].range_key == "id"
      && aws_dynamodb_table.camelfs["hosts"].hash_key == "pool" && aws_dynamodb_table.camelfs["hosts"].range_key == "host"
      && aws_dynamodb_table.camelfs["vms"].hash_key == "id" && aws_dynamodb_table.camelfs["vms"].range_key == null
      && aws_dynamodb_table.camelfs["usage"].hash_key == "shard" && aws_dynamodb_table.camelfs["usage"].range_key == "ulid"
    )
    error_message = "Key schemas: objects (lineage, id), refs (lineage, name), lineages (lineage), deliveries (shard, id), hosts (pool, host), vms (id), usage (shard, ulid)."
  }
  assert {
    condition     = alltrue([for table in aws_dynamodb_table.camelfs : table.billing_mode == "PAY_PER_REQUEST" && table.point_in_time_recovery[0].enabled && table.deletion_protection_enabled])
    error_message = "Every table is on-demand, with PITR and deletion protection."
  }
  assert {
    condition = (
      alltrue([for name, table in aws_dynamodb_table.camelfs : length(table.ttl) == 0 || !try(table.ttl[0].enabled, false) if name != "usage"])
      && try(aws_dynamodb_table.camelfs["usage"].ttl[0].enabled, false) && try(aws_dynamodb_table.camelfs["usage"].ttl[0].attribute_name, "") == "expiresAt"
    )
    error_message = "A DynamoDB TTL on the usage table only (expiresAt: pulled copies); expiry everywhere else is the service's decision."
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
    condition     = length(aws_lb_listener.api_https) == 0
    error_message = "No listener before the certificate is issued."
  }
  assert {
    condition     = length(aws_vpc_security_group_ingress_rule.alb_public_cloudflare) == 13 && alltrue([for rule in aws_vpc_security_group_ingress_rule.alb_public_cloudflare : rule.from_port == 443 && rule.to_port == 443])
    error_message = "The public balancer admits 443 from each Cloudflare IPv4 range and nothing else."
  }
  assert {
    condition     = length(aws_vpc_security_group_ingress_rule.alb_internal_hosts) == 0
    error_message = "With no host security groups named, the internal balancer admits nothing."
  }
  assert {
    condition     = output.dns_records["fs.camelai.dev"].proxied == true && output.dns_records["fs-internal.camelai.dev"].proxied == false && output.dns_records["fs.camelai.dev"].type == "CNAME"
    error_message = "The DNS records to make by hand: the public name proxied, the internal name DNS only."
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
  assert {
    condition = (
      toset([for rule in aws_vpc_security_group_ingress_rule.hosts_compute_from_api : rule.security_group_id]) == toset(["sg-0123456789abcdef0", "sg-0fedcba9876543210"])
      && alltrue([for rule in aws_vpc_security_group_ingress_rule.hosts_compute_from_api : rule.from_port == 8792 && rule.to_port == 8792])
      && toset([for rule in aws_vpc_security_group_egress_rule.api_to_hosts_compute : rule.referenced_security_group_id]) == toset(["sg-0123456789abcdef0", "sg-0fedcba9876543210"])
    )
    error_message = "Each host security group admits the api tasks on the compute port, and the api group may reach it."
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
      && length([for statement in jsondecode(aws_iam_policy.host.policy).Statement : statement if statement.Sid == "NoControlTables" && statement.Effect == "Deny" && length(statement.Resource) == 6]) == 1
    )
    error_message = "The host policy writes the objects table only and explicitly denies the six other tables."
  }
  assert {
    condition     = [for statement in jsondecode(aws_iam_policy.host.policy).Statement : statement.Resource if statement.Sid == "NoResults" && statement.Effect == "Deny"] == [["arn:aws:s3:::camelfs-prod-904534089871/*/results/*"]]
    error_message = "A host never writes a VM result: the tier does."
  }
  assert {
    condition = (
      [for statement in jsondecode(aws_iam_role_policy.guest_image_publisher.policy).Statement : statement.Resource if statement.Sid == "PutGuestImages"] == [["arn:aws:s3:::camelfs-prod-904534089871/guest/*"]]
      && !anytrue([for statement in jsondecode(aws_iam_role_policy.guest_image_publisher.policy).Statement : anytrue([for action in flatten([statement.Action]) : action != "s3:PutObject" && action != "kms:GenerateDataKey"])])
      && jsondecode(aws_iam_role.guest_image_publisher.assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"] == ["repo:qaml-ai@151090534/run@1384214784:environment:production"]
    )
    error_message = "The guest-image publisher puts under guest/ only, from the repository's production environment only."
  }
  assert {
    condition = (
      !anytrue([for statement in concat(jsondecode(aws_iam_role_policy.api.policy).Statement, jsondecode(aws_iam_policy.host.policy).Statement) : anytrue([for action in flatten([statement.Action]) : startswith(action, "secretsmanager:")])])
      && [for statement in jsondecode(aws_iam_role_policy.api_execution_jwks.policy).Statement : statement.Action] == [["secretsmanager:GetSecretValue"]]
      && length(jsondecode(aws_iam_role_policy.api_execution_jwks.policy).Statement[0].Resource) == 1
    )
    error_message = "Neither the api task role nor the host policy reads a secret; the execution role reads the one JWKS secret it injects."
  }
  assert {
    condition = (
      [for statement in jsondecode(aws_iam_role_policy.api.policy).Statement : statement.Condition.StringEquals["acm-pca:TemplateArn"] if statement.Sid == "IssueHostCertificates"] == [["arn:aws:acm-pca:::template/EndEntityCertificate/V1", "arn:aws:acm-pca:::template/EndEntityClientAuthCertificate/V1"]]
      && !anytrue([for statement in jsondecode(aws_iam_policy.host.policy).Statement : anytrue([for action in flatten([statement.Action]) : startswith(action, "acm-pca:")])])
    )
    error_message = "Only the api role issues certificates, and only end-entity ones; hosts touch the CA not at all."
  }
}

# --- The second apply: certificate issued, listeners and the service (at 0 tasks) ---

run "second_apply_with_the_certificate" {
  command = plan
  variables {
    certificate_issued = true
  }

  assert {
    condition     = length(aws_acm_certificate_validation.api) == 1 && length(aws_lb_listener.api_https) == 2 && alltrue([for listener in aws_lb_listener.api_https : listener.protocol == "HTTPS" && listener.port == 443])
    error_message = "With the certificate issued: the validation wait and two HTTPS listeners on 443."
  }
  assert {
    condition = (
      aws_lb_listener.api_https["internal"].mutual_authentication[0].mode == "verify"
      && aws_lb_listener.api_https["internal"].mutual_authentication[0].ignore_client_certificate_expiry == false
      && aws_lb_listener.api_https["public"].mutual_authentication[0].mode == "off"
    )
    error_message = "The internal listener verifies host certificates from the first listener on; the public one runs off until the AOP CA is pinned."
  }
  assert {
    condition = (
      length(aws_lb_listener.enroll) == 1 && aws_lb_listener.enroll[0].port == 8443 && aws_lb_listener.enroll[0].mutual_authentication[0].mode == "off"
      && aws_lb_listener.enroll[0].default_action[0].type == "fixed-response"
      && anytrue([for condition in aws_lb_listener_rule.enroll[0].condition : try(tolist(condition.path_pattern)[0].values, toset([])) == toset(["/v1/hosts/enroll"])])
      && aws_lb_target_group.enroll.port == 8793
    )
    error_message = "The enrollment listener (8443, no client certificate) forwards only POST /v1/hosts/enroll to the enrollment port (8793); everything else is 404."
  }
  assert {
    condition = (
      length(aws_lb_listener_rule.public_no_host_routes) == 1
      && aws_lb_listener_rule.public_no_host_routes[0].action[0].type == "fixed-response"
      && anytrue([for condition in aws_lb_listener_rule.public_no_host_routes[0].condition : try(tolist(condition.path_pattern)[0].values, toset([])) == toset(["/v1/hosts/*"])])
    )
    error_message = "The public listener answers 404 to every /v1/hosts/* path: host routes exist only behind the internal balancer."
  }
  assert {
    condition     = length(aws_ecs_service.api) == 1 && aws_ecs_service.api[0].desired_count == 0 && length(aws_appautoscaling_target.api) == 0 && length(aws_cloudwatch_metric_alarm.running_tasks) == 0
    error_message = "The service exists with no task and no autoscaling until api_min_count is raised."
  }
  assert {
    condition     = jsondecode(aws_ecs_task_definition.api.container_definitions)[0].image == "904534089871.dkr.ecr.us-west-2.amazonaws.com/camelfs-prod:none"
    error_message = "The placeholder image tag; nothing pulls it at 0 tasks."
  }
  assert {
    condition     = aws_ecs_service.api[0].task_definition == aws_ecs_task_definition.api.arn
    error_message = "Before the first deploy the service runs Terraform's own revision, so Terraform's port mappings reach it."
  }
}

run "service_pinned_to_the_deployed_revision" {
  command = plan
  variables {
    certificate_issued          = true
    service_task_definition_arn = "arn:aws:ecs:us-west-2:904534089871:task-definition/camelfs-prod-api:7"
  }

  assert {
    condition     = aws_ecs_service.api[0].task_definition == "arn:aws:ecs:us-west-2:904534089871:task-definition/camelfs-prod-api:7"
    error_message = "After a deploy the service runs the revision deploy.sh saved, whatever Terraform's own revision is."
  }
}

# --- The service running, once an image is deployed and a minimum set ---

run "service_with_an_image" {
  command = plan
  variables {
    certificate_issued      = true
    api_image_tag           = "0123456789ab"
    api_min_count           = 2
    host_security_group_ids = ["sg-0123456789abcdef0"]
  }

  assert {
    condition     = length(aws_ecs_service.api) == 1 && aws_ecs_service.api[0].desired_count == 2 && length(aws_appautoscaling_target.api) == 1 && length(aws_cloudwatch_metric_alarm.running_tasks) == 1
    error_message = "A minimum above 0 runs tasks, scales them and alarms on fewer than the minimum."
  }
  # The mock gives every target group one ARN, so the service's load_balancer set collapses here; the dynamic
  # block iterates every api group (alb.tf has two) plus the enrollment group, and each registration names the
  # api container on its port.
  assert {
    condition     = length(aws_lb_target_group.api) == 2 && alltrue([for registration in aws_ecs_service.api[0].load_balancer : registration.container_name == "camelfsd" && contains([8790, 8793], registration.container_port)])
    error_message = "The service registers the api container with the api target groups and the enrollment group."
  }
  assert {
    condition     = aws_ecs_task_definition.api.runtime_platform[0].cpu_architecture == "ARM64" && contains(aws_ecs_task_definition.api.requires_compatibilities, "FARGATE")
    error_message = "The tier is Fargate on Graviton."
  }
  assert {
    condition = (
      jsondecode(aws_ecs_task_definition.api.container_definitions)[0].image == "904534089871.dkr.ecr.us-west-2.amazonaws.com/camelfs-prod:0123456789ab"
      && jsondecode(aws_ecs_task_definition.api.container_definitions)[0].command == ["api", "--listen", "0.0.0.0:8790", "--listen-enroll", "0.0.0.0:8793", "--hosts-ca", "arn:aws:acm-pca:us-west-2:904534089871:certificate-authority/11111111-2222-3333-4444-555555555555", "--data", "/var/lib/camelfs", "--store", "s3://camelfs-prod-904534089871", "--region", "us-west-2", "--token-issuer", "https://run-pilot.camelai.dev", "--refs-table", "camelfs-prod-refs"]
    )
    error_message = "The task runs the named image as `camelfsd api` with the daemon's flags (proto-block, 2026-11-13)."
  }
  assert {
    condition = (
      [for secret in jsondecode(aws_ecs_task_definition.api.container_definitions)[0].secrets : secret.name] == ["CAMELFS_JWKS"]
      && !anytrue([for pair in jsondecode(aws_ecs_task_definition.api.container_definitions)[0].environment : startswith(pair.name, "CAMELFS_")])
    )
    error_message = "The runtime's JWKS is injected from Secrets Manager; no key material is in the environment, and no service signing key exists."
  }
  assert {
    condition     = aws_appautoscaling_target.api[0].min_capacity == 2 && aws_appautoscaling_target.api[0].max_capacity == 8
    error_message = "Autoscaling between api_min_count and api_max_count."
  }
}

# --- Authenticated Origin Pulls, once the AOP CA is pinned ---

run "public_listener_verifies_once_the_aop_ca_is_pinned" {
  command = plan
  variables {
    certificate_issued = true
    aop_ca_version     = "AbCdEf0123456789"
  }

  assert {
    condition = (
      length(aws_lb_trust_store.aop) == 1 && aws_lb_trust_store.aop[0].ca_certificates_bundle_s3_key == "aop-ca.pem" && aws_lb_trust_store.aop[0].ca_certificates_bundle_s3_object_version == "AbCdEf0123456789"
      && aws_lb_listener.api_https["public"].mutual_authentication[0].mode == "verify"
      && aws_lb_listener.api_https["public"].mutual_authentication[0].ignore_client_certificate_expiry == false
      && output.mtls.public_mode == "verify"
    )
    error_message = "With aop_ca_version set, the public listener requires Cloudflare's certificate from the pinned AOP CA."
  }
  assert {
    condition     = length(aws_vpc_security_group_ingress_rule.alb_public_cloudflare) == 13
    error_message = "The Cloudflare-ranges group stays as the second lock."
  }
}
