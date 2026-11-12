# What a host needs to find and enroll with the runtime. The launch templates' user data reads these at boot into
# /etc/camelrun/job-host.env, so changing the runtime URL needs no new launch template (hosts pick it up when they
# are replaced). Plain strings: nothing secret is stored for hosts; they enroll with their instance identity.

locals {
  runtime_url         = trimsuffix(var.runtime_public_url, "/")
  enrollment_audience = "camelrun-job-host:${local.runtime_url}"
}

resource "aws_ssm_parameter" "runtime_url" {
  name        = "${local.ssm_parameter_prefix}/runtime-url"
  description = "The runtime's AGENT_PUBLIC_URL; job hosts connect to it."
  type        = "String"
  value       = local.runtime_url
}

resource "aws_ssm_parameter" "enrollment_audience" {
  name        = "${local.ssm_parameter_prefix}/enrollment-audience"
  description = "The audience job hosts sign into their sts:GetCallerIdentity attestation (backends/workers/src/jobs/hosts.ts, jobHostAudience)."
  type        = "String"
  value       = local.enrollment_audience
}
