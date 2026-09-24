# DNS-only (unproxied): TLS terminates on the ALB with its ACM certificate.
resource "cloudflare_dns_record" "runtime" {
  zone_id = var.cloudflare_zone_id
  name    = var.hostname
  type    = "CNAME"
  content = aws_lb.runtime.dns_name
  ttl     = var.dns_ttl
  proxied = false
  comment = "${var.name} ALB"
}
