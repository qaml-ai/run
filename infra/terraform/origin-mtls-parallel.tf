# A separate ALB lets TLS configuration settle before it receives production traffic.
variable "origin_mtls_parallel_enabled" {
  type        = bool
  default     = false
  nullable    = false
  description = "Create an independent mTLS ALB without changing the current origin."
  validation {
    condition     = !var.origin_mtls_parallel_enabled || var.origin_mtls_ca_bucket != null
    error_message = "Stage the dedicated CA before creating the parallel mTLS origin."
  }
}
variable "origin_mtls_parallel_attach" {
  type        = bool
  default     = false
  nullable    = false
  description = "Register ECS tasks with the parallel target group. This initiates an ECS rolling deployment."
  validation {
    condition     = !var.origin_mtls_parallel_attach || var.origin_mtls_parallel_enabled
    error_message = "Create the parallel origin before attaching ECS services."
  }
}
resource "aws_s3_bucket" "origin_mtls_logs" {
  count  = var.origin_mtls_parallel_enabled ? 1 : 0
  bucket = "${var.name}-mtls-logs-${var.account_id}"
}
resource "aws_s3_bucket_public_access_block" "origin_mtls_logs" {
  count                   = var.origin_mtls_parallel_enabled ? 1 : 0
  bucket                  = aws_s3_bucket.origin_mtls_logs[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_server_side_encryption_configuration" "origin_mtls_logs" {
  count  = var.origin_mtls_parallel_enabled ? 1 : 0
  bucket = aws_s3_bucket.origin_mtls_logs[0].id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}
resource "aws_s3_bucket_lifecycle_configuration" "origin_mtls_logs" {
  count  = var.origin_mtls_parallel_enabled ? 1 : 0
  bucket = aws_s3_bucket.origin_mtls_logs[0].id
  rule {
    id     = "expire"
    status = "Enabled"
    filter {}
    expiration { days = 14 }
    abort_incomplete_multipart_upload { days_after_initiation = 7 }
  }
}
resource "aws_s3_bucket_policy" "origin_mtls_logs" {
  count  = var.origin_mtls_parallel_enabled ? 1 : 0
  bucket = aws_s3_bucket.origin_mtls_logs[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect    = "Allow"
        Principal = { Service = "logdelivery.elasticloadbalancing.amazonaws.com" }
        Action    = "s3:PutObject"
        Resource  = "${aws_s3_bucket.origin_mtls_logs[0].arn}/AWSLogs/${var.account_id}/*"
      },
      {
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource  = [aws_s3_bucket.origin_mtls_logs[0].arn, "${aws_s3_bucket.origin_mtls_logs[0].arn}/*"]
        Condition = { Bool = { "aws:SecureTransport" = "false" } }
      }
    ]
  })
  depends_on = [aws_s3_bucket_public_access_block.origin_mtls_logs]
}
resource "aws_lb" "origin_mtls_parallel" {
  count              = var.origin_mtls_parallel_enabled ? 1 : 0
  name               = "${var.name}-mtls"
  load_balancer_type = "application"
  internal           = false
  subnets            = data.aws_subnets.default.ids
  # Existing rules already restrict ingress to Cloudflare and permit access to the tasks.
  security_groups            = [aws_security_group.alb.id]
  idle_timeout               = var.alb_idle_timeout
  drop_invalid_header_fields = true
  enable_deletion_protection = true
  access_logs {
    bucket  = aws_s3_bucket.origin_mtls_logs[0].id
    enabled = true
  }
  connection_logs {
    bucket  = aws_s3_bucket.origin_mtls_logs[0].id
    enabled = true
  }
  tags       = { Name = "${var.name}-mtls" }
  depends_on = [aws_s3_bucket_policy.origin_mtls_logs]
}
resource "aws_lb_target_group" "origin_mtls_parallel" {
  count                = var.origin_mtls_parallel_enabled ? 1 : 0
  name_prefix          = "mtls-"
  target_type          = "ip"
  protocol             = "HTTP"
  port                 = local.runtime_port
  vpc_id               = data.aws_vpc.default.id
  deregistration_delay = 65
  health_check {
    path                = "/healthz"
    matcher             = "200"
    interval            = 5
    timeout             = 3
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
  tags = { Name = "${var.name}-mtls" }
  lifecycle { create_before_destroy = true }
}
resource "aws_lb_listener" "origin_mtls_parallel" {
  count             = var.origin_mtls_parallel_enabled ? 1 : 0
  load_balancer_arn = aws_lb.origin_mtls_parallel[0].arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.runtime.certificate_arn
  mutual_authentication {
    mode                             = "verify"
    trust_store_arn                  = aws_lb_trust_store.origin[0].arn
    ignore_client_certificate_expiry = false
  }
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.origin_mtls_parallel[0].arn
  }
}
output "origin_mtls_parallel" {
  value = var.origin_mtls_parallel_enabled ? {
    dns_name         = aws_lb.origin_mtls_parallel[0].dns_name
    arn              = aws_lb.origin_mtls_parallel[0].arn
    listener_arn     = aws_lb_listener.origin_mtls_parallel[0].arn
    target_group_arn = aws_lb_target_group.origin_mtls_parallel[0].arn
    attached         = var.origin_mtls_parallel_attach
  } : null
}

