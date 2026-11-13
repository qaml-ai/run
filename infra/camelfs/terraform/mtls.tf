# Mutual TLS (camel-fs-files.md §9.12; Miguel, 2026-11-13): a connection's certificate proves WHICH MACHINE is
# calling; the §9.10 token still decides what a runtime caller may do.
#
#   1. Cloudflare → public ALB: Authenticated Origin Pulls with a certificate from OUR OWN small offline AOP CA
#      (never Cloudflare's shared one, which only proves "came through Cloudflare"). The public HTTPS listener runs
#      mTLS in verify mode against a trust store holding only that CA; the Cloudflare-ranges security group stays
#      as the second lock. The CA key lives in Secrets Manager (aop-ca), used only by infra/camelfs/aop.sh to sign
#      the yearly leaf that is uploaded to Cloudflare; the public CA PEM is pinned by S3 version (aop_ca_version),
#      exactly as the runtime's infra/terraform/origin-mtls.tf pins its bundle.
#   2. Tier ↔ host: AWS Private CA in SHORT-LIVED mode (leaf validity ≤ 7 days; the tier asks for 24 h, renews every
#      8 h). The tier is the registration authority: only the api task role may issue, and only end-entity
#      templates. The internal ALB's 443 listener verifies host certificates against that CA; the host id is the
#      certificate's URI SAN (spiffe://camelfs/host/<id>), which the ALB forwards in X-Amzn-Mtls-Clientcert-*
#      after stripping any client-supplied copy. The tier's own client certificate (spiffe://camelfs/tier) comes
#      from the same CA; hosts verify it on --listen-compute (the host side is K2, not here).
#   3. Enrollment: a new host has no certificate yet, so it presents its STS attestation once on a SEPARATE
#      internal listener without client certificates (enroll_listener_port), which forwards only
#      POST /v1/hosts/enroll, to a SEPARATE container port (enroll_port) where the tier serves only that route and
#      trusts no mTLS header. Two ports, so a request can never arrive on the mTLS-trusting port without having
#      passed the verify-mode listener.
#   4. The camelfs-host+jwt family (service-signing-key, service-verify-keys) is replaced by this and removed.

# --- Trust stores' bucket: public CA certificates only, versioned so a trust store pins one object version ---

locals {
  trust_bucket_name = "${var.name}-${var.env}-trust-${var.account_id}"
}

resource "aws_s3_bucket" "trust" {
  bucket = local.trust_bucket_name
}

