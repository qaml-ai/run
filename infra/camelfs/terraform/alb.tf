# Two load balancers in front of the api tasks (ecs.tf), both HTTP/1.1 only and both terminating TLS with one ACM
# certificate:
#   public   <hostname>, proxied through Cloudflare, security group open to Cloudflare's IPv4 ranges only: what the
#            runtime (Workers, Node, later customers and the git edge) calls. Tokens (camel-fs.md §1.10) are the
#            authorization; the security group only narrows the network source to Cloudflare, as the runtime's ALB does.
#   internal <internal_hostname>, a DNS-only record to the internal balancer (its name resolves to private
#            addresses), security group open to the hosts' groups only: what camelfsd --role host calls for cas,
#            renew and reads, in-VPC (the "vpc 2 ms" leg of the C view). Hosts never go out through Cloudflare to
#            reach a service in their own VPC, and the public balancer never sees a host.
# A target group belongs to one load balancer, so there are two; the ECS service registers with both.
#
# enable_http2 = false on both: 2026-10-24, Cloudflare multiplexed requests on one h2 connection to the runtime's
# ALB and a cancelled response left unread stalled every stream on it (25–183 s chat loads; qaml-ai/run#415).

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
  filter {
    name   = "default-for-az"
    values = ["true"]
  }
}

# --- Certificate: one, for both names, validated through Cloudflare ---

resource "aws_acm_certificate" "api" {
  domain_name               = var.hostname
  subject_alternative_names = [var.internal_hostname]
  validation_method         = "DNS"
  tags                      = { Name = "${var.name}-${var.env}" }

  lifecycle {
    create_before_destroy = true
  }
}

resource "cloudflare_dns_record" "api_cert_validation" {
  for_each = {
    for option in aws_acm_certificate.api.domain_validation_options : option.domain_name => option
  }
  zone_id = var.cloudflare_zone_id
  name    = trimsuffix(each.value.resource_record_name, ".")
  type    = each.value.resource_record_type
  content = trimsuffix(each.value.resource_record_value, ".")
  ttl     = 60
  proxied = false
  comment = "ACM validation for ${each.key} (${var.name}-${var.env} ALB)"
}

resource "aws_acm_certificate_validation" "api" {
  certificate_arn         = aws_acm_certificate.api.arn
  validation_record_fqdns = [for record in cloudflare_dns_record.api_cert_validation : record.name]
}

# --- Security groups ---

# Cloudflare's IPv4 ranges, read at each plan: a range Cloudflare adds shows up as a rule to add. The balancer is
# IPv4 only, so only those matter.
data "cloudflare_ip_ranges" "cloudflare" {}

resource "aws_security_group" "alb_public" {
  name        = "${var.name}-${var.env}-alb-public"
  description = "camelFS public load balancer: HTTPS from Cloudflare only"
  vpc_id      = data.aws_vpc.default.id
  tags        = { Name = "${var.name}-${var.env}-alb-public" }
}

resource "aws_vpc_security_group_ingress_rule" "alb_public_cloudflare" {
  for_each          = toset(data.cloudflare_ip_ranges.cloudflare.ipv4_cidrs)
  security_group_id = aws_security_group.alb_public.id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = each.value
  description       = "HTTPS from Cloudflare"
}

resource "aws_vpc_security_group_egress_rule" "alb_public_to_api" {
  security_group_id            = aws_security_group.alb_public.id
  referenced_security_group_id = aws_security_group.api.id
  ip_protocol                  = "tcp"
  from_port                    = var.api_port
  to_port                      = var.api_port
  description                  = "API tasks"
}

resource "aws_security_group" "alb_internal" {
  name        = "${var.name}-${var.env}-alb-internal"
  description = "camelFS internal load balancer: HTTPS from the VM hosts only"
  vpc_id      = data.aws_vpc.default.id
  tags        = { Name = "${var.name}-${var.env}-alb-internal" }
}

