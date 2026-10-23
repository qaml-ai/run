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
