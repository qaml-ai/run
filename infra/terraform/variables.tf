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
  description = "Name of the runtime service and most of its resources."
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

variable "database_instance_class" {
  description = "RDS instance class for the control-plane Postgres."
  type        = string
  default     = "db.t4g.small"
}

variable "database_engine_version" {
  description = "Postgres major version; minor versions upgrade automatically."
  type        = string
  default     = "17"
}

# --- ECS service (ecs.tf, alb.tf) ---

variable "runtime_image_tag" {
  description = "Image tag for the task definition Terraform registers. Deploys (infra/ecs-deploy.sh) register later revisions outside Terraform; the service ignores task_definition."
  type        = string
  default     = "95d93dde9f7b"
}

variable "task_cpu" {
  type    = number
  default = 1024
}

variable "task_memory" {
  type    = number
  default = 2048
}

variable "service_min_count" {
  description = "Minimum (and initial) number of runtime tasks. Two, one per AZ; CPU and memory autoscaling add tasks up to service_max_count under load."
  type        = number
  default     = 2
}

variable "service_max_count" {
  description = "Most runtime tasks autoscaling may run. Each holds up to AGENT_DATABASE_POOL_SIZE (10) connections, all through RDS Proxy."
  type        = number
  default     = 20
}

variable "service_cpu_target" {
  type    = number
  default = 60
}

variable "service_memory_target" {
  type    = number
  default = 70
}

variable "container_insights" {
  description = "ECS Container Insights; the RunningTaskCount alarm needs it."
  type        = string
  default     = "enabled"
}

variable "alb_idle_timeout" {
  description = "Seconds an idle ALB connection stays open. SSE streams heartbeat every few seconds."
  type        = number
  default     = 360
}

variable "alb_access_logs_bucket" {
  description = "S3 bucket for ALB access logs, or null for none. The bucket needs the ELB log delivery policy."
  type        = string
  default     = null
}

variable "runtime_env" {
  description = "Non-secret runtime settings for the ECS tasks. Storage, database and public URL settings are derived in ecs.tf."
  type        = map(string)
  default = {
    AGENT_PROVIDER              = "anthropic"
    AGENT_MODEL                 = "claude-sonnet-5-5"
    AGENT_MAX_AGENTS            = "1000"
    AGENT_MAX_AGENTS_PER_TENANT = "500"
    AGENT_IDLE_MS               = "300000"
    AGENT_TOOL_TIMEOUT_MS       = "60000"
    GITHUB_ORG                  = "qaml-ai"
    # Anyone with a GitHub account may sign in to the console. Their tenant is prepaid: platform keys only
    # against its credit, with the free limits (AGENT_FREE_*) until it buys some.
    AGENT_OPEN_SIGNUP = "true"
    AGENT_HOSTING     = "inline"
    # Operator tenants that may post manual credit adjustments (POST /v1/billing/adjustments).
    AGENT_BILLING_ADMINS = "miguel"
  }
}


variable "github_subjects" {
  description = "OIDC subject prefixes of the repository whose production environment may deploy. The repository uses immutable subjects: gh api repos/<owner>/<repo>/actions/oidc/customization/sub shows sub_claim_prefix. The prefix carries the repository's name, so a rename changes it: both names are listed while qaml-ai/agent-runtime becomes qaml-ai/run, and the old one is dropped once a deploy from the new name has succeeded."
  type        = list(string)
  default     = ["qaml-ai@151090534/agent-runtime@1384214784", "qaml-ai@151090534/run@1384214784"]
}

variable "email_domain" {
  description = "Domain whose mail SES receives for email channels (e.g. in.agents.camelai.dev), in the Cloudflare zone. Empty disables email channels and everything in email.tf."
  type        = string
  default     = ""
}
