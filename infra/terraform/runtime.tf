# Shared lookups and the container registry the ECS service pulls from.

locals {
  secret_arn_prefix = "arn:aws:secretsmanager:${var.region}:${var.account_id}:secret:${var.secret_prefix}"
}

data "aws_vpc" "default" {
  default = true
}

# --- Container registry ---

resource "aws_ecr_repository" "runtime" {
  name                 = var.name
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }
}

resource "aws_ecr_lifecycle_policy" "runtime" {
  repository = aws_ecr_repository.runtime.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the last 30 images"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 30 }
      action       = { type = "expire" }
    }]
  })
}
