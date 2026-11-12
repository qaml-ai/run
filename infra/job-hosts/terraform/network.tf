# Private subnets for the pools in the runtime's default VPC (infra/terraform/runtime.tf looks it up the same way).
# Existing VPC resources are only read here, never changed: the pools get their own subnets, route table, NAT
# gateway and security group.
#
# The runtime's ECS tasks have no NAT (public subnets, public IPs; infra/terraform/ecs.tf), so this module adds
# one NAT gateway: about $33/month plus $0.045/GB processed, whether or not a host runs.

data "aws_vpc" "default" {
  default = true
}

# The default (public) subnet of the NAT's zone.
data "aws_subnet" "nat_public" {
  vpc_id            = data.aws_vpc.default.id
  availability_zone = var.nat_subnet_az
  default_for_az    = true
}

resource "aws_subnet" "private" {
  for_each = var.private_subnets

  vpc_id                  = data.aws_vpc.default.id
  availability_zone       = each.key
  cidr_block              = each.value
  map_public_ip_on_launch = false

  tags = { Name = "${var.name}-private-${each.key}" }

  lifecycle {
    precondition {
      # The subnet's address, masked to the VPC's prefix length, is the VPC's network address.
      condition     = cidrhost(format("%s/%s", split("/", each.value)[0], split("/", data.aws_vpc.default.cidr_block)[1]), 0) == cidrhost(data.aws_vpc.default.cidr_block, 0)
      error_message = "Each private subnet CIDR must lie inside the default VPC's CIDR."
    }
  }
}

resource "aws_eip" "nat" {
  domain = "vpc"
  tags   = { Name = "${var.name}-nat" }
}

resource "aws_nat_gateway" "pools" {
  allocation_id = aws_eip.nat.id
  subnet_id     = data.aws_subnet.nat_public.id
  tags          = { Name = "${var.name}-nat" }
}

resource "aws_route_table" "private" {
  vpc_id = data.aws_vpc.default.id
  tags   = { Name = "${var.name}-private" }
}

resource "aws_route" "private_default" {
  route_table_id         = aws_route_table.private.id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.pools.id
}

resource "aws_route_table_association" "private" {
  for_each       = aws_subnet.private
  subnet_id      = each.value.id
  route_table_id = aws_route_table.private.id
}

# S3 traffic (images, snapshots) goes through a gateway endpoint: free, and off the NAT's per-GB charge.
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
  route_table_id  = aws_route_table.private.id
}

# No inbound rule at all (no SSH: SSM only, which the host dials out to). Egress on 443 only: the runtime's WebSocket,
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
