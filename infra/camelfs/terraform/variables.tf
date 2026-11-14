variable "region" {
  description = "Region of the camelFS service (the runtime's and the job hosts' region)."
  type        = string
  default     = "us-west-2"
}

variable "account_id" {
  description = "The only AWS account this configuration may touch (camelRun prod)."
  type        = string
  default     = "904534089871"
}

variable "env" {
  description = "Environment suffix for names (camelfs-<env>-..., camelfs/<env>/... secrets)."
  type        = string
  default     = "prod"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,15}$", var.env))
    error_message = "env is a short lowercase name."
  }
}

variable "name" {
  description = "Prefix for every resource name."
  type        = string
  default     = "camelfs"
}

# --- Hostnames (Cloudflare zone camelai.dev) ---

variable "hostname" {
  description = "The public hostname of the API tier, proxied through Cloudflare: what the runtime (Workers, Node) calls. In the cloudflare_zone_id zone."
  type        = string
  default     = "fs.camelai.dev"
  validation {
    condition     = can(regex("^[a-z0-9.-]+$", var.hostname))
    error_message = "hostname is a bare DNS name."
  }
}

variable "internal_hostname" {
  description = "The in-VPC hostname of the API tier (a DNS-only record to the internal load balancer; its name resolves to private addresses): what camelfsd --role host on the job hosts calls. In the cloudflare_zone_id zone."
  type        = string
  default     = "fs-internal.camelai.dev"
  validation {
    condition     = can(regex("^[a-z0-9.-]+$", var.internal_hostname))
    error_message = "internal_hostname is a bare DNS name."
  }
}

variable "certificate_issued" {
  description = "false (the first apply): the certificate is requested and its validation records are output (acm_validation_records) for Cloudflare, and no HTTPS listener or service exists yet. true (the second apply, once the records are in DNS): the validation is awaited, the HTTPS listeners and the ECS service are created. Two applies, so the first never hangs on DNS."
  type        = bool
  default     = false
}

# --- API tier (camelfsd api on ECS Fargate, Graviton) ---

variable "api_image_tag" {
  description = "The camelfsd image tag in this module's ECR repository (infra/camelfs/deploy.sh pushes one). The default names no image: with api_min_count 0 the service runs no task, so nothing pulls it; the first deploy.sh registers the real one."
  type        = string
  default     = "none"
  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]{1,128}$", var.api_image_tag))
    error_message = "api_image_tag is an image tag."
  }
}

variable "service_task_definition_arn" {
  description = "The task definition revision the service runs, as deploy.sh registered it (full ARN with revision; deploy.sh saves it to prod.tfvars after a COMPLETED deployment). Empty, before the first deploy: the service runs Terraform's own revision, so Terraform's port mappings and settings reach it without a deploy. Once set, Terraform's revision changes ship with the next deploy.sh, which copies the family's latest revision."
  type        = string
  default     = ""
  validation {
    condition     = var.service_task_definition_arn == "" || can(regex("^arn:aws:ecs:[a-z0-9-]+:[0-9]{12}:task-definition/camelfs-[a-z0-9-]+-api:[0-9]+$", var.service_task_definition_arn))
    error_message = "service_task_definition_arn is a full camelfs api task definition ARN with its revision, or empty."
  }
}

variable "api_features" {
  description = "Which later flag sets the api command carries, matching what the daemon on the deployed image accepts (Go's flag package exits on an unknown flag): \"refs\" adds --refs-table (C2); \"compute\" adds --listen-enroll, --listen-hosts and --hosts-ca (K4c). Empty: the C1 command alone (--listen --data --store --region --token-issuer; CAMELFS_JWKS from the environment). Flip a feature on when its PR is merged and deployed, in the same apply as the deploy that carries it."
  type        = list(string)
  default     = []
  validation {
    condition     = alltrue([for feature in var.api_features : contains(["refs", "compute"], feature)])
    error_message = "api_features is a subset of [\"refs\", \"compute\"]."
  }
}

variable "pools" {
  description = "The host pools the compute plane places VMs on (camelfsd api --pools; K4c): the job-hosts pools."
  type        = list(string)
  default     = ["build", "test"]
}

