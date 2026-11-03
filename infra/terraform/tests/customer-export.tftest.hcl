# All cloud calls are mocked; these plans never read production or apply resources.
mock_provider "aws" {}
mock_provider "aws" { alias = "us_east_1" }
mock_provider "cloudflare" {
  mock_data "cloudflare_ip_ranges" { defaults = { ipv4_cidrs = ["173.245.48.0/20"] } }
}

run "no_destination_no_role" {
  command = plan
  plan_options { target = [aws_iam_role.customer_export, aws_iam_role_policy.customer_export] }
  assert {
    condition     = length(aws_iam_role.customer_export) == 0 && length(aws_iam_role_policy.customer_export) == 0 && output.customer_export_role_arn == ""
    error_message = "Without a destination there must be no export role."
  }
}

run "destination_puts_only_under_its_prefix" {
  command = plan
  plan_options { target = [aws_iam_role.customer_export, aws_iam_role_policy.customer_export] }
  variables {
    customer_export_destinations = {
      example = { bucket = "example-backups", prefix = "camelai-export/" }
    }
    customer_export_assumer_arns = ["arn:aws:iam::904534089871:user/operator"]
  }
  assert {
    condition     = aws_iam_role.customer_export[0].name == "${var.name}-customer-export"
    error_message = "The role must be named after the deployment."
  }
  assert {
    condition = jsondecode(aws_iam_role_policy.customer_export[0].policy).Statement == [{
      Sid      = "PutExports"
      Effect   = "Allow"
      Action   = ["s3:PutObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"]
      Resource = ["arn:aws:s3:::example-backups/camelai-export/*"]
    }]
    error_message = "The role may only put objects under the destination prefix, with no KMS access when no key is set."
  }
  assert {
    condition     = jsondecode(aws_iam_role.customer_export[0].assume_role_policy).Statement[0].Principal.AWS == ["arn:aws:iam::904534089871:user/operator"]
    error_message = "Only the listed operators may assume the role."
  }
}

run "kms_key_adds_key_access" {
  command = plan
  plan_options { target = [aws_iam_role_policy.customer_export] }
  variables {
    customer_export_destinations = {
      example = { bucket = "example-backups", prefix = "camelai-export/", kms_key_arn = "arn:aws:kms:us-east-1:111122223333:key/11111111-2222-3333-4444-555555555555" }
    }
    customer_export_assumer_arns = ["arn:aws:iam::904534089871:user/operator"]
  }
  assert {
    condition = jsondecode(aws_iam_role_policy.customer_export[0].policy).Statement[1] == {
      Sid      = "ExportBucketKeys"
      Effect   = "Allow"
      Action   = ["kms:GenerateDataKey", "kms:Decrypt"]
      Resource = ["arn:aws:kms:us-east-1:111122223333:key/11111111-2222-3333-4444-555555555555"]
    }
    error_message = "A destination's KMS key must be usable for the upload, and only that key."
  }
}

run "prefix_must_end_in_slash" {
  command = plan
  plan_options { target = [aws_iam_role.customer_export] }
  variables {
    customer_export_destinations = { example = { bucket = "example-backups", prefix = "camelai-export" } }
    customer_export_assumer_arns = ["arn:aws:iam::904534089871:user/operator"]
  }
  expect_failures = [var.customer_export_destinations]
}

run "destination_needs_an_assumer" {
  command = plan
  plan_options { target = [aws_iam_role.customer_export] }
  variables {
    customer_export_destinations = { example = { bucket = "example-backups", prefix = "camelai-export/" } }
  }
  expect_failures = [var.customer_export_assumer_arns]
}
