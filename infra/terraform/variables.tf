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
  description = "The runtime's first hostname, in the cloudflare_zone_id zone. Served for good: the issuer its identity and OAuth tokens name (AGENT_ISSUER), and the email channels' SNS endpoint."
  type        = string
  default     = "agents.camelai.dev"
}

variable "primary_hostname" {
  description = "The runtime's primary hostname, in primary_zone, on its own certificate on the same ALB."
  type        = string
  default     = "run.camelai.com"
}

variable "primary_zone" {
  description = "The Cloudflare zone primary_hostname is in (looked up by name)."
  type        = string
  default     = "camelai.com"
}

variable "public_hostname" {
  description = "Which of hostname and primary_hostname is AGENT_PUBLIC_URL, where people are sent (console, links, emails, OAuth pages). The other is served as an alias (AGENT_PUBLIC_ALIASES)."
  type        = string
  default     = "run.camelai.com"
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
  default     = "db.t4g.large"
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

# 4 GiB: a Pi session's first load imports its legacy history in-process (one task peaked at 2.4 GiB on 2026-10-21).
variable "task_memory" {
  type    = number
  default = 4096
}

variable "agent_pi_sweep" {
  description = "AGENT_PI_SWEEP: the most the Pi migration sweep may do: off, dry-run (log what migrating each legacy agent would do) or on (open idle legacy agents so they migrate to Pi). The operator's mode (infra/pi-sweep.sh) chooses within it, and starts in dry-run"
  type        = string
  default     = "off"
  validation {
    condition     = contains(["off", "dry-run", "on"], var.agent_pi_sweep)
    error_message = "agent_pi_sweep is off, dry-run or on."
  }
}

variable "agent_engine" {
  description = "AGENT_ENGINE, kept at pi-durable for images before the legacy engine's removal (which default to legacy without it; a deploy rollback may run one). The current image ignores it. Remove once no image that reads it can be deployed."
  type        = string
  default     = "pi-durable"
  validation {
    condition     = var.agent_engine == "pi-durable"
    error_message = "agent_engine is pi-durable: the legacy engine was removed, and an older image rolled back to it would take sessions off Pi."
  }
}

variable "service_min_count" {
  description = "Minimum (and initial) number of runtime tasks. Three, one per AZ (ECS spreads and rebalances them), so losing a task or an AZ leaves two; CPU and memory autoscaling add tasks up to service_max_count under load."
  type        = number
  default     = 3
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
    AGENT_VOICE                 = "true"
    # Smart end of turn (Silero VAD + Smart Turn, run#240/#254) for every voice session; ~190 MB and one Smart Turn thread per node.
    AGENT_VOICE_TURN_MODELS = "true"
    # Voice sessions' realtime brain (run#265; a session may instead only listen): OpenAI Realtime first (the default); Gemini Live, Grok (xAI, run#288) and
    # ElevenLabs Agents (run#289, any library voice) too; each on the platform key unless the tenant brings one.
    AGENT_VOICE_REALTIME = "openai,gemini,grok,elevenlabs"
    # ElevenLabs Agents list prices (elevenlabs.io/pricing/agents: per call minute; the built-in LLM is passed through, estimated per minute).
    AGENT_PRICE_ELEVENLABS_AGENTS_MINUTE_USD = "0.08"
    AGENT_PRICE_ELEVENLABS_LLM_MINUTE_USD    = "0.001"
    GITHUB_ORG                               = "qaml-ai"
    # Anyone with a GitHub account may sign in to the console. Their tenant is prepaid: platform keys only
    # against its credit, with the free limits (the Free usage tier, AGENT_FREE_HOURLY_SPEND_USD) until it buys some.
    AGENT_OPEN_SIGNUP = "true"
    AGENT_HOSTING     = "inline"
    # Operator tenants that may post manual credit adjustments (POST /v1/billing/adjustments).
    AGENT_BILLING_ADMINS = "miguel"
  }
}


variable "openai_apps_challenge" {
  description = "The domain-verification token the OpenAI Plugins dashboard shows for the ChatGPT plugin, served at https://<hostname>/.well-known/openai-apps-challenge. Not a secret. Empty serves nothing."
  type        = string
  default     = ""
}