variable "enroll_roles" {
  description = "Per pool, the instance role a host of that pool attests with at enrollment (camelfsd api --enroll-roles pool=arn,…; K4c): the job-hosts roles by their fixed names (infra/job-hosts/terraform/iam.tf), which need not exist yet. The tier takes a host's pool from the role it attests with, never from what the host says."
  type        = map(string)
  default = {
    build = "arn:aws:iam::904534089871:role/camelrun-job-hosts-build-prod"
    test  = "arn:aws:iam::904534089871:role/camelrun-job-hosts-test-prod"
  }
  validation {
    condition     = alltrue([for arn in values(var.enroll_roles) : can(regex("^arn:aws:iam::[0-9]{12}:role/[A-Za-z0-9+=,.@_/-]+$", arn))])
    error_message = "enroll_roles values are IAM role ARNs."
  }
}

variable "api_extra_args" {
  description = "Flags appended to the api task's command after the ones this module composes (`camelfsd api --listen --data --store --region --token-issuer --refs-table`; ecs.tf). For the daemon's later flags (--objects-table, --lineages-table once L74 lands) and tuning."
  type        = list(string)
  default     = []
}

variable "token_issuer" {
  description = "The runtime that signs camelFS tokens (its AGENT_PUBLIC_URL; the JWT issuer the tier checks, and where jwks.sh fetches /.well-known/jwks.json). Must equal infra/job-hosts' runtime_public_url."
  type        = string
  default     = "https://run-pilot.camelai.dev"
  validation {
    condition     = can(regex("^https://[a-z0-9.-]+$", var.token_issuer))
    error_message = "token_issuer is an https origin with no path or trailing slash, exactly as AGENT_PUBLIC_URL."
  }
}

variable "api_port" {
  description = "The port camelfsd api listens on (the same the host role's --listen-api uses today)."
  type        = number
  default     = 8790
}

variable "api_health_path" {
  description = "The unauthenticated health route every target group and aop.sh probe; must answer 200 on a ready node. /v1/health since unit 11 (the /v0 surface is deleted; the image must serve /v1/health before this is applied)."
  type        = string
  default     = "/v1/health"
}

variable "api_cpu" {
  description = "Fargate CPU units per task (1024 = 1 vCPU). The tier is CPU-light (hashing, tree walks, merges) and memory-light; its in-process LRU of trees and small blobs is what api_memory sizes."
  type        = number
  default     = 1024
}

variable "api_memory" {
  description = "Fargate memory per task, MiB."
  type        = number
  default     = 2048
}

variable "api_min_count" {
  description = "Fewest API tasks: the service's desired count and the autoscaling minimum (the RTO-0 claim needs 2, one per AZ). 0 (the default, until an image exists): the service exists with no task and no autoscaling."
  type        = number
  default     = 0
  validation {
    condition     = var.api_min_count >= 0
    error_message = "api_min_count is 0 or more."
  }
}

variable "api_max_count" {
  description = "Most API tasks (the spend cap of the tier)."
  type        = number
  default     = 8
  validation {
    condition     = var.api_max_count >= 1 && var.api_max_count <= 32
    error_message = "api_max_count is between 1 and 32; raise this bound in the same change that raises it."
  }
}

variable "api_cpu_target" {
  description = "Target-tracking CPU utilisation (percent) for the tier's autoscaling."
  type        = number
  default     = 60
}

variable "api_log_retention_days" {
  description = "CloudWatch Logs retention of the api tasks' output (access lines carry op, lineage, status, ms; never paths, ids or bodies)."
  type        = number
  default     = 30
}

# --- Mutual TLS (mtls.tf) ---

variable "aop_ca_version" {
  description = "The S3 VersionId of aop-ca.pem in the trust bucket (printed by infra/camelfs/aop.sh init). Null: the public listener runs without client certificates (before the AOP CA exists). Set: the public listener requires Cloudflare's zone certificate from that CA (mTLS verify mode). Changing it rotates the trust store."
  type        = string
  default     = null
  validation {
    condition     = var.aop_ca_version == null || try(length(trimspace(var.aop_ca_version)) > 0 && lower(trimspace(var.aop_ca_version)) != "null", false)
    error_message = "aop_ca_version is a versioned S3 object's VersionId, or null."
  }
}

