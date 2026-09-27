# Proxied through Cloudflare, so browsers get its edge (HTTP/3, the same network
# path as camelAI) rather than reaching the ALB directly. TLS is re-terminated on
# the ALB with its ACM certificate. Streams stay open through Cloudflare's 100 s
# idle limit because SSE heartbeats go out every few seconds.
resource "cloudflare_dns_record" "runtime" {
  zone_id = var.cloudflare_zone_id
  name    = var.hostname
  type    = "CNAME"
  content = aws_lb.runtime.dns_name
  ttl     = 1 # automatic, which Cloudflare requires for a proxied record
  proxied = true
  comment = "${var.name} ALB"
}
