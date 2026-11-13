output "public_url" {
  description = "The API tier for the runtime (Workers, Node): https://<hostname>, through Cloudflare."
  value       = "https://${var.hostname}"
}

output "internal_url" {
  description = "The API tier for camelfsd --role host, in-VPC: https://<internal_hostname> (private addresses)."
  value       = "https://${var.internal_hostname}"
}

output "load_balancer_dns_names" {
  description = "The two balancers' own names, by key (public, internal)."
  value       = { for key, balancer in aws_lb.api : key => balancer.dns_name }
}

output "bucket" {
  description = "The object store (SSE-KMS, versioned): camelfsd's --store is s3://<this>."
  value       = aws_s3_bucket.objects.bucket
}

output "bucket_kms_key_arn" {
  description = "The bucket's key. Anything else that writes the bucket (a presigner, the collector) needs kms:GenerateDataKey on it through S3."
  value       = aws_kms_key.objects.arn
}

output "table_names" {
  description = "The DynamoDB tables, by role (objects, refs, lineages): the daemon's CAMELFS_*_TABLE."
  value       = local.table_names
}

output "table_arns" {
  description = "The tables' ARNs, by role."
  value       = local.table_arns
}

output "api_task_role_arn" {
  description = "The api tier's task role."
  value       = aws_iam_role.api.arn
}

output "host_policy_arn" {
  description = "The host policy (bucket read/write, objects table): attach it to the job-hosts pool roles (infra/job-hosts/terraform/iam.tf, host_managed_policies) and to any other host that runs camelfsd --role host."
  value       = aws_iam_policy.host.arn
}

output "host_role_arn" {
  description = "A host role of its own (trusts ec2.amazonaws.com only) for hosts outside the job-hosts pools."
  value       = aws_iam_role.host.arn
}

output "host_instance_profile" {
  description = "The instance profile of host_role_arn."
  value       = aws_iam_instance_profile.host.name
}

output "ecr_repository_url" {
  description = "Where deploy.sh pushes camelfsd images; api_image_tag names one of them."
  value       = aws_ecr_repository.camelfsd.repository_url
}

output "cluster_name" {
  description = "The ECS cluster."
  value       = aws_ecs_cluster.camelfs.name
}

output "service_name" {
  description = "The ECS service; empty until api_image_tag is set."
  value       = try(aws_ecs_service.api[0].name, "")
}

output "token_signing_key_secret_arn" {
  description = "Secrets Manager: the ES256 private key the runtime signs tokens with (nothing in AWS reads it)."
  value       = aws_secretsmanager_secret.token_signing_key.arn
}

output "token_verify_keys_secret_arn" {
  description = "Secrets Manager: the JWK set the api tier verifies tokens with (CAMELFS_TOKEN_KEYS_SECRET_ARN)."
  value       = aws_secretsmanager_secret.token_verify_keys.arn
}

output "api_environment" {
  description = "The api task's environment as registered (names and ARNs, no secret values), for a host or a local run to mirror."
  value       = local.api_environment
}
