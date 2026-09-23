# Secret containers only. Values are set and rotated outside Terraform
# (provision.sh generated the random ones; tenant.sh and github-oauth.sh write
# the rest), so no secret value ever enters Terraform state. Do not add
# aws_secretsmanager_secret_version resources here.

locals {
  secrets = {
    session-secret = "Derives agent runtime client session tokens. Rotating it invalidates every session token."
    secrets-key    = "AES-256 key that encrypts tenant-set provider keys at rest. Losing it makes stored keys unreadable."
    # The live description predates the move to this repo's layout; kept as-is
    # so adopting it is a no-op.
    tenants      = "Agent runtime tenants: operator token hashes and provider API keys. Edit with infra/agent-runtime/tenant.sh."
    github-oauth = "GitHub OAuth app for agent runtime console sign-in"
  }
}

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
