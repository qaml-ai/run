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

  # Same state bucket as infra/terraform and infra/job-hosts, its own key: camelFS plans never mix with the
  # runtime's or the pools'. OpenTofu locks it with a lock object next to the state (no DynamoDB).
  backend "s3" {
    bucket       = "camelai-terraform-state-904534089871"
    key          = "agent-runtime/camelfs/terraform.tfstate"
    region       = "us-west-2"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region              = var.region
  allowed_account_ids = [var.account_id]

  default_tags {
    tags = {
      Project   = "camelfs"
      Env       = var.env
      ManagedBy = "infra/camelfs/terraform"
    }
  }
}

# Reads CLOUDFLARE_API_TOKEN from the environment (DNS edit on camelai.dev): the certificate's validation records,
# the two hostnames, and Cloudflare's address ranges for the public load balancer's security group.
provider "cloudflare" {}
