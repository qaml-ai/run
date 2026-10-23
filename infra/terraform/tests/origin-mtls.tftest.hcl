# All cloud calls are mocked; these plans never read production or apply resources.
mock_provider "aws" {
  mock_resource "aws_lb" {
    defaults = { arn = "arn:aws:elasticloadbalancing:us-west-2:904534089871:loadbalancer/app/test/1234567890123456" }
  }
  mock_resource "aws_lb_target_group" {
    defaults = { arn = "arn:aws:elasticloadbalancing:us-west-2:904534089871:targetgroup/test/1234567890123456" }
  }
  mock_resource "aws_acm_certificate" {
    defaults = {
      arn = "arn:aws:acm:us-west-2:904534089871:certificate/12345678-1234-1234-1234-123456789012"
      domain_validation_options = [
        { domain_name = "agents.camelai.dev", resource_record_name = "_test.agents.camelai.dev.", resource_record_type = "CNAME", resource_record_value = "_test.acm-validations.aws." },
        { domain_name = "bots.camelai.com", resource_record_name = "_test.bots.camelai.com.", resource_record_type = "CNAME", resource_record_value = "_test.acm-validations.aws." },
        { domain_name = "bots-next.camelai.com", resource_record_name = "_test.bots-next.camelai.com.", resource_record_type = "CNAME", resource_record_value = "_test.acm-validations.aws." },
      ]
    }
  }
  mock_resource "aws_lb_trust_store" {
    defaults = { arn = "arn:aws:elasticloadbalancing:us-west-2:904534089871:truststore/test/1234567890123456" }
  }
  mock_data "aws_subnets" { defaults = { ids = ["subnet-11111111", "subnet-22222222"] } }
  mock_data "aws_elb_service_account" { defaults = { arn = "arn:aws:iam::797873946194:root" } }
}
mock_provider "cloudflare" {
  mock_data "cloudflare_ip_ranges" { defaults = { ipv4_cidrs = ["173.245.48.0/20"] } }
}
mock_provider "aws" { alias = "us_east_1" }

run "default_does_not_enforce_or_create_trust" {
  command = plan
  plan_options { target = [aws_lb_listener.https] }
  assert {
    condition     = aws_lb_listener.https.mutual_authentication[0].mode == "off" && length(aws_lb_trust_store.origin) == 0
    error_message = "Default must preserve availability without creating trust resources."
  }
}
run "stage_without_enforcement" {
  command = plan
  plan_options { target = [aws_lb_listener.https] }
  variables {
    origin_mtls_ca_bucket  = "test-origin-ca"
    origin_mtls_ca_key     = "origin-ca.pem"
    origin_mtls_ca_version = "v1"
  }
  assert {
    condition     = aws_lb_listener.https.mutual_authentication[0].mode == "off" && length(aws_lb_trust_store.origin) == 1 && aws_lb_trust_store.origin[0].ca_certificates_bundle_s3_object_version == "v1"
    error_message = "Staging must pin the CA version without requiring client certificates."
  }
}
run "enforce_verification_and_expiry" {
  command = plan
  plan_options { target = [aws_lb_listener.https] }
  variables {
    origin_mtls_ca_bucket  = "test-origin-ca"
    origin_mtls_ca_key     = "origin-ca.pem"
    origin_mtls_ca_version = "v1"
    origin_mtls_enforced   = true
  }
  assert {
    condition     = aws_lb_listener.https.mutual_authentication[0].mode == "verify" && aws_lb_listener.https.mutual_authentication[0].trust_store_arn == aws_lb_trust_store.origin[0].arn && aws_lb_listener.https.mutual_authentication[0].ignore_client_certificate_expiry == false
    error_message = "Enforcement must verify against our trust store and reject expired certificates."
  }
}
run "reject_enforcement_without_ca" {
  command = plan
  plan_options { target = [aws_lb_listener.https] }
  variables { origin_mtls_enforced = true }
  expect_failures = [var.origin_mtls_enforced]
}
run "reject_unpinned_ca" {
  command = plan
  plan_options { target = [aws_lb_listener.https] }
  variables {
    origin_mtls_ca_bucket = "test-origin-ca"
    origin_mtls_ca_key    = "origin-ca.pem"
  }
  expect_failures = [var.origin_mtls_ca_bucket]
}
run "reject_partial_ca" {
  command = plan
  plan_options { target = [aws_lb_listener.https] }
  variables { origin_mtls_ca_key = "origin-ca.pem" }
  expect_failures = [var.origin_mtls_ca_bucket]
}
run "reject_blank_ca_version" {
  command = plan
  plan_options { target = [aws_lb_listener.https] }
  variables {
    origin_mtls_ca_bucket  = "test-origin-ca"
    origin_mtls_ca_key     = "origin-ca.pem"
    origin_mtls_ca_version = " "
  }
  expect_failures = [var.origin_mtls_ca_bucket]
}

run "reject_unversioned_s3_object" {
  command = plan
  plan_options { target = [aws_lb_listener.https] }
  variables {
    origin_mtls_ca_bucket  = "test-origin-ca"
    origin_mtls_ca_key     = "origin-ca.pem"
    origin_mtls_ca_version = "null"
  }
  expect_failures = [var.origin_mtls_ca_bucket]
}

