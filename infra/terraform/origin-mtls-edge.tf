# The original DNS records remain the fallback when these load balancers are disabled.
variable "origin_mtls_edge_prepared" {
  type        = bool
  default     = false
  nullable    = false
  description = "Stage Cloudflare pools and disabled load balancers. Requires the Load Balancing subscription."
  validation {
    condition     = !var.origin_mtls_edge_prepared || var.origin_mtls_parallel_attach
    error_message = "Attach ECS to the parallel origin before preparing edge traffic steering."
  }
}
variable "origin_mtls_edge_enabled" {
  type        = bool
  default     = false
  nullable    = false
  description = "Use Cloudflare load balancing for the application hostnames. Start with zero weight on the new origin."
  validation {
    condition     = !var.origin_mtls_edge_enabled || var.origin_mtls_edge_prepared
    error_message = "Prepare and inspect Cloudflare pools before activating load balancers."
  }
}
variable "origin_mtls_edge_weight" {
  type        = number
  default     = 0
  description = "Fraction of new requests routed to the parallel origin, from zero to one."
  validation {
    condition     = var.origin_mtls_edge_weight >= 0 && var.origin_mtls_edge_weight <= 1
    error_message = "Origin weight must be between zero and one."
  }
}
variable "origin_mtls_original_fallback" {
  type        = bool
  default     = true
  nullable    = false
  description = "Keep the original pool as fallback. Disable only at 100% green before hardening the old listener."
  validation {
    condition     = var.origin_mtls_original_fallback || var.origin_mtls_edge_weight == 1
    error_message = "The original fallback can be removed only after moving all traffic to the new origin."
  }
}
locals {
  origin_mtls_edge_hosts = { (var.hostname) = var.cloudflare_zone_id, (var.primary_hostname) = data.cloudflare_zone.primary.id }
  origin_mtls_edge_origins = var.origin_mtls_edge_prepared ? {
    blue  = aws_lb.runtime.dns_name
    green = aws_lb.origin_mtls_parallel[0].dns_name
  } : {}
}
resource "cloudflare_load_balancer_monitor" "origin_mtls" {
  for_each         = local.origin_mtls_edge_origins
  account_id       = data.cloudflare_zone.primary.account.id
  type             = "https"
  port             = 443
  method           = "GET"
  path             = "/healthz"
  expected_codes   = "200"
  allow_insecure   = false
  follow_redirects = false
  interval         = 60
  timeout          = 5
  retries          = 1
  consecutive_up   = 3
  consecutive_down = 2
  # probe_zone applies zone egress settings, including the custom AOP certificate.
  probe_zone  = "camelai.com"
  header      = { Host = [each.key == "green" ? var.origin_mtls_canary_hostname : var.primary_hostname] }
  description = "${var.name} ${each.key} origin TLS and application health"
}
resource "cloudflare_load_balancer_pool" "origin_mtls" {
  for_each        = local.origin_mtls_edge_origins
  account_id      = data.cloudflare_zone.primary.account.id
  name            = "${var.name}-mtls-${each.key}"
  enabled         = true
  minimum_origins = 1
  check_regions   = ["WNAM"]
  monitor         = cloudflare_load_balancer_monitor.origin_mtls[each.key].id
  origins = [{
    name    = each.key
    address = each.value
    enabled = true
    weight  = 1
  }]
  description = "${var.name} ${each.key} origin for controlled mTLS rollout"
}
resource "cloudflare_load_balancer" "origin_mtls" {
  for_each        = var.origin_mtls_edge_prepared ? local.origin_mtls_edge_hosts : {}
  zone_id         = each.value
  name            = each.key
  enabled         = var.origin_mtls_edge_enabled
  proxied         = true
  default_pools   = var.origin_mtls_original_fallback ? [cloudflare_load_balancer_pool.origin_mtls["green"].id, cloudflare_load_balancer_pool.origin_mtls["blue"].id] : [cloudflare_load_balancer_pool.origin_mtls["green"].id]
  fallback_pool   = cloudflare_load_balancer_pool.origin_mtls[var.origin_mtls_original_fallback ? "blue" : "green"].id
  steering_policy = "random"
  random_steering = {
    default_weight = 0
    pool_weights = merge(
      { (cloudflare_load_balancer_pool.origin_mtls["green"].id) = var.origin_mtls_edge_weight },
      var.origin_mtls_original_fallback ? { (cloudflare_load_balancer_pool.origin_mtls["blue"].id) = 1 - var.origin_mtls_edge_weight } : {},
    )
  }
  # No session-affinity cookie: the application already supports cross-node requests.
  session_affinity = "none"
  adaptive_routing = { failover_across_pools = true }
  description      = "Controlled mTLS migration; disabling restores the original DNS origin"
}
output "origin_mtls_edge" {
  value = {
    prepared          = var.origin_mtls_edge_prepared
    enabled           = var.origin_mtls_edge_enabled
    weight            = var.origin_mtls_edge_weight
    original_fallback = var.origin_mtls_original_fallback
    pools             = { for k, v in cloudflare_load_balancer_pool.origin_mtls : k => v.id }
    load_balancers    = { for k, v in cloudflare_load_balancer.origin_mtls : k => v.id }
  }
}
