# The team's ops dashboard, the admin site (src/admin-site.ts, docs/operations/admin-analytics.md): a path of the
# primary hostname, https://run.camelai.com/ops (admin_hostname, admin_path), given to the runtime as AGENT_ADMIN_URL.
# That name has its certificate and DNS record already (dns-primary.tf), so nothing is made for it here. A hostname
# that is not the runtime's gets a certificate of its own on the HTTPS listener and a proxied CNAME, and may be the
# site's whole (admin_path ""); a runtime hostname never may, which the plan refuses, as the runtime does at startup.
#
# Cloudflare Access signs the team in, and its policy is who the admins are. The application is "camelRun admin"
# (Zero Trust → Access → Applications; Google Workspace only), managed in the dashboard or with the cf CLI like the
# account's other Access apps; its AUD tag is admin_access_aud. For /ops, edit that application and add a public
# hostname: run.camelai.com, path `ops`. Keep the same application, so its AUD tag, which the runtime checks, stays
# the same. Its policy ("camelRun ops admins", used by this application only) lists the admins' exact addresses, not
# all employees. Until Access covers /ops, the runtime answers it with 401 for everyone, which is safe but useless, so
# add the destination first. admin_emails names the same admins to the runtime (AGENT_ADMIN_EMAILS), which refuses
# anyone else Access signs in: a second lock in case the policy is ever widened. Set it in the deployment's tfvars,
# not in this repository, and change it with the policy.
#
# admin.camelai.dev is retired: applying this destroys its CNAME, its certificate's validation record, and the
# certificate and its place on the listener, so the old address stops resolving. Then remove the admin.camelai.dev
# destination from the Access application.
#
# The runtime checks each request's Access token itself (signature, issuer, audience, expiry), so the site answers
# nothing without one. An image from before AGENT_ADMIN_URL refuses to start with these settings (it wants
# AGENT_ADMIN_HOST with the other two), and the deployment circuit breaker (ecs.tf) rolls it back: applying before
# the new image is deployed, or rolling back to an older one, fails visibly and leaves the running tasks serving.
# An empty admin_hostname turns the site off.

locals {
  admin_enabled = var.admin_hostname != ""
  # One of the runtime's own names (dns.tf, dns-primary.tf): its certificate and record serve the site too.
  admin_on_runtime_host = contains([var.hostname, var.primary_hostname], var.admin_hostname)
  admin_own_hostname    = local.admin_enabled && !local.admin_on_runtime_host
  admin_url             = "https://${var.admin_hostname}${var.admin_path}"
  admin_environment = local.admin_enabled ? merge({
    AGENT_ADMIN_URL         = local.admin_url
    AGENT_ADMIN_ACCESS_TEAM = var.admin_access_team
    AGENT_ADMIN_ACCESS_AUD  = var.admin_access_aud
    # Staff the site leaves out of its counts, read even where journey events are off (journey.tf sets the same).
    AGENT_JOURNEY_INTERNAL_EMAIL_DOMAINS = join(",", var.journey_internal_email_domains)
  }, length(var.admin_emails) > 0 ? { AGENT_ADMIN_EMAILS = join(",", var.admin_emails) } : {}) : {}
}

resource "aws_acm_certificate" "admin" {
  count             = local.admin_own_hostname ? 1 : 0
  domain_name       = var.admin_hostname
  validation_method = "DNS"
  tags              = { Name = "${var.name}-admin" }

  lifecycle {
    create_before_destroy = true
  }
}

resource "cloudflare_dns_record" "admin_cert_validation" {
  for_each = local.admin_own_hostname ? {
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
  count                   = local.admin_own_hostname ? 1 : 0
  certificate_arn         = aws_acm_certificate.admin[0].arn
  validation_record_fqdns = [for record in cloudflare_dns_record.admin_cert_validation : record.name]
}

resource "aws_lb_listener_certificate" "admin" {
  count           = local.admin_own_hostname ? 1 : 0
  listener_arn    = aws_lb_listener.https.arn
  certificate_arn = aws_acm_certificate_validation.admin[0].certificate_arn
}

resource "cloudflare_dns_record" "admin" {
  count   = local.admin_own_hostname ? 1 : 0
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

output "admin_url" {
  description = "The ops dashboard's address, behind Cloudflare Access; null when admin_hostname is empty."
  value       = local.admin_enabled ? "${local.admin_url}/" : null

  # As the runtime checks at startup (src/admin-site.ts): the site may be a path of a runtime hostname, never all of it.
  precondition {
    condition     = !(local.admin_on_runtime_host && var.admin_path == "")
    error_message = "admin_hostname is one of the runtime's own hostnames (hostname, primary_hostname): set admin_path (e.g. /ops) to serve the site under a path of it."
  }
}
