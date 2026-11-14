# Two application load balancers in front of the api tasks (ecs.tf), both HTTP/1.1 only and both terminating TLS
# with one ACM certificate:
#   public   <hostname>, proxied through Cloudflare, security group open to Cloudflare's IPv4 ranges only: what the
#            runtime (Workers, Node, later customers and the git edge) calls. Tokens (camel-fs.md §1.10) are the
#            authorization; the security group only narrows the network source to Cloudflare, as the runtime's ALB does.
#   internal <internal_hostname>, a DNS-only record to the internal balancer (its name resolves to private
#            addresses), security group open to the hosts' groups only, on the ENROLLMENT port alone (mtls.tf):
#            where a new host presents its STS attestation for its first certificate. Every other host → tier call
#            goes through the hosts' NLB in TCP passthrough (mtls.tf), where the tier terminates mutual TLS itself.
# The public ALB has the api target group; the internal ALB has only the enrollment one (mtls.tf).
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

# --- Certificate: one, for both names, DNS-validated; the records go into Cloudflare by hand ---

# The first apply (certificate_issued = false) requests it and outputs acm_validation_records; the second, once
# the CNAMEs are in Cloudflare, waits for issuance and creates the listeners. Terraform never touches DNS here.
resource "aws_acm_certificate" "api" {
  domain_name               = var.hostname
  subject_alternative_names = [var.internal_hostname]
  validation_method         = "DNS"
  tags                      = { Name = "${var.name}-${var.env}" }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_acm_certificate_validation" "api" {
  count = var.certificate_issued ? 1 : 0

  certificate_arn = aws_acm_certificate.api.arn
  # No validation_record_fqdns: the records are not Terraform's; ACM is polled until it reports ISSUED.
}

# --- Security groups ---

# Cloudflare's IPv4 ranges, read at each plan over plain HTTPS (no Cloudflare credentials): a range Cloudflare adds
# shows up as a rule to add. The balancer is IPv4 only, so only those matter.
data "http" "cloudflare_ipv4" {
  url = "https://www.cloudflare.com/ips-v4"

  lifecycle {
    postcondition {
      condition     = self.status_code == 200 && length(regexall("\\d+\\.\\d+\\.\\d+\\.\\d+/\\d+", self.response_body)) >= 10
      error_message = "https://www.cloudflare.com/ips-v4 did not return Cloudflare's IPv4 ranges."
    }
  }
}

locals {
  cloudflare_ipv4_cidrs = [for line in split("\n", data.http.cloudflare_ipv4.response_body) : trimspace(line) if trimspace(line) != ""]
}

resource "aws_security_group" "alb_public" {
  name        = "${var.name}-${var.env}-alb-public"
  description = "camelFS public load balancer: HTTPS from Cloudflare only"
  vpc_id      = data.aws_vpc.default.id
  tags        = { Name = "${var.name}-${var.env}-alb-public" }
}

resource "aws_vpc_security_group_ingress_rule" "alb_public_cloudflare" {
  for_each          = toset(local.cloudflare_ipv4_cidrs)
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
  # (The description predates the enrollment-only role; changing it would replace the group.)
  vpc_id = data.aws_vpc.default.id
  tags   = { Name = "${var.name}-${var.env}-alb-internal" }
}

# The internal balancer admits the hosts on the enrollment port only (mtls.tf, alb_internal_hosts_enroll) and
# reaches the tasks on the enrollment port only (alb_internal_to_enroll): no host path to the api port exists here.

# The tier pushes boot/stop to the hosts' compute listener (K4): one rule on each host security group from the api
# tasks' group, and the matching egress on the api group (ecs.tf). The hosts' groups are the pools' (job-hosts) or
# the proto host's; the rules are this module's, so a plan only ever adds them.
resource "aws_vpc_security_group_ingress_rule" "hosts_compute_from_api" {
  for_each                     = toset(var.host_security_group_ids)
  security_group_id            = each.value
  referenced_security_group_id = aws_security_group.api.id
  ip_protocol                  = "tcp"
  from_port                    = var.host_compute_port
  to_port                      = var.host_compute_port
  description                  = "camelFS api tier: boot/stop on the compute listener"
}

# --- Load balancers, target groups, listeners ---

locals {
  balancers = {
    public   = { internal = false, security_group = aws_security_group.alb_public.id, hostname = var.hostname }
    internal = { internal = true, security_group = aws_security_group.alb_internal.id, hostname = var.internal_hostname }
  }
  # The api target group and its 443 listener exist on the public balancer only: host routes left the internal ALB
  # for the NLB (mtls.tf), and the internal ALB keeps the enrollment listener alone.
  api_balancers = { public = local.balancers.public }
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
  for_each = local.api_balancers

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
  for_each = var.certificate_issued ? local.api_balancers : {}

  load_balancer_arn = aws_lb.api[each.key].arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.api[0].certificate_arn

  # §9.12 (mtls.tf): Cloudflare's per-hostname certificate from our AOP CA, once aop_ca_version pins it; off
  # before (the Cloudflare-ranges group alone, as the runtime's ALB ran until its own AOP). Verify, never
  # passthrough: the ALB checks the chain and the expiry itself. Hosts never reach this listener (mtls.tf).
  mutual_authentication {
    mode                             = var.aop_ca_version == null ? "off" : "verify"
    trust_store_arn                  = one(aws_lb_trust_store.aop[*].arn)
    ignore_client_certificate_expiry = var.aop_ca_version != null ? false : null
  }

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api[each.key].arn
  }
}

# No port 80: nothing but machines call this service, and every client speaks HTTPS.

# --- DNS (by hand, in Cloudflare; outputs.tf prints the records) ---
#
#   <hostname>           CNAME <public balancer's dns_name>    proxied: the runtime's Workers reach the balancer
#                        through Cloudflare's edge, from the ranges the public security group admits; TLS is
#                        re-terminated on the ALB with its ACM certificate.
#   <internal_hostname>  CNAME <internal balancer's dns_name>  DNS only: the name resolves to private addresses,
#                        reachable from the VPC alone; proxying it would be meaningless and would break the
#                        certificate's name match for hosts.
