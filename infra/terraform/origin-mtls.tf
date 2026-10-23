# Custom Authenticated Origin Pulls: stage the CA trust store before requiring
# certificates on the HTTPS listener. Client/CA private keys never enter Terraform.
variable "origin_mtls_ca_bucket" {
  description = "S3 bucket containing the public custom origin-pull CA bundle. Set bucket, key and version together to stage the trust store."
  type        = string
  default     = null

  validation {
    condition = (
      alltrue([var.origin_mtls_ca_bucket == null, var.origin_mtls_ca_key == null, var.origin_mtls_ca_version == null]) ||
      (
        alltrue([for value in [var.origin_mtls_ca_bucket, var.origin_mtls_ca_key, var.origin_mtls_ca_version] : try(length(trimspace(value)) > 0, false)]) &&
        try(lower(trimspace(var.origin_mtls_ca_version)) != "null", false)
      )
    )
    error_message = "Set origin_mtls_ca_bucket, origin_mtls_ca_key and origin_mtls_ca_version together to non-empty values, or leave all three null. Use a versioned S3 object."
  }
}

variable "origin_mtls_ca_key" {
  description = "S3 key of the public CA PEM bundle. Never upload a private key here."
  type        = string
  default     = null
}

variable "origin_mtls_ca_version" {
  description = "Pinned S3 VersionId of the public CA PEM bundle; changing it explicitly rotates ALB trust."
  type        = string
  default     = null
}

variable "origin_mtls_enforced" {
  description = "Require custom Cloudflare client certificates on every hostname served by the HTTPS listener. Enable only after Cloudflare setup and verification."
  type        = bool
  default     = false
  nullable    = false

  validation {
    condition     = !var.origin_mtls_enforced || var.origin_mtls_ca_bucket != null
    error_message = "Stage a custom origin-pull CA bundle before enabling origin_mtls_enforced."
  }
}

resource "aws_lb_trust_store" "origin" {
  count = var.origin_mtls_ca_bucket == null ? 0 : 1

  name_prefix                              = "aop-"
  ca_certificates_bundle_s3_bucket         = var.origin_mtls_ca_bucket
  ca_certificates_bundle_s3_key            = var.origin_mtls_ca_key
  ca_certificates_bundle_s3_object_version = var.origin_mtls_ca_version
  tags                                     = { Name = "${var.name}-origin-pulls" }

  lifecycle {
    create_before_destroy = true
  }
}

output "origin_mtls" {
  description = "Origin authentication rollout status; staged alone does not protect the origin."
  value = {
    enforced        = var.origin_mtls_enforced
    trust_store_arn = one(aws_lb_trust_store.origin[*].arn)
    ca_version      = var.origin_mtls_ca_version
  }
}