resource "aws_lb_listener_certificate" "origin_mtls_parallel_primary" {
  count           = var.origin_mtls_parallel_enabled ? 1 : 0
  listener_arn    = aws_lb_listener.origin_mtls_parallel[0].arn
  certificate_arn = aws_acm_certificate_validation.primary.certificate_arn
}

# A separate test hostname traverses Cloudflare without changing live application DNS.
variable "origin_mtls_canary_hostname" {
  type        = string
  default     = "origin-mtls-run.camelai.com"
  description = "Isolated Cloudflare hostname for the parallel origin's pre-cutover tests."
}
resource "aws_acm_certificate" "origin_mtls_canary" {
  count             = var.origin_mtls_parallel_enabled ? 1 : 0
  domain_name       = var.origin_mtls_canary_hostname
  validation_method = "DNS"
  lifecycle { create_before_destroy = true }
}
resource "cloudflare_dns_record" "origin_mtls_canary_validation" {
  for_each = var.origin_mtls_parallel_enabled ? toset([var.origin_mtls_canary_hostname]) : toset([])
  zone_id  = data.cloudflare_zone.primary.id
  name     = trimsuffix(one([for o in aws_acm_certificate.origin_mtls_canary[0].domain_validation_options : o.resource_record_name if o.domain_name == each.key]), ".")
  type     = "CNAME"
  content  = trimsuffix(one([for o in aws_acm_certificate.origin_mtls_canary[0].domain_validation_options : o.resource_record_value if o.domain_name == each.key]), ".")
  ttl      = 60
  proxied  = false
}
resource "aws_acm_certificate_validation" "origin_mtls_canary" {
  count                   = var.origin_mtls_parallel_enabled ? 1 : 0
  certificate_arn         = aws_acm_certificate.origin_mtls_canary[0].arn
  validation_record_fqdns = [for r in cloudflare_dns_record.origin_mtls_canary_validation : r.name]
}
resource "aws_lb_listener_certificate" "origin_mtls_canary" {
  count           = var.origin_mtls_parallel_enabled ? 1 : 0
  listener_arn    = aws_lb_listener.origin_mtls_parallel[0].arn
  certificate_arn = aws_acm_certificate_validation.origin_mtls_canary[0].certificate_arn
}
resource "cloudflare_dns_record" "origin_mtls_canary" {
  count      = var.origin_mtls_parallel_enabled ? 1 : 0
  zone_id    = data.cloudflare_zone.primary.id
  name       = var.origin_mtls_canary_hostname
  type       = "CNAME"
  content    = aws_lb.origin_mtls_parallel[0].dns_name
  ttl        = 1
  proxied    = true
  depends_on = [aws_lb_listener_certificate.origin_mtls_canary]
}

resource "aws_lb_listener" "origin_mtls_parallel_http" {
  count             = var.origin_mtls_parallel_enabled ? 1 : 0
  load_balancer_arn = aws_lb.origin_mtls_parallel[0].arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type = "redirect"
    redirect {
      protocol    = "HTTPS"
      port        = "443"
      status_code = "HTTP_301"
    }
  }
}
