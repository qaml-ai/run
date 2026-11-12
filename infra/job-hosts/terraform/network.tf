# Dedicated PUBLIC subnets for the pools in the runtime's default VPC (infra/terraform/runtime.tf looks the VPC up
# the same way). Existing VPC resources are only read, never changed: the pools get their own subnets, route table,
# network ACL and security group, and route through the VPC's existing internet gateway.
#
# Why public subnets and no NAT: hosts need only HTTPS out (the runtime's WebSocket, the egress proxy, SSM, STS) and
# S3, which goes through the gateway endpoint below. A public IP exposes nothing: the security group is stateful and
# has no inbound rule, so nothing unsolicited reaches a host, and the network ACL below admits only return traffic.
# A NAT gateway would add about $33/month plus $0.045/GB for no isolation gain. Each running host pays for its
# public IPv4 address instead: $0.005/h, about $3.65/month per host, nothing while the pools are empty.

data "aws_vpc" "default" {
  default = true
}

data "aws_internet_gateway" "default" {
  filter {
    name   = "attachment.vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

resource "aws_subnet" "pool" {
  for_each = var.pool_subnets

  vpc_id                  = data.aws_vpc.default.id
  availability_zone       = each.key
  cidr_block              = each.value
  map_public_ip_on_launch = true

  tags = { Name = "${var.name}-${each.key}" }

  lifecycle {
    precondition {
      # The subnet's address, masked to the VPC's prefix length, is the VPC's network address.
      condition     = cidrhost(format("%s/%s", split("/", each.value)[0], split("/", data.aws_vpc.default.cidr_block)[1]), 0) == cidrhost(data.aws_vpc.default.cidr_block, 0)
      error_message = "Each pool subnet CIDR must lie inside the default VPC's CIDR."
    }
  }
}

resource "aws_route_table" "pools" {
  vpc_id = data.aws_vpc.default.id
  tags   = { Name = "${var.name}-pools" }
}

resource "aws_route" "pools_default" {
  route_table_id         = aws_route_table.pools.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = data.aws_internet_gateway.default.id
}

resource "aws_route_table_association" "pool" {
  for_each       = aws_subnet.pool
  subnet_id      = each.value.id
  route_table_id = aws_route_table.pools.id
}

# S3 traffic (images, snapshots) goes through a gateway endpoint: free, and it stays on AWS's network.
resource "aws_vpc_endpoint" "s3" {
  count             = var.s3_gateway_endpoint_id == "" ? 1 : 0
  vpc_id            = data.aws_vpc.default.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  tags              = { Name = "${var.name}-s3" }
}

locals {
  s3_endpoint_id = var.s3_gateway_endpoint_id == "" ? aws_vpc_endpoint.s3[0].id : var.s3_gateway_endpoint_id
}

resource "aws_vpc_endpoint_route_table_association" "s3" {
  vpc_endpoint_id = local.s3_endpoint_id
  route_table_id  = aws_route_table.pools.id
}

# No inbound rule at all (no SSH: SSM only, which the host dials out to). Egress on 443 only: the runtime's WebSocket, the egress proxy,
# S3, SSM, STS, and the per-job allowlisted registries and GitHub (the allowlist itself is enforced on the host).
# No rule for DNS or NTP: security groups do not filter traffic to the Amazon-provided DNS resolver (VPC base + 2,
# 169.254.169.253), the Time Sync Service (169.254.169.123) or the instance metadata service.
resource "aws_security_group" "hosts" {
  name        = "${var.name}-hosts"
  description = "Job hosts: no inbound; egress 443 only"
  vpc_id      = data.aws_vpc.default.id
  tags        = { Name = "${var.name}-hosts" }
  # No inline rules: the provider removes AWS's default allow-all egress rule when it creates the group, and the
  # only rule is the one below.
}

resource "aws_vpc_security_group_egress_rule" "hosts_https" {
  security_group_id = aws_security_group.hosts.id
  description       = "HTTPS out (runtime, S3, SSM, STS, allowlisted registries)"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

# A stateless second layer on the pool subnets. Inbound: only TCP to ephemeral ports (return traffic of the hosts'
# own connections) and ICMP "fragmentation needed" (path MTU discovery: hosts use 9001-byte frames inside the VPC,
# the internet 1500). Outbound: TCP 443 and the ephemeral reply ports. Everything else is denied by the ACL's
# final rule. Like security groups, network ACLs do not filter traffic to the Amazon-provided DNS resolver, the
# instance metadata service, the Time Sync Service or DHCP, so DNS, IMDS and NTP keep working without rules.
resource "aws_network_acl" "pools" {
  vpc_id     = data.aws_vpc.default.id
  subnet_ids = [for subnet in aws_subnet.pool : subnet.id]
  tags       = { Name = "${var.name}-pools" }
}

resource "aws_network_acl_rule" "in_return_tcp" {
  network_acl_id = aws_network_acl.pools.id
  rule_number    = 100
  egress         = false
  protocol       = "tcp"
  rule_action    = "allow"
  cidr_block     = "0.0.0.0/0"
  from_port      = 1024
  to_port        = 65535
}

resource "aws_network_acl_rule" "in_fragmentation_needed" {
  network_acl_id = aws_network_acl.pools.id
  rule_number    = 110
  egress         = false
  protocol       = "icmp"
  rule_action    = "allow"
  cidr_block     = "0.0.0.0/0"
  icmp_type      = 3
  icmp_code      = 4
}

resource "aws_network_acl_rule" "out_https" {
  network_acl_id = aws_network_acl.pools.id
  rule_number    = 100
  egress         = true
  protocol       = "tcp"
  rule_action    = "allow"
  cidr_block     = "0.0.0.0/0"
  from_port      = 443
  to_port        = 443
}

resource "aws_network_acl_rule" "out_ephemeral" {
  network_acl_id = aws_network_acl.pools.id
  rule_number    = 110
  egress         = true
  protocol       = "tcp"
  rule_action    = "allow"
  cidr_block     = "0.0.0.0/0"
  from_port      = 1024
  to_port        = 65535
}
