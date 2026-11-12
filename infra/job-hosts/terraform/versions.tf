terraform {
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.7"
    }
  }

  # Same state bucket as infra/terraform, its own key: job-host plans never mix with the runtime's.
  # OpenTofu locks it with a lock object next to the state (no DynamoDB).
  backend "s3" {
    bucket       = "camelai-terraform-state-904534089871"
    key          = "agent-runtime/job-hosts/terraform.tfstate"
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
      Project   = "camelrun-job-hosts"
      Env       = var.env
      ManagedBy = "infra/job-hosts/terraform"
    }
  }
}
