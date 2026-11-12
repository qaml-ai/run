output "host_role_arn" {
  description = "JOB_HOST_ROLE_ARNS for the runtime (backends/workers/wrangler.pilot.jsonc). Trusts ec2.amazonaws.com only."
  value       = aws_iam_role.host.arn
}

output "build_asg_name" {
  description = "The build pool's Auto Scaling group; empty until build_ami_id is set."
  value       = try(aws_autoscaling_group.build[0].name, "")
}

output "test_asg_name" {
  description = "The test pool's Auto Scaling group; empty until test_ami_id is set."
  value       = try(aws_autoscaling_group.test[0].name, "")
}

output "images_bucket" {
  description = "Base images, snapshots and outputs (SSE-KMS)."
  value       = aws_s3_bucket.images.bucket
}

output "images_kms_key_arn" {
  description = "The images bucket's key; whoever presigns uploads into the bucket (the runtime, slice 5) needs kms:GenerateDataKey on it."
  value       = aws_kms_key.images.arn
}

output "enrollment_audience" {
  description = "camelrun-job-host:<AGENT_PUBLIC_URL>; must match the runtime's jobHostAudience."
  value       = local.enrollment_audience
}
