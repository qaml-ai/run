variable "region" {
  description = "Region for everything except the us-east-1 alerting resources."
  type        = string
  default     = "us-west-2"
}

variable "account_id" {
  description = "The only AWS account this configuration may touch."
  type        = string
  default     = "904534089871"
}

variable "name" {
  description = "Name of the runtime host and most of its resources."
  type        = string
  default     = "camelai-agent-runtime"
}

variable "hostname" {
  description = "Public hostname of the runtime."
  type        = string
  default     = "agents.camelai.dev"
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone id of camelai.dev."
  type        = string
  default     = "3180d911f20372a279a4ea408aebc765"
}

variable "secret_prefix" {
  description = "Secrets Manager name prefix for the runtime's secrets."
  type        = string
  default     = "camelai/agent-runtime"
}

variable "operator_token_tenants" {
  description = "Tenants whose operator-token secret containers Terraform manages. infra/tenant.sh creates these; add a tenant here (and an import block) to adopt its secret."
  type        = list(string)
  default     = ["miguel"]
}

variable "instance_type" {
  type    = string
  default = "t4g.medium"
}

variable "root_volume_gb" {
  type    = number
  default = 40
}

# --- Agent state bucket (state-bucket.tf) ---

variable "state_bucket_name" {
  description = "S3 bucket for agent state (AGENT_S3_BUCKET)."
  type        = string
  default     = "camelai-agent-runtime-state"
}

variable "state_prefix" {
  description = "Key prefix the runtime uses inside the state bucket (AGENT_S3_PREFIX). The instance role may only touch keys under it."
  type        = string
  default     = "agents"

  validation {
    condition     = can(regex("^[A-Za-z0-9][A-Za-z0-9._-]*$", var.state_prefix))
    error_message = "state_prefix must be a single non-empty path segment without slashes."
  }
}

variable "noncurrent_version_days" {
  description = "Days before overwritten or deleted versions of state objects are expired."
  type        = number
  default     = 30
}

# --- Executor tier (executor.tf) ---

variable "executor_count" {
  description = "Number of code executor hosts infra/executor/deploy.sh launches. 0 leaves the executor tier (secret, security groups, launch template) uncreated."
  type        = number
  default     = 0

  validation {
    condition     = var.executor_count >= 0 && floor(var.executor_count) == var.executor_count
    error_message = "executor_count must be a whole number >= 0."
  }
}

variable "executor_name" {
  type    = string
  default = "camelai-agent-executor"
}

variable "executor_instance_type" {
  type    = string
  default = "t4g.small"
}

variable "executor_port" {
  description = "Port executors listen on; only the runtime group may reach it."
  type        = number
  default     = 8790
}

variable "executor_callback_port" {
  description = "Runtime callback listener port; only the executor group may reach it."
  type        = number
  default     = 8791
}
