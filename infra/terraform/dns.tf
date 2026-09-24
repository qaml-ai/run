# DNS-only (unproxied): TLS terminates on the target itself (Caddy on the EC2
# host, or the ALB's ACM certificate). dns_target flips it; see README.md, Cutover.
locals {
  dns_to_alb = var.dns_target == "alb"
}

resource "cloudflare_dns_record" "runtime" {
  zone_id = var.cloudflare_zone_id
  name    = var.hostname
  type    = local.dns_to_alb ? "CNAME" : "A"
  content = local.dns_to_alb ? aws_lb.runtime.dns_name : aws_eip.runtime.public_ip
  ttl     = var.dns_ttl
  proxied = false
  comment = local.dns_to_alb ? "${var.name} ALB" : "${var.name} Elastic IP"
}
