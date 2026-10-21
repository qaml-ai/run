# Optional platform Anthropic credential. Empty IDs leave federation off.
variable "anthropic_federation_rule_id" {
  type        = string
  default     = ""
  description = "Anthropic workload federation rule ID. Set all four Anthropic IDs to enable."
}

variable "anthropic_organization_id" {
  type        = string
  default     = ""
  description = "Anthropic organization ID for workload federation."
}

variable "anthropic_service_account_id" {
  type        = string
  default     = ""
  description = "Anthropic service account ID for workload federation."
}

variable "anthropic_workspace_id" {
  type        = string
  default     = ""
  description = "Anthropic workspace ID for workload federation."
}

locals {
  anthropic_federation_environment = {
    AGENT_ANTHROPIC_FEDERATION_RULE_ID = var.anthropic_federation_rule_id
    AGENT_ANTHROPIC_ORGANIZATION_ID    = var.anthropic_organization_id
    AGENT_ANTHROPIC_SERVICE_ACCOUNT_ID = var.anthropic_service_account_id
    AGENT_ANTHROPIC_WORKSPACE_ID       = var.anthropic_workspace_id
  }
}

# AWS provider 6.66.0 supports this account-wide resource. Opt in separately from
# the runtime IDs: other workloads may already use the account's issuer.
variable "anthropic_federation_manage_account" {
  type        = bool
  default     = false
  description = "Manage AWS account outbound web identity federation here. Import first if already enabled."
}

resource "aws_iam_outbound_web_identity_federation" "anthropic" {
  count = var.anthropic_federation_manage_account ? 1 : 0

  lifecycle {
    prevent_destroy = true
  }
}
