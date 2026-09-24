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

variable "executor_enabled" {
  description = "Create the code executor tier: private subnets, VPC endpoints, the executor Auto Scaling group and its security rules."
  type        = bool
  default     = false
}

variable "executor_name" {
  type    = string
  default = "camelai-agent-executor"
}

variable "executor_ami_id" {
  description = "Executor AMI (the Packer image with Docker and gVisor preinstalled; the private subnets have no internet). Required when executor_enabled."
  type        = string
  default     = null
}

variable "executor_image" {
  description = "Image the executors run. null runs the ECS service's initial image (runtime_image_tag)."
  type        = string
  default     = null
}

variable "executor_instance_type" {
  type    = string
  default = "t4g.small"
}

variable "executor_min_size" {
  type    = number
  default = 2
}

variable "executor_max_size" {
  type    = number
  default = 6
}

variable "executor_cpu_target" {
  description = "Average CPU utilization the executor group scales to hold."
  type        = number
  default     = 60
}

variable "executor_max_concurrency" {
  description = "Concurrent executions per executor host (AGENT_EXECUTOR_MAX_CONCURRENCY)."
  type        = number
  default     = 8
}

variable "executor_port" {
  description = "Port executors listen on; only the runtime tasks may reach it."
  type        = number
  default     = 8790
}

variable "executor_callback_port" {
  description = "Runtime callback listener port; only the executor group may reach it."
  type        = number
  default     = 8791
}

variable "executor_private_subnets" {
  description = "Executor subnets (AZ => CIDR) in the default VPC, one per AZ. 172.31.0.0/18 holds the default subnets; 172.31.64.0/23, .78.0/24, .100-.103 and .106-.107 are taken by other stacks."
  type        = map(string)
  default = {
    "us-west-2a" = "172.31.80.0/24"
    "us-west-2b" = "172.31.81.0/24"
    "us-west-2c" = "172.31.82.0/24"
    "us-west-2d" = "172.31.83.0/24"
  }
}

variable "executor_endpoint_az_count" {
  description = "Interface endpoints cost per AZ; place them in this many of the executor subnets (cross-AZ use still works)."
  type        = number
  default     = 2
}

variable "executor_runtime_callback_cidr" {
  description = "runtime_callback_cidr for infra/executor/user-data.sh. Its host firewall admits 8790 only from here and lets the executor call back only into here, so it must hold the task subnets (172.31.0.0/18: requests and callbacks) and the executor subnets (172.31.80.0/22: NLB health checks). Security groups do the precise restriction."
  type        = string
  default     = "172.31.0.0/17"
}

variable "shared_ssm_endpoint_security_group_ids" {
  description = "Security groups of the ssm/ssmmessages/ec2messages interface endpoints that already exist in the default VPC with private DNS (django-app-ecs-staging). A second endpoint with private DNS cannot be created, so executors use these; they admit 443 from 172.31.0.0/16."
  type        = list(string)
  default     = ["sg-0fc3387d0ca916343"]
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
  default     = "cd9d81af31ea"
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
  description = "Minimum (and initial) number of runtime tasks."
  type        = number
  default     = 2
}

variable "service_max_count" {
  type    = number
  default = 10
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
  description = "Non-secret runtime settings (from instance/runtime.defaults.env). Storage, database and public URL settings are derived in ecs.tf."
  type        = map(string)
  default = {
    AGENT_PROVIDER                 = "anthropic"
    AGENT_MODEL                    = "claude-sonnet-5"
    AGENT_MAX_PROCESSES            = "16"
    AGENT_MAX_PROCESSES_PER_TENANT = "8"
    AGENT_IDLE_MS                  = "300000"
    AGENT_TOOL_TIMEOUT_MS          = "60000"
    GITHUB_ORG                     = "qaml-ai"
    AGENT_HOSTING                  = "inline"
  }
}

# --- DNS (dns.tf) ---

variable "dns_target" {
  description = "Where agents.camelai.dev points: \"host\" (A record at the EC2 Elastic IP) or \"alb\" (CNAME at the load balancer). Flip deliberately; see README.md, Cutover."
  type        = string
  default     = "host"

  validation {
    condition     = contains(["host", "alb"], var.dns_target)
    error_message = "dns_target must be \"host\" or \"alb\"."
  }
}

variable "dns_ttl" {
  description = "TTL of the runtime record. Lower it to 60 at least one old TTL before flipping dns_target."
  type        = number
  default     = 300
}
