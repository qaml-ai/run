output "host_role_arns" {
  description = "Each pool's host role (trusts ec2.amazonaws.com only), by pool."
  value       = { for pool, role in aws_iam_role.host : pool => role.arn }
}

output "job_host_role_arns" {
  description = "JOB_HOST_ROLE_ARNS for the runtime (backends/workers/wrangler.pilot.jsonc), exactly: comma-separated pool=arn pairs. The runtime takes a host's pool from the role it attests with."
  value       = join(",", [for pool in sort(keys(aws_iam_role.host)) : "${pool}=${aws_iam_role.host[pool].arn}"])
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

output "scaler_function_name" {
  description = "The scaler Lambda; empty until a pool exists."
  value       = try(aws_lambda_function.scaler[0].function_name, "")
}

output "scaler_token_parameter" {
  description = "The SSM SecureString the scaler reads its runtime token from. Create it by hand (README, \"Scaler token\")."
  value       = local.scaler_token_parameter
}
