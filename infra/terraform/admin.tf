# The team's admin site (src/admin-site.ts): admin.camelai.dev, a third name for the same ALB on a certificate
# of its own, proxied like the others. Cloudflare Access signs the team in. Its application ("camelRun admin":
# Google Workspace only, the reusable "camelAI employees" policy) is managed in the Zero Trust dashboard or with
# the cf CLI, like the account's other Access apps; its AUD tag is admin_access_aud. The runtime checks each
# request's Access token itself, so the site answers nothing without it. An empty admin_hostname turns it all off.

locals {
  admin_enabled = var.admin_hostname != ""
  admin_environment = local.admin_enabled ? {
    AGENT_ADMIN_HOST        = var.admin_hostname
    AGENT_ADMIN_ACCESS_TEAM = var.admin_access_team
    AGENT_ADMIN_ACCESS_AUD  = var.admin_access_aud
  } : {}
}

resource "aws_acm_certificate" "admin" {
  count             = local.admin_enabled ? 1 : 0
  domain_name       = var.admin_hostname
  validation_method = "DNS"
  tags              = { Name = "${var.name}-admin" }

  lifecycle {
    create_before_destroy = true
  }
}

resource "cloudflare_dns_record" "admin_cert_validation" {
  for_each = local.admin_enabled ? {
    for option in aws_acm_certificate.admin[0].domain_validation_options : option.domain_name => option
  } : {}
  zone_id = var.cloudflare_zone_id
  name    = trimsuffix(each.value.resource_record_name, ".")
  type    = each.value.resource_record_type
  content = trimsuffix(each.value.resource_record_value, ".")
  ttl     = 60
  proxied = false
  comment = "ACM validation for ${var.admin_hostname} (${var.name} ALB)"
}

resource "aws_acm_certificate_validation" "admin" {
  count                   = local.admin_enabled ? 1 : 0
  certificate_arn         = aws_acm_certificate.admin[0].arn
  validation_record_fqdns = [for record in cloudflare_dns_record.admin_cert_validation : record.name]
}

resource "aws_lb_listener_certificate" "admin" {
  count           = local.admin_enabled ? 1 : 0
  listener_arn    = aws_lb_listener.https.arn
  certificate_arn = aws_acm_certificate_validation.admin[0].certificate_arn
}

resource "cloudflare_dns_record" "admin" {
  count   = local.admin_enabled ? 1 : 0
  zone_id = var.cloudflare_zone_id
  name    = var.admin_hostname
  type    = "CNAME"
  content = aws_lb.runtime.dns_name
  ttl     = 1
  proxied = true
  comment = "${var.name} ALB (admin site, behind Cloudflare Access)"

  # Only once the ALB can answer for the name.
  depends_on = [aws_lb_listener_certificate.admin]
}
