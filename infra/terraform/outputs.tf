output "instance_id" {
  value = aws_instance.runtime.id
}

output "public_ip" {
  value = aws_eip.runtime.public_ip
}

output "private_ip" {
  value = aws_instance.runtime.private_ip
}

output "ecr_repository_url" {
  value = aws_ecr_repository.runtime.repository_url
}

output "alerts_topic_arn" {
  description = "Subscribe: aws sns subscribe --region us-east-1 --topic-arn <this> --protocol email --notification-endpoint <email>"
  value       = aws_sns_topic.alerts.arn
}

output "state_bucket" {
  description = "AGENT_S3_BUCKET / AGENT_S3_PREFIX for the runtime."
  value       = { bucket = aws_s3_bucket.state.id, prefix = var.state_prefix }
}

# Secret ARNs are not secret values, but they name every tenant; keep them out
# of casual plan/apply output anyway.
output "secret_arns" {
  sensitive = true
  value = merge(
    { for key, secret in aws_secretsmanager_secret.runtime : key => secret.arn },
    { for tenant, secret in aws_secretsmanager_secret.operator_token : "operator-token/${tenant}" => secret.arn },
    local.executor_enabled ? { executor-token = aws_secretsmanager_secret.executor_token[0].arn } : {},
  )
}

output "executor" {
  description = "Executor tier ids, or null while executor_count = 0."
  value = local.executor_enabled ? {
    security_group           = aws_security_group.executor[0].id
    bootstrap_security_group = aws_security_group.executor_bootstrap[0].id
    launch_template          = aws_launch_template.executor[0].name
    count                    = var.executor_count
  } : null
}