variable "github_subjects" {
  description = "OIDC subject prefixes of the repository whose production environment may deploy. The repository uses immutable subjects: gh api repos/<owner>/<repo>/actions/oidc/customization/sub shows sub_claim_prefix. The prefix carries the repository's name, so a rename changes it: list both names until a deploy from the new one has succeeded."
  type        = list(string)
  default     = ["qaml-ai@151090534/run@1384214784"]
}

variable "email_domain" {
  description = "Domain whose mail SES receives for email channels (e.g. in.agents.camelai.dev), in the Cloudflare zone. Empty disables email channels and everything in email.tf."
  type        = string
  default     = ""
}

variable "journey_url" {
  description = "The origin of the operator's own analytics store, which journey events are sent to and the admin site asks for reports (journey.tf, src/journey.ts). Nothing is sent until infra/journey.sh has stored the signing secrets. Empty for none."
  type        = string
  default     = "https://camelai.com"
}

variable "journey_cookie_domain" {
  description = "The domain the operator's website sets its visitor cookie on, which the console's hostname must be under."
  type        = string
  default     = "camelai.com"
}

variable "journey_collect_unknown" {
  description = "Record browsers that have given no answer about being measured (there is no consent banner). False records only those that agreed. A refusal, or Global Privacy Control, is never recorded."
  type        = bool
  default     = true
}

variable "journey_internal_email_domains" {
  description = "Email domains whose Google and password sign-ins are the operator's own staff: their accounts are marked internal and left out of reports, and the ops dashboard (admin.tf) leaves them out of its counts."
  type        = list(string)
  default     = ["camelai.com", "camelqa.com"]
}

variable "discord_managed_enabled" {
  description = "Serve the managed Camel Discord bot (src/discord-managed.ts) with the application in the discord-managed secret. Fill the secret first; an empty secret leaves it off. See docs/operations/managed-discord.md."
  type        = bool
  default     = false
}

variable "storage_gc_enabled" {
  description = "Collect chunks nothing refers to, and deleted volumes' objects (src/storage-gc.ts, AGENT_GC_ENABLED). Run scripts/backfill-pins.ts once before a runtime with agents from before migration 026 enables it (docs/operations/persistence.md)."
  type        = bool
  default     = false
}

variable "storage_gc_dry_run" {
  description = "With storage_gc_enabled, only log what collection would delete (storage_gc_dry_run lines, AGENT_GC_DRY_RUN) and delete nothing. Turn off once the logs have been checked."
  type        = bool
  default     = true
}

variable "admin_hostname" {
  description = "The hostname of the team's ops dashboard (admin.tf, src/admin-site.ts), behind Cloudflare Access: one of the runtime's own (hostname, primary_hostname), with admin_path, or a name of its own in the cloudflare_zone_id zone, which gets a certificate and DNS record. Empty for none."
  type        = string
  default     = "run.camelai.com"
}

variable "admin_path" {
  description = "The path of admin_hostname the ops dashboard is served under (the path of AGENT_ADMIN_URL): /ops or /admin, names the runtime never routes. Empty: the whole of admin_hostname, which must then not be one of the runtime's own."
  type        = string
  default     = "/ops"

  # As src/admin-site.ts checks at startup (ADMIN_PATHS).
  validation {
    condition     = contains(["", "/ops", "/admin"], var.admin_path)
    error_message = "admin_path must be empty, /ops or /admin."
  }
}

variable "admin_access_team" {
  description = "The Cloudflare Access team's origin: the issuer of the tokens the admin site checks."
  type        = string
  default     = "https://qaml.cloudflareaccess.com"
}

variable "admin_emails" {
  description = "The ops dashboard's admins (AGENT_ADMIN_EMAILS): the runtime refuses anyone else Cloudflare Access signs in, a second lock beside the Access application's policy, which should list the same addresses. Set in the deployment's tfvars, not in this repository. Empty: whoever the policy admits."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for email in var.admin_emails : can(regex("^[^\\s@,]+@[a-z0-9.-]+\\.[a-z]{2,}$", lower(email)))])
    error_message = "admin_emails must be email addresses."
  }
}

variable "admin_access_aud" {
  description = "The AUD tag of the ops dashboard's Access application (\"camelRun admin\" in Zero Trust → Access → Applications), whose destinations must include admin_hostname with admin_path."
  type        = string
  default     = "041fd04d6d1fb5bc79df2e24d35bde86085109e322819cdc0964501ba5bd3478"
}