run "parallel_origin_requires_ca" {
  command = plan
  plan_options { target = [aws_lb_listener.origin_mtls_parallel] }
  variables { origin_mtls_parallel_enabled = true }
  expect_failures = [var.origin_mtls_parallel_enabled]
}
run "parallel_attachment_requires_origin" {
  command = plan
  plan_options { target = [aws_lb_listener.origin_mtls_parallel] }
  variables { origin_mtls_parallel_attach = true }
  expect_failures = [var.origin_mtls_parallel_attach]
}
run "parallel_origin_leaves_original_listener_off" {
  command = plan
  plan_options { target = [aws_lb_listener.origin_mtls_parallel, aws_lb_listener.https] }
  variables {
    origin_mtls_ca_bucket        = "test-origin-ca"
    origin_mtls_ca_key           = "origin-ca.pem"
    origin_mtls_ca_version       = "v1"
    origin_mtls_parallel_enabled = true
  }
  assert {
    condition     = aws_lb_listener.origin_mtls_parallel[0].mutual_authentication[0].mode == "verify" && aws_lb_listener.https.mutual_authentication[0].mode == "off"
    error_message = "The new origin must enforce mTLS without changing the original listener."
  }
  assert {
    condition     = aws_lb.origin_mtls_parallel[0].connection_logs[0].enabled && aws_lb.origin_mtls_parallel[0].access_logs[0].enabled && !var.origin_mtls_parallel_attach
    error_message = "Staging must enable TLS diagnostics and leave production services unattached."
  }
}

run "edge_disabled_by_default" {
  command = plan
  plan_options { target = [cloudflare_load_balancer.origin_mtls] }
  assert {
    condition     = length(cloudflare_load_balancer.origin_mtls) == 0
    error_message = "Defaults must not replace production DNS routing."
  }
}
run "edge_requires_preparation" {
  command = plan
  plan_options { target = [cloudflare_load_balancer.origin_mtls] }
  variables { origin_mtls_edge_enabled = true }
  expect_failures = [var.origin_mtls_edge_enabled]
}
run "edge_rejects_invalid_weight" {
  command = plan
  plan_options { target = [cloudflare_load_balancer.origin_mtls] }
  variables { origin_mtls_edge_weight = 1.01 }
  expect_failures = [var.origin_mtls_edge_weight]
}

run "old_fallback_requires_full_green" {
  command = plan
  plan_options { target = [cloudflare_load_balancer.origin_mtls] }
  variables { origin_mtls_original_fallback = false }
  expect_failures = [var.origin_mtls_original_fallback]
}

run "prepared_edge_starts_disabled_on_original" {
  command = plan
  plan_options { target = [cloudflare_load_balancer.origin_mtls] }
  variables {
    origin_mtls_ca_bucket        = "test-origin-ca"
    origin_mtls_ca_key           = "origin-ca.pem"
    origin_mtls_ca_version       = "v1"
    origin_mtls_parallel_enabled = true
    origin_mtls_parallel_attach  = true
    origin_mtls_edge_prepared    = true
  }
  assert {
    condition     = alltrue([for lb in cloudflare_load_balancer.origin_mtls : !lb.enabled && lb.fallback_pool == cloudflare_load_balancer_pool.origin_mtls["blue"].id])
    error_message = "Prepared edge routing must remain disabled with the original fallback."
  }
  assert {
    condition     = cloudflare_load_balancer_monitor.origin_mtls["green"].probe_zone == "camelai.com" && length(cloudflare_load_balancer_monitor.origin_mtls["green"].header.Host) == 1 && cloudflare_load_balancer_monitor.origin_mtls["green"].header.Host[0] == var.origin_mtls_canary_hostname && !cloudflare_load_balancer_monitor.origin_mtls["green"].allow_insecure
    error_message = "Green health probes must verify TLS with the AOP-enabled hostname."
  }
}

run "excluded_original_is_not_a_fallback_or_weight" {
  command = plan
  plan_options { target = [cloudflare_load_balancer.origin_mtls] }
  variables {
    origin_mtls_ca_bucket         = "test-origin-ca"
    origin_mtls_ca_key            = "origin-ca.pem"
    origin_mtls_ca_version        = "v1"
    origin_mtls_parallel_enabled  = true
    origin_mtls_parallel_attach   = true
    origin_mtls_edge_prepared     = true
    origin_mtls_edge_enabled      = true
    origin_mtls_edge_weight       = 1
    origin_mtls_original_fallback = false
  }
  assert {
    condition     = alltrue([for lb in cloudflare_load_balancer.origin_mtls : length(lb.default_pools) == 1 && lb.default_pools[0] == cloudflare_load_balancer_pool.origin_mtls["green"].id && lb.fallback_pool == cloudflare_load_balancer_pool.origin_mtls["green"].id && length(lb.random_steering.pool_weights) == 1])
    error_message = "An excluded old origin must not receive default or fallback traffic or retain an unused weight."
  }
}
