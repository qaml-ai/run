# Journey events (src/journey.ts): what the runtime tells the operator's own analytics store about accounts (made,
# signed in to, a first run, a payment) and the console's pages, and the reports the admin site asks that store for
# (src/admin-report.ts). The two signing secrets are containers in secrets.tf; infra/journey.sh stores their values.
# Until the journey secret has a value the runtime leaves all of this off, so applying this before the values are
# stored changes nothing. An empty journey_url turns it off entirely.

locals {
  journey_environment = var.journey_url == "" ? {} : {
    AGENT_JOURNEY_URL               = var.journey_url
    AGENT_JOURNEY_SECRET_ARN        = aws_secretsmanager_secret.runtime["journey"].arn
    AGENT_JOURNEY_REPORT_SECRET_ARN = aws_secretsmanager_secret.runtime["journey-report"].arn
    # The cookies the operator's website sets: its visitor id, readable here because both are under the cookie
    # domain, and a browser's answer about being measured.
    AGENT_JOURNEY_VISITOR_COOKIE         = "camel_attribution_id"
    AGENT_JOURNEY_VISITOR_COOKIE_DOMAIN  = var.journey_cookie_domain
    AGENT_JOURNEY_CONSENT_COOKIE         = "camel_consent"
    AGENT_JOURNEY_COLLECT_UNKNOWN        = tostring(var.journey_collect_unknown)
    AGENT_JOURNEY_INTERNAL_EMAIL_DOMAINS = join(",", var.journey_internal_email_domains)
  }
}