variable "enroll_listener_port" {
  description = "The internal ALB's plain-TLS listener for host enrollment (no client certificate; serves only POST /v1/hosts/enroll). Hosts need egress to it and to hosts_port (job-hosts allows 443 only today)."
  type        = number
  default     = 8443
}

variable "hosts_port" {
  description = "The container port the tier serves host routes (/v1/hosts/*) on, terminating the hosts' mutual TLS itself (camelfsd api --listen-hosts); reached only through the hosts' internal NLB in TCP passthrough (mtls.tf)."
  type        = number
  default     = 8794
}

variable "enroll_port" {
  description = "The container port the tier serves enrollment on (camelfsd api --listen-enroll); separate from api_port so a request can never reach the mTLS-trusting port without passing the verify-mode listener."
  type        = number
  default     = 8793
}

# --- Hosts ---

variable "host_security_group_ids" {
  description = "Security groups of the VM hosts that run camelfsd --role host (infra/job-hosts' hosts group once applied, the proto host's group meanwhile). Only these reach the internal load balancer, and the tier reaches only these on host_compute_port; empty means no host is wired yet."
  type        = list(string)
  default     = []
}

variable "host_compute_port" {
  description = "The hosts' compute listener (camelfsd host --listen-compute 0.0.0.0:8792; proto-block, 2026-11-13): the tier pushes boot/stop there, in-VPC, with tokens it signs (K4). The rule is added to each host security group; the hosts' own egress rules are theirs."
  type        = number
  default     = 8792
}

# --- Bucket ---

variable "guest_image_prefix" {
  description = "Prefix in the bucket above the content-addressed guest image (K1: <prefix>guest/<sha256>.ext4.zst + .json; empty puts it at guest/ in the bucket root). The CI publisher may put under <prefix>guest/ and nowhere else; hosts read it with the host policy."
  type        = string
  default     = ""
  validation {
    condition     = var.guest_image_prefix == "" || can(regex("^[a-z0-9-]+/$", var.guest_image_prefix))
    error_message = "guest_image_prefix is empty or one lowercase path segment with a trailing slash."
  }
}

variable "github_subjects" {
  description = "OIDC subject prefixes of the repository whose GitHub Actions may publish the guest image (the runtime's infra/terraform uses the same immutable subjects: gh api repos/<owner>/<repo>/actions/oidc/customization/sub)."
  type        = list(string)
  default     = ["qaml-ai@151090534/run@1384214784"]
}

variable "github_environment" {
  description = "The GitHub Actions environment whose jobs may assume the publisher role (required reviewers on it gate the publish)."
  type        = string
  default     = "production"
}

variable "noncurrent_expiry_days" {
  description = "Overwritten and deleted objects stay recoverable this long (camel-fs.md §5 phase 1: 35, the PITR window of the tables)."
  type        = number
  default     = 35
}

variable "inventory_expiry_days" {
  description = "Daily S3 Inventory reports (inventory/ in the bucket; the GC's input, camel-fs.md §1.9) are deleted after this many days."
  type        = number
  default     = 30
}

variable "alb_access_logs_bucket" {
  description = "An existing bucket for the load balancers' access logs (the runtime's mTLS-logs bucket showed the 2026-10-24 h2 stall; nothing else did). Null: no access logs."
  type        = string
  default     = null
}

# --- Alarms ---

variable "alerts_topic_name" {
  description = "The runtime's us-west-2 alerts topic (infra/terraform/alarms.tf, aws_sns_topic.alerts_regional), which emails Miguel. Looked up by name, not managed here."
  type        = string
  default     = "camelai-agent-runtime-alerts"
}

variable "api_latency_p99_ms" {
  description = "Alarm when the public load balancer's target p99 response time exceeds this for 3 of 5 minutes (camel-fs.md §1.6 budgets 50–200 ms per write or merge from the tier's seat)."
  type        = number
  default     = 1000
}
