# Public load balancer in front of the ECS runtime tasks (ecs.tf). It
# terminates TLS with an ACM certificate.
# agents.camelai.dev is a CNAME to it (dns.tf), and so is run.camelai.com
# (dns-primary.tf), whose certificate the HTTPS listener also serves.

# --- Certificate (validated through Cloudflare) ---

resource "aws_acm_certificate" "runtime" {
  domain_name       = var.hostname
  validation_method = "DNS"
  tags              = { Name = var.name }

  lifecycle {
    create_before_destroy = true
  }
}

# Validation CNAMEs only; they sit beside the runtime record and never touch it.
resource "cloudflare_dns_record" "runtime_cert_validation" {
  for_each = {
    for option in aws_acm_certificate.runtime.domain_validation_options : option.domain_name => option
  }
  zone_id = var.cloudflare_zone_id
  name    = trimsuffix(each.value.resource_record_name, ".")
  type    = each.value.resource_record_type
  content = trimsuffix(each.value.resource_record_value, ".")
  ttl     = 60
  proxied = false
  comment = "ACM validation for ${var.hostname} (${var.name} ALB)"
}

resource "aws_acm_certificate_validation" "runtime" {
  certificate_arn         = aws_acm_certificate.runtime.arn
  validation_record_fqdns = [for record in cloudflare_dns_record.runtime_cert_validation : record.name]
}

# --- Security group ---

# Only Cloudflare reaches the load balancer. Both hostnames are proxied (dns.tf, dns-primary.tf), so
# Cloudflare's addresses are the only legitimate sources: nothing calls the ALB's own name (the deploy
# script and the Route 53 health check go through Cloudflare). This keeps Cloudflare's protections from
# being bypassed and lets the runtime trust CF-Connecting-IP for the client's address
# (AGENT_TRUST_CF_CONNECTING_IP, ecs.tf), which its per-address rate limits key on. The ALB is IPv4
# only, so only Cloudflare's IPv4 ranges matter. The list is read at each plan: a range Cloudflare adds
# shows up as a rule to add. (The group's description predates this; changing it would replace the group.)
data "cloudflare_ip_ranges" "cloudflare" {}

resource "aws_security_group" "alb" {
  name        = "${var.name}-alb"
  description = "Agent runtime load balancer: HTTPS and HTTP redirect from the internet"
  vpc_id      = data.aws_vpc.default.id
  tags        = { Name = "${var.name}-alb" }
}

resource "aws_vpc_security_group_ingress_rule" "alb_cloudflare" {
  for_each = {
    for pair in setproduct(["https", "http"], data.cloudflare_ip_ranges.cloudflare.ipv4_cidrs) :
    "${pair[0]} ${pair[1]}" => { port = pair[0] == "https" ? 443 : 80, cidr = pair[1], name = upper(pair[0]) }
  }
  security_group_id = aws_security_group.alb.id
  ip_protocol       = "tcp"
  from_port         = each.value.port
  to_port           = each.value.port
  cidr_ipv4         = each.value.cidr
  description       = "${each.value.name} from Cloudflare"
}

resource "aws_vpc_security_group_egress_rule" "alb_to_tasks" {
  security_group_id            = aws_security_group.alb.id
  referenced_security_group_id = aws_security_group.task.id
  ip_protocol                  = "tcp"
  from_port                    = local.runtime_port
  to_port                      = local.runtime_port
  description                  = "Runtime tasks"
}

# --- Load balancer ---

resource "aws_lb" "runtime" {
  name               = var.name
  load_balancer_type = "application"
  internal           = false
  subnets            = data.aws_subnets.default.ids
  security_groups    = [aws_security_group.alb.id]
  # SSE streams heartbeat every few seconds; this only closes dead connections.
  idle_timeout               = var.alb_idle_timeout
  drop_invalid_header_fields = true
  enable_deletion_protection = true
  tags                       = { Name = var.name }

  dynamic "access_logs" {
    for_each = var.alb_access_logs_bucket == null ? [] : [var.alb_access_logs_bucket]
    content {
      bucket  = access_logs.value
      prefix  = var.name
      enabled = true
    }
  }
}

resource "aws_lb_target_group" "runtime" {
  name        = var.name
  target_type = "ip"
  protocol    = "HTTP"
  port        = local.runtime_port
  vpc_id      = data.aws_vpc.default.id
  # SIGTERM (after which the task has stopTimeout, 120 s, to drain) only
  # arrives once this delay ends; open SSE streams stay up through it and
  # clients reconnect to another task. A long delay would only postpone SIGTERM.
  deregistration_delay = 15

  health_check {
    # 200 healthy, including while retiring (a superseded, protected task
    # finishing turns: scale-in protection does not stop ECS replacing a task
    # that fails ALB health checks). 503 only during the SIGTERM drain, after
    # deregistration.
    path                = "/healthz"
    matcher             = "200"
    interval            = 10
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 2
  }

  tags = { Name = var.name }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.runtime.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.runtime.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.runtime.arn
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.runtime.arn
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
