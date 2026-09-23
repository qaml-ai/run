# DNS-only (unproxied) A record: Caddy on the host terminates TLS itself.
resource "cloudflare_dns_record" "runtime" {
  zone_id = var.cloudflare_zone_id
  name    = var.hostname
  type    = "A"
  content = aws_eip.runtime.public_ip
  ttl     = 300
  proxied = false
  comment = "${var.name} Elastic IP"
}
