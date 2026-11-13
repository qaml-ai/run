output "public_url" {
  description = "The API tier for the runtime (Workers, Node): https://<hostname>, through Cloudflare."
  value       = "https://${var.hostname}"
}

output "internal_url" {
  description = "The API tier for camelfsd --role host, in-VPC: https://<internal_hostname> (private addresses)."
  value       = "https://${var.internal_hostname}"
}

output "load_balancer_dns_names" {
  description = "The two balancers' own names, by key (public, internal): the CNAME targets of hostname (proxied) and internal_hostname (DNS only) in Cloudflare."
  value       = { for key, balancer in aws_lb.api : key => balancer.dns_name }
}

output "dns_records" {
  description = "The two CNAMEs to create in Cloudflare by hand: hostname → the public balancer (proxied), internal_hostname → the internal balancer (DNS only)."
  value = {
    (var.hostname)          = { type = "CNAME", target = aws_lb.api["public"].dns_name, proxied = true }
    (var.internal_hostname) = { type = "CNAME", target = aws_lb.api["internal"].dns_name, proxied = false }
  }
}

output "acm_validation_records" {
  description = "The certificate's DNS validation records, to create in Cloudflare by hand (DNS only) after the first apply; then apply again with certificate_issued=true."
  value = {
    for option in aws_acm_certificate.api.domain_validation_options : option.domain_name => {
      name   = trimsuffix(option.resource_record_name, ".")
      type   = option.resource_record_type
      target = trimsuffix(option.resource_record_value, ".")
    }
  }
}

output "certificate_status" {
  description = "PENDING_VALIDATION until the validation records are in DNS and ACM has seen them; ISSUED after."
  value       = aws_acm_certificate.api.status
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
  description = "The DynamoDB tables, by role (objects, refs, lineages, deliveries, hosts, vms): the daemon's --*-table flags."
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
  description = "The ECS service; empty until certificate_issued (it registers with the listeners)."
  value       = try(aws_ecs_service.api[0].name, "")
}

output "token_verify_keys_secret_arn" {
  description = "Secrets Manager: the runtime's public JWKS the api tier verifies tokens with (injected as CAMELFS_JWKS; set with jwks.sh)."
  value       = aws_secretsmanager_secret.token_verify_keys.arn
}

output "hosts_ca_arn" {
  description = "The hosts' Private CA (short-lived mode): camelfsd api --hosts-ca; hosts trust its certificate (hosts_ca_certificate_s3) on --listen-compute."
  value       = aws_acmpca_certificate_authority.hosts.arn
}

output "hosts_ca_certificate_s3" {
  description = "The hosts' CA certificate (PEM) in the trust bucket, the object the internal listener's trust store pins; hosts fetch it to verify the tier's client certificate."
  value       = "s3://${aws_s3_bucket.trust.bucket}/${aws_s3_object.hosts_ca.key}"
}

output "trust_bucket" {
  description = "Public CA certificates only: hosts-ca.pem (written by Terraform) and aop-ca.pem (written by aop.sh init; its VersionId is aop_ca_version)."
  value       = aws_s3_bucket.trust.bucket
}

output "aop_ca_secret_arn" {
  description = "Secrets Manager: the offline AOP CA (key + certificate) that aop.sh uses; nothing in AWS reads it."
  value       = aws_secretsmanager_secret.aop_ca.arn
}

output "mtls" {
  description = "Mutual TLS status: the public listener's mode (off until aop_ca_version pins the AOP CA), the internal listener's (verify from the first listener), the enrollment listener and port."
  value = {
    public_mode          = var.aop_ca_version == null ? "off" : "verify"
    internal_mode        = "verify"
    aop_ca_version       = var.aop_ca_version
    enroll_listener_port = var.enroll_listener_port
    enroll_port          = var.enroll_port
  }
}

output "api_command" {
  description = "The api task's command as registered (subcommand and flags; no secret), for a host or a local run to mirror."
  value       = local.api_command
}

output "guest_image_publisher_role_arn" {
  description = "The role GitHub Actions assumes (OIDC, the production environment) to publish the guest image; the only principal that may put under guest_image_location."
  value       = aws_iam_role.guest_image_publisher.arn
}

output "guest_image_location" {
  description = "publish-guest-image.sh's <s3-prefix> argument (it appends guest/<sha256>…), and where hosts fetch the image from."
  value       = trimsuffix("s3://${aws_s3_bucket.objects.bucket}/${var.guest_image_prefix}", "/")
}
