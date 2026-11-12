variable "region" {
  description = "Region of the job-host pools (the runtime's region)."
  type        = string
  default     = "us-west-2"
}

variable "account_id" {
  description = "The only AWS account this configuration may touch (camelRun prod)."
  type        = string
  default     = "904534089871"
}

variable "env" {
  description = "Environment suffix for names (camelrun-job-images-<env>, /camelrun/job-hosts/<env>/...)."
  type        = string
  default     = "prod"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,15}$", var.env))
    error_message = "env is a short lowercase name."
  }
}

variable "name" {
  description = "Prefix for the pools' resource names."
  type        = string
  default     = "camelrun-job-hosts"
}

# --- Runtime ---

variable "runtime_public_url" {
  description = "The runtime's AGENT_PUBLIC_URL (backends/workers/wrangler.pilot.jsonc). Hosts connect to it, and the enrollment audience is camelrun-job-host:<this>."
  type        = string
  default     = "https://run-pilot.camelai.dev"
  validation {
    condition     = can(regex("^https://[a-z0-9.-]+$", var.runtime_public_url))
    error_message = "runtime_public_url is an https origin with no path or trailing slash, exactly as AGENT_PUBLIC_URL."
  }
}

# --- Network ---

variable "private_subnets" {
  description = "Private subnets for the pools in the default VPC: availability zone => IPv4 CIDR. The CIDRs must be free in the VPC (the default subnets use 172.31.0.0/20 through 172.31.48.0/20)."
  type        = map(string)
  default = {
    "us-west-2a" = "172.31.128.0/20"
    "us-west-2b" = "172.31.144.0/20"
    "us-west-2c" = "172.31.160.0/20"
  }
  validation {
    condition     = length(var.private_subnets) > 0 && alltrue([for cidr in values(var.private_subnets) : can(cidrhost(cidr, 0))])
    error_message = "private_subnets needs at least one availability zone with a valid CIDR."
  }
}

variable "nat_subnet_az" {
  description = "Availability zone of the one NAT gateway (in that zone's default public subnet). One NAT, not one per AZ: a zone outage stops new egress from the pools in the other zones, which is acceptable while testing."
  type        = string
  default     = "us-west-2a"
}

variable "s3_gateway_endpoint_id" {
  description = "An existing S3 gateway endpoint in the default VPC to attach the pools' route table to. Empty creates one (no endpoint exists in infra/terraform)."
  type        = string
  default     = ""
}

# --- Pools ---

variable "build_ami_id" {
  description = "The build-pool AMI from slice 1 (infra/job-hosts/image/). Empty: no build launch template, ASG or alarms are created."
  type        = string
  default     = ""
  validation {
    condition     = var.build_ami_id == "" || can(regex("^ami-[0-9a-f]{8,17}$", var.build_ami_id))
    error_message = "build_ami_id is an AMI id (ami-...) or empty."
  }
}

variable "test_ami_id" {
  description = "The test-pool AMI from slice 1. Empty: no test launch template, ASG or alarms are created."
  type        = string
  default     = ""
  validation {
    condition     = var.test_ami_id == "" || can(regex("^ami-[0-9a-f]{8,17}$", var.test_ami_id))
    error_message = "test_ami_id is an AMI id (ami-...) or empty."
  }
}

variable "build_instance_type" {
  description = "Build-pool instance type (Graviton, with NVMe instance store)."
  type        = string
  default     = "r8gd.4xlarge"
}

variable "build_warm_size" {
  description = "Build hosts kept running (ASG min and desired). Each r8gd.4xlarge is about $1.18/h on demand."
  type        = number
  default     = 2
}

variable "build_max_size" {
  description = "Most build hosts (the spend cap)."
  type        = number
  default     = 4
  validation {
    condition     = var.build_max_size >= 0 && var.build_max_size <= 4
    error_message = "build_max_size is at most 4 (Miguel, 2026-11-12); raise this bound in the same change that raises it."
  }
}

variable "test_instance_types" {
  description = "Test-pool instance types, in order of preference (Graviton, with NVMe instance store)."
  type        = list(string)
  default     = ["c8gd.4xlarge"]
  validation {
    condition     = length(var.test_instance_types) > 0
    error_message = "test_instance_types needs at least one type."
  }
}

variable "test_max_size" {
  description = "Most test hosts (the spend cap). The test pool's min is 0; slice 8 scales it on the runtime's queue depth."
  type        = number
  default     = 16
  validation {
    condition     = var.test_max_size >= 0 && var.test_max_size <= 16
    error_message = "test_max_size is at most 16 (Miguel, 2026-11-12); raise this bound in the same change that raises it."
  }
}

variable "test_use_spot" {
  description = "Run the test pool on spot (price-capacity-optimized, capacity rebalance on). Off: on-demand only (Miguel, 2026-11-12)."
  type        = bool
  default     = false
}

variable "root_volume_gib" {
  description = "Root EBS volume (gp3, encrypted). Images, snapshots and job disks live on the NVMe instance store, not here."
  type        = number
  default     = 30
}

variable "drain_timeout_seconds" {
  description = "Heartbeat timeout of the termination lifecycle hooks: how long a terminating host may drain its jobs before EC2 continues."
  type        = number
  default     = 900
  validation {
    condition     = var.drain_timeout_seconds >= 30 && var.drain_timeout_seconds <= 7200
    error_message = "drain_timeout_seconds is between 30 and 7200 (the lifecycle hook limits)."
  }
}

# --- Images bucket ---

variable "outputs_expiry_days" {
  description = "Objects under outputs/ are deleted after this many days."
  type        = number
  default     = 7
}

variable "snapshot_expiry_days" {
  description = "Snapshots tagged unreferenced=true (by the runtime's snapshot GC, slice 5), and every noncurrent version, are deleted after this many days."
  type        = number
  default     = 30
}

# --- Alarms ---

variable "alerts_topic_name" {
  description = "The runtime's us-west-2 alerts topic (infra/terraform/alarms.tf, aws_sns_topic.alerts_regional), which emails Miguel. Looked up by name, not managed here."
  type        = string
  default     = "camelai-agent-runtime-alerts"
}
