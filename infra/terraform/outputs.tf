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
  )
}

output "database" {
  description = "Control-plane Postgres; the ECS tasks get these as AGENT_DATABASE_HOST and AGENT_DATABASE_SECRET_ARN."
  value = {
    host       = aws_db_instance.control.address
    port       = aws_db_instance.control.port
    name       = aws_db_instance.control.db_name
    secret_arn = aws_db_instance.control.master_user_secret[0].secret_arn
  }
}

output "alb_dns_name" {
  description = "The ALB that agents.camelai.dev points at."
  value       = aws_lb.runtime.dns_name
}

output "ecs" {
  description = "Names infra/ecs-deploy.sh uses."
  value = {
    cluster   = aws_ecs_cluster.runtime.name
    service   = aws_ecs_service.runtime.name
    family    = aws_ecs_task_definition.runtime.family
    container = local.container_name
    log_group = aws_cloudwatch_log_group.runtime.name
  }
}

output "alerts_topic_arn_regional" {
  description = "us-west-2 alerts topic for the ALB/ECS alarms; subscribe like alerts_topic_arn (with --region us-west-2)."
  value       = aws_sns_topic.alerts_regional.arn
}