resource "aws_vpc_security_group_ingress_rule" "alb_internal_hosts" {
  for_each                     = toset(var.host_security_group_ids)
  security_group_id            = aws_security_group.alb_internal.id
  referenced_security_group_id = each.value
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  description                  = "HTTPS from camelfsd --role host"
}

resource "aws_vpc_security_group_egress_rule" "alb_internal_to_api" {
  security_group_id            = aws_security_group.alb_internal.id
  referenced_security_group_id = aws_security_group.api.id
  ip_protocol                  = "tcp"
  from_port                    = var.api_port
  to_port                      = var.api_port
  description                  = "API tasks"
}

# --- Load balancers, target groups, listeners ---

locals {
  balancers = {
    public   = { internal = false, security_group = aws_security_group.alb_public.id, hostname = var.hostname }
    internal = { internal = true, security_group = aws_security_group.alb_internal.id, hostname = var.internal_hostname }
  }
}

resource "aws_lb" "api" {
  for_each = local.balancers

  name               = "${var.name}-${var.env}-${each.key}"
  load_balancer_type = "application"
  internal           = each.value.internal
  subnets            = data.aws_subnets.default.ids
  security_groups    = [each.value.security_group]
  # Every API call answers in well under a minute (§1.6 budgets 20–300 ms); this only closes dead connections.
  idle_timeout = 60
  # HTTP/1.1 only: see the header.
  enable_http2               = false
  drop_invalid_header_fields = true
  enable_deletion_protection = true
  tags                       = { Name = "${var.name}-${var.env}-${each.key}" }

  dynamic "access_logs" {
    for_each = var.alb_access_logs_bucket == null ? [] : [var.alb_access_logs_bucket]
    content {
      bucket  = access_logs.value
      prefix  = "${var.name}-${var.env}-${each.key}"
      enabled = true
    }
  }

  lifecycle {
    postcondition {
      condition     = self.enable_http2 == false
      error_message = "HTTP/2 must stay off on the camelFS load balancers (the 2026-10-24 Cloudflare → ALB head-of-line stall)."
    }
  }
}

resource "aws_lb_target_group" "api" {
  for_each = local.balancers

  name        = "${var.name}-${var.env}-${each.key}"
  target_type = "ip"
  protocol    = "HTTP"
  port        = var.api_port
  vpc_id      = data.aws_vpc.default.id
  # Past the longest request (a merge or a large commit: seconds, not minutes); in-flight requests finish, then
  # ECS sends SIGTERM and the task has stopTimeout to drain.
  deregistration_delay = 30

  health_check {
    # A new task serves after two passes 5 s apart; a task is taken out after three failures (15 s), so one slow
    # answer under load does not do it.
    path                = var.api_health_path
    matcher             = "200"
    interval            = 5
    timeout             = 4
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  tags = { Name = "${var.name}-${var.env}-${each.key}" }
}

resource "aws_lb_listener" "api_https" {
  for_each = local.balancers

  load_balancer_arn = aws_lb.api[each.key].arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.api.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api[each.key].arn
  }
}

# No port 80: nothing but machines call this service, and every client speaks HTTPS.

# --- DNS ---

# Proxied: the runtime's Workers reach the public balancer through Cloudflare's edge, from the ranges the public
# security group admits; TLS is re-terminated on the ALB with its ACM certificate.
resource "cloudflare_dns_record" "api_public" {
  zone_id = var.cloudflare_zone_id
  name    = var.hostname
  type    = "CNAME"
  content = aws_lb.api["public"].dns_name
  ttl     = 1 # automatic, which Cloudflare requires for a proxied record
  proxied = true
  comment = "${var.name}-${var.env} public ALB"
}

# DNS only: the internal balancer's name resolves to private addresses, reachable from the VPC alone; proxying it
# would be meaningless and would break the certificate's name match for hosts.
resource "cloudflare_dns_record" "api_internal" {
  zone_id = var.cloudflare_zone_id
  name    = var.internal_hostname
  type    = "CNAME"
  content = aws_lb.api["internal"].dns_name
  ttl     = 60
  proxied = false
  comment = "${var.name}-${var.env} internal ALB (private addresses; hosts only)"
}
