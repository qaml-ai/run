# The primary hostname, run.camelai.com: a second name for the same ALB, in
# another Cloudflare zone, on a certificate of its own that the HTTPS listener
# serves by SNI. The first hostname (dns.tf, alb.tf) keeps serving unchanged.
# Proxied like it, so Cloudflare connects to the ALB as run.camelai.com and the
# zone's SSL mode must be Full (strict).

data "cloudflare_zone" "primary" {
  filter = { name = var.primary_zone }
}

resource "aws_acm_certificate" "primary" {
  domain_name       = var.primary_hostname
  validation_method = "DNS"
  tags              = { Name = "${var.name}-primary" }

  lifecycle {
    create_before_destroy = true
  }
}

resource "cloudflare_dns_record" "primary_cert_validation" {
  for_each = {
    for option in aws_acm_certificate.primary.domain_validation_options : option.domain_name => option
  }
  zone_id = data.cloudflare_zone.primary.id
  name    = trimsuffix(each.value.resource_record_name, ".")
  type    = each.value.resource_record_type
  content = trimsuffix(each.value.resource_record_value, ".")
  ttl     = 60
  proxied = false
  comment = "ACM validation for ${var.primary_hostname} (${var.name} ALB)"
}

resource "aws_acm_certificate_validation" "primary" {
  certificate_arn         = aws_acm_certificate.primary.arn
  validation_record_fqdns = [for record in cloudflare_dns_record.primary_cert_validation : record.name]
}

resource "aws_lb_listener_certificate" "primary" {
  listener_arn    = aws_lb_listener.https.arn
  certificate_arn = aws_acm_certificate_validation.primary.certificate_arn
}

resource "cloudflare_dns_record" "primary" {
  zone_id = data.cloudflare_zone.primary.id
  name    = var.primary_hostname
  type    = "CNAME"
  content = aws_lb.runtime.dns_name
  ttl     = 1
  proxied = true
  comment = "${var.name} ALB"

  # Only once the ALB can answer for the name.
  depends_on = [aws_lb_listener_certificate.primary]

  lifecycle {
    precondition {
      condition     = contains([var.hostname, var.primary_hostname], var.public_hostname)
      error_message = "public_hostname must be hostname or primary_hostname."
    }
  }
}
