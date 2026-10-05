# Secret containers only. Values are set and rotated outside Terraform
# (the random ones were generated once at setup; tenant.sh and github-oauth.sh
# write the rest), so no secret value ever enters Terraform state. Do not add
# aws_secretsmanager_secret_version resources here.

locals {
  secrets = {
    session-secret = "Derives agent runtime client session tokens. Rotating it invalidates every session token."
    secrets-key    = "AES-256 key that encrypts tenant-set provider keys at rest. Losing it makes stored keys unreadable."
    # The live description predates the move to this repo's layout; kept as-is
    # so adopting it is a no-op.
    tenants      = "Agent runtime tenants: operator token hashes and provider API keys. Edit with infra/agent-runtime/tenant.sh."
    github-oauth = "GitHub OAuth app for agent runtime console sign-in"
    google-oauth = "Google OAuth client for agent runtime console sign-in. Set with infra/google-oauth.sh."
    stripe       = "Stripe secret key and webhook signing secret for agent runtime credit purchases. Set with infra/stripe.sh."
    tool-search  = "OpenRouter API key for tools.search ranking by meaning (embeddings and Jev). Set with infra/tool-search.sh."
    # Read only while discord_managed_enabled is true; empty, the integration stays off.
    discord-managed = "Managed Camel Discord application: JSON {applicationId, botToken, clientSecret, publicKey}. See docs/operations/managed-discord.md."
  }
}

# `billing-email` (the retired Cloudflare billing Worker's shared secret) left this map. prevent_destroy below covers
# every instance and a `removed` block cannot name one instance, so before the first apply without it, drop it from
# the state by hand (it is then deleted by hand too; docs/operations/account-email.md):
#   tofu state rm 'aws_secretsmanager_secret.runtime["billing-email"]'
resource "aws_secretsmanager_secret" "runtime" {
  for_each    = local.secrets
  name        = "${var.secret_prefix}/${each.key}"
  description = each.value

  lifecycle {
    # Deleting session-secret or secrets-key is unrecoverable for users.
    prevent_destroy = true
  }
}

resource "aws_secretsmanager_secret" "operator_token" {
  for_each    = toset(var.operator_token_tenants)
  name        = "${var.secret_prefix}/operator-token/${each.key}"
  description = "Agent runtime operator token for tenant ${each.key}"
}

