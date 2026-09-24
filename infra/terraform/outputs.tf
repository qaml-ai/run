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
  description = "Executor tier ids, or null while executor_enabled = false."
  value = local.executor_enabled ? {
    security_group    = aws_security_group.executor[0].id
    subnets           = local.executor_subnet_ids
    launch_template   = aws_launch_template.executor[0].name
    autoscaling_group = aws_autoscaling_group.executor[0].name
    url               = local.executor_url
    log_group         = aws_cloudwatch_log_group.executor[0].name
  } : null
}

output "database" {
  description = "Control-plane Postgres: set AGENT_DATABASE_HOST and AGENT_DATABASE_SECRET_ARN in instance/runtime.defaults.env from these."
  value = {
    host       = aws_db_instance.control.address
    port       = aws_db_instance.control.port
    name       = aws_db_instance.control.db_name
    secret_arn = aws_db_instance.control.master_user_secret[0].secret_arn
  }
}

output "alb_dns_name" {
  description = "Verify before the DNS flip: curl --connect-to <hostname>:443:<this>:443 https://<hostname>/healthz"
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