resource "aws_s3_bucket_ownership_controls" "trust" {
  bucket = aws_s3_bucket.trust.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "trust" {
  bucket                  = aws_s3_bucket.trust.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "trust" {
  bucket = aws_s3_bucket.trust.id
  versioning_configuration {
    status = "Enabled"
  }
}

# SSE-S3, not KMS: the ELB service reads the bundle with the creating operator's credentials, and a public CA
# certificate needs no customer key.
resource "aws_s3_bucket_server_side_encryption_configuration" "trust" {
  bucket = aws_s3_bucket.trust.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_policy" "trust" {
  bucket     = aws_s3_bucket.trust.id
  depends_on = [aws_s3_bucket_public_access_block.trust]
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "TLSOnly"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.trust.arn, "${aws_s3_bucket.trust.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
}

# --- 1. The AOP CA (offline; aop.sh) and the public listener's trust store ---

# Container only: aop.sh init writes {caCertPem, caKeyPem, notAfter}; nothing in AWS reads it (the api role has no
# secretsmanager permission at all). Do not add a secret version here.
resource "aws_secretsmanager_secret" "aop_ca" {
  name        = "${var.name}/${var.env}/aop-ca"
  description = "camelFS Authenticated Origin Pulls CA (key + certificate, PEM, JSON). Offline: used only by infra/camelfs/aop.sh to sign the yearly client certificate uploaded to Cloudflare. Trusted only by the public ALB."

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_lb_trust_store" "aop" {
  count = var.aop_ca_version == null ? 0 : 1

  name                                     = "${var.name}-${var.env}-aop"
  ca_certificates_bundle_s3_bucket         = aws_s3_bucket.trust.bucket
  ca_certificates_bundle_s3_key            = local.aop_ca_key
  ca_certificates_bundle_s3_object_version = var.aop_ca_version
  tags                                     = { Name = "${var.name}-${var.env}-aop" }

  lifecycle {
    create_before_destroy = true
  }
}

locals {
  aop_ca_key = "aop-ca.pem"
}

# --- 2. The hosts' CA: AWS Private CA, short-lived mode, the tier as registration authority ---

resource "aws_acmpca_certificate_authority" "hosts" {
  type       = "ROOT"
  usage_mode = "SHORT_LIVED_CERTIFICATE"

  certificate_authority_configuration {
    key_algorithm     = "EC_prime256v1"
    signing_algorithm = "SHA256WITHECDSA"
    subject {
      common_name  = "camelFS hosts CA (${var.env})"
      organization = "camelAI"
    }
  }

  # Short-lived mode issues no CRL and no OCSP: a leaf outlives nothing; revocation is expiry plus removing the
  # host from the hosts table (§9.12).
  permanent_deletion_time_in_days = 7
  tags                            = { Name = "${var.name}-${var.env}-hosts-ca" }

  lifecycle {
    # Every host certificate chains to it; replacing it is a trust-store rollover, never a plan's side effect.
    prevent_destroy = true
  }
}

# The root's self-signed certificate (ten years), installed on the CA so it becomes ACTIVE.
resource "aws_acmpca_certificate" "hosts_root" {
  certificate_authority_arn   = aws_acmpca_certificate_authority.hosts.arn
  certificate_signing_request = aws_acmpca_certificate_authority.hosts.certificate_signing_request
  signing_algorithm           = "SHA256WITHECDSA"
  template_arn                = "arn:${data.aws_partition.current.partition}:acm-pca:::template/RootCACertificate/V1"

  validity {
    type  = "YEARS"
    value = 10
  }
}

resource "aws_acmpca_certificate_authority_certificate" "hosts" {
  certificate_authority_arn = aws_acmpca_certificate_authority.hosts.arn
  certificate               = aws_acmpca_certificate.hosts_root.certificate
  certificate_chain         = aws_acmpca_certificate.hosts_root.certificate_chain
}

data "aws_partition" "current" {}

# The CA's public certificate, versioned in the trust bucket; the internal trust store pins that version.
resource "aws_s3_object" "hosts_ca" {
  bucket       = aws_s3_bucket.trust.bucket
  key          = "hosts-ca.pem"
  content      = aws_acmpca_certificate.hosts_root.certificate
  content_type = "application/x-pem-file"

  depends_on = [aws_s3_bucket_versioning.trust]
}

resource "aws_lb_trust_store" "hosts" {
  name                                     = "${var.name}-${var.env}-hosts"
  ca_certificates_bundle_s3_bucket         = aws_s3_bucket.trust.bucket
  ca_certificates_bundle_s3_key            = aws_s3_object.hosts_ca.key
  ca_certificates_bundle_s3_object_version = aws_s3_object.hosts_ca.version_id
  tags                                     = { Name = "${var.name}-${var.env}-hosts" }

  lifecycle {
    create_before_destroy = true
  }
}

# --- 3. Enrollment: a plain-TLS internal listener for POST /v1/hosts/enroll, to its own container port ---

resource "aws_lb_target_group" "enroll" {
  name        = "${var.name}-${var.env}-enroll"
  target_type = "ip"
  protocol    = "HTTP"
  port        = var.enroll_port
  vpc_id      = data.aws_vpc.default.id

  deregistration_delay = 30

  health_check {
    path                = var.api_health_path
    port                = tostring(var.api_port)
    matcher             = "200"
    interval            = 5
    timeout             = 4
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  tags = { Name = "${var.name}-${var.env}-enroll" }
}

resource "aws_lb_listener" "enroll" {
  count = var.certificate_issued ? 1 : 0

  load_balancer_arn = aws_lb.api["internal"].arn
  port              = var.enroll_listener_port
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.api[0].certificate_arn

  # No client certificate here, by design: the only route is the one that gets a host its first certificate.
  mutual_authentication {
    mode = "off"
  }

  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      message_body = "not found"
      status_code  = "404"
    }
  }
}

resource "aws_lb_listener_rule" "enroll" {
  count = var.certificate_issued ? 1 : 0

  listener_arn = aws_lb_listener.enroll[0].arn
  priority     = 10

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.enroll.arn
  }

  condition {
    path_pattern {
      values = ["/v1/hosts/enroll"]
    }
  }
  condition {
    http_request_method {
      values = ["POST"]
    }
  }
}

resource "aws_vpc_security_group_ingress_rule" "alb_internal_hosts_enroll" {
  for_each                     = toset(var.host_security_group_ids)
  security_group_id            = aws_security_group.alb_internal.id
  referenced_security_group_id = each.value
  ip_protocol                  = "tcp"
  from_port                    = var.enroll_listener_port
  to_port                      = var.enroll_listener_port
  description                  = "Enrollment (no client certificate) from camelfsd --role host"
}

resource "aws_vpc_security_group_egress_rule" "alb_internal_to_enroll" {
  security_group_id            = aws_security_group.alb_internal.id
  referenced_security_group_id = aws_security_group.api.id
  ip_protocol                  = "tcp"
  from_port                    = var.enroll_port
  to_port                      = var.enroll_port
  description                  = "API tasks, enrollment port"
}

resource "aws_vpc_security_group_ingress_rule" "api_enroll_from_alb_internal" {
  security_group_id            = aws_security_group.api.id
  referenced_security_group_id = aws_security_group.alb_internal.id
  ip_protocol                  = "tcp"
  from_port                    = var.enroll_port
  to_port                      = var.enroll_port
  description                  = "internal load balancer, enrollment port"
}
