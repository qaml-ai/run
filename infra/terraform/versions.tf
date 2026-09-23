terraform {
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }

  # Shared state; OpenTofu locks it with a lock object next to the state (no DynamoDB).
  # The bucket was created once by hand; see README.md, "Remote state".
  backend "s3" {
    bucket       = "camelai-terraform-state-904534089871"
    key          = "agent-runtime/terraform.tfstate"
    region       = "us-west-2"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region              = var.region
  allowed_account_ids = [var.account_id]
}

# Route 53 health checks publish their metrics in us-east-1, so the healthz
# alarm and its SNS topic live there.
provider "aws" {
  alias               = "us_east_1"
  region              = "us-east-1"
  allowed_account_ids = [var.account_id]
}

# Reads CLOUDFLARE_API_TOKEN from the environment.
provider "cloudflare" {}
