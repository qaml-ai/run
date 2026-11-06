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
    # Journey events (journey.tf): each stays off until infra/journey.sh stores its value. Two secrets, never one
    # value: whoever can ask the store for reports must not be able to sign an event or an erasure.
    journey        = "Standard Webhooks secret (whsec_...) that signs journey events to the operator's analytics store. Set with infra/journey.sh."
    journey-report = "Standard Webhooks secret (whsec_...) the admin site asks the journey store's reports with. Never the journey secret's value. Set with infra/journey.sh."
    azure-openai   = "Azure OpenAI resource for platform-key images, transcription and realtime voice: JSON {endpoint, apiKey, imageDeployment?, transcriptionDeployment?, realtimeDeployment?}. Set with infra/azure-openai.sh."
  }
}

# `discord-managed` (the managed Camel Discord bot, removed with Discord channels in #684) left this map the same way:
#   tofu state rm 'aws_secretsmanager_secret.runtime["discord-managed"]'
# then delete the secret by hand (aws secretsmanager delete-secret --secret-id <prefix>/discord-managed).
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

