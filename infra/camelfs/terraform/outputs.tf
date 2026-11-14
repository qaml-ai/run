output "public_url" {
  description = "The API tier for the runtime (Workers, Node): https://<hostname>, through Cloudflare."
  value       = "https://${var.hostname}"
}

output "enroll_endpoint" {
  description = "Where camelfsd --role host enrolls (TIER_ENROLL_URL): the hosts NLB in TCP passthrough to the tier's --listen-enroll port; the tier serves its Private-CA certificate, which the host verifies against the pinned tier_ca (SAN spiffe://camelfs/tier)."
  value       = "https://${aws_lb.hosts.dns_name}:${var.enroll_listener_port}"
}

output "hosts_endpoint" {
  description = "Where camelfsd --role host dials the tier for every call after enrollment (TIER_HOSTS_ENDPOINT): the hosts NLB, TCP passthrough; the tier terminates mutual TLS and the host verifies spiffe://camelfs/tier against the pinned tier_ca."
  value       = "${aws_lb.hosts.dns_name}:${var.hosts_port}"
}

output "tier_ca_s3" {
  description = "The hosts' CA certificate (PEM) in the trust bucket, which host-setup installs as --tier-ca (TIER_CA_S3); the host policy may read exactly this object."
  value       = "s3://${aws_s3_bucket.trust.bucket}/${aws_s3_object.hosts_ca.key}"
}

output "tier_ca_sha256" {
  description = "sha256 of that PEM as stored, for TIER_CA_SHA256 in kvm-host.conf: host-setup refuses a CA whose hash differs."
  value       = sha256(aws_acmpca_certificate.hosts_root.certificate)
}

output "load_balancer_dns_names" {
  description = "The balancers' own names: public (the CNAME target of hostname in Cloudflare, proxied) and hosts (the NLB hosts dial directly; no DNS record)."
  value       = merge({ for key, balancer in aws_lb.api : key => balancer.dns_name }, { hosts = aws_lb.hosts.dns_name })
}

output "dns_records" {
  description = "The one CNAME to keep in Cloudflare by hand: hostname → the public balancer (proxied). internal_hostname's record points at nothing now (the internal ALB is gone) and can be removed."
  value = {
    (var.hostname) = { type = "CNAME", target = aws_lb.api["public"].dns_name, proxied = true }
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
  description = "The hosts' Private CA (short-lived mode): camelfsd api --hosts-ca. Hosts pin its certificate at install (tier_ca_s3 / tier_ca_sha256) and trust nothing else for the tier."
  value       = aws_acmpca_certificate_authority.hosts.arn
}

output "trust_bucket" {
  description = "Public CA certificates only: aop-ca.pem (written by aop.sh init; its VersionId is aop_ca_version)."
  value       = aws_s3_bucket.trust.bucket
}

output "notify_key_secret_arn" {
  description = "Secrets Manager: the notify webhook's HMAC key (§9.11), injected as CAMELFS_NOTIFY_KEY; set with notify-key.sh, which also prints the runtime's wrangler command."
  value       = aws_secretsmanager_secret.notify_key.arn
}

output "aop_ca_secret_arn" {
  description = "Secrets Manager: the offline AOP CA (key + certificate) that aop.sh uses; nothing in AWS reads it."
  value       = aws_secretsmanager_secret.aop_ca.arn
}

output "mtls" {
  description = "Mutual TLS status: the public listener's mode (off until aop_ca_version pins the AOP CA); enrollment and host routes behind the NLB where the tier terminates TLS itself with its Private-CA certificate."
  value = {
    public_mode          = var.aop_ca_version == null ? "off" : "verify"
    enroll_endpoint      = "https://${aws_lb.hosts.dns_name}:${var.enroll_listener_port}"
    hosts_endpoint       = "${aws_lb.hosts.dns_name}:${var.hosts_port}"
    aop_ca_version       = var.aop_ca_version
    enroll_listener_port = var.enroll_listener_port
    enroll_port          = var.enroll_port
    hosts_port           = var.hosts_port
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
