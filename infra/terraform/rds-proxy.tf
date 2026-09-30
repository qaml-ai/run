# RDS Proxy in front of the control-plane Postgres. In a Multi-AZ failover the
# proxy keeps client connections open at the same address, queues statements
# while the standby is promoted, and sends them to the new writer, so tasks see
# a stall instead of dropped connections and a DNS change (the repository
# README, "Database outages"). The runtime connects through it
# (AGENT_DATABASE_HOST); the instance endpoint stays reachable from the tasks
# for debugging.
#
# Auth: the proxy logs in to the database with the RDS-managed master secret,
# the same one the runtime reads, and checks the runtime's login against it.
# When RDS rotates it (every 7 days), sessions already open stay open; a login
# that meets the proxy and the runtime on different versions fails, answers 503,
# and is retried after the runtime re-reads the secret.
#
# Billed per vCPU of the instance behind it, whether or not it carries traffic:
# $0.015 per vCPU-hour in us-west-2; db.t4g.small has 2 vCPU (also the minimum
# charge), about $22 a month.

resource "aws_security_group" "database_proxy" {
  name        = "${var.name}-database-proxy"
  description = "Agent runtime RDS Proxy: 5432 from runtime tasks, to the database"
  vpc_id      = data.aws_vpc.default.id
  tags        = { Name = "${var.name}-database-proxy" }
}

resource "aws_vpc_security_group_ingress_rule" "database_proxy_from_task" {
  security_group_id            = aws_security_group.database_proxy.id
  referenced_security_group_id = aws_security_group.task.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "Postgres from runtime ECS tasks"
}

resource "aws_vpc_security_group_egress_rule" "database_proxy_to_database" {
  security_group_id            = aws_security_group.database_proxy.id
  referenced_security_group_id = aws_security_group.database.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "Postgres to the control-plane instance"
}

resource "aws_vpc_security_group_ingress_rule" "database_from_proxy" {
  security_group_id            = aws_security_group.database.id
  referenced_security_group_id = aws_security_group.database_proxy.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "Postgres from the RDS Proxy"
}

# The proxy reads the master secret itself. The secret is encrypted with the
# AWS-managed aws/secretsmanager key, whose key policy already lets account
# principals decrypt through Secrets Manager; the kms:Decrypt statement keeps
# this working if the secret ever moves to a customer-managed key.
data "aws_iam_policy_document" "database_proxy_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["rds.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "database_proxy" {
  name               = "${var.name}-database-proxy"
  description        = "Agent runtime RDS Proxy: reads the database master secret"
  assume_role_policy = data.aws_iam_policy_document.database_proxy_assume.json
}

resource "aws_iam_role_policy" "database_proxy" {
  name = "database-proxy-secret"
  role = aws_iam_role.database_proxy.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "MasterSecret"
        Effect   = "Allow"
        Action   = "secretsmanager:GetSecretValue"
        Resource = aws_db_instance.control.master_user_secret[0].secret_arn
      },
      {
        Sid       = "DecryptMasterSecret"
        Effect    = "Allow"
        Action    = "kms:Decrypt"
        Resource  = aws_db_instance.control.master_user_secret[0].kms_key_id
        Condition = { StringEquals = { "kms:ViaService" = "secretsmanager.${var.region}.amazonaws.com" } }
      },
    ]
  })
}

# The proxy's connection log (connections, logins, errors; statements only with
# debug logging, which stays off). RDS creates the group without an expiry when it
# is missing; declaring it gives it one. An existing group is imported, not recreated.
resource "aws_cloudwatch_log_group" "database_proxy" {
  name              = "/aws/rds/proxy/${var.name}-control"
  retention_in_days = 30
}

resource "aws_db_proxy" "control" {
  name           = "${var.name}-control"
  engine_family  = "POSTGRESQL"
  role_arn       = aws_iam_role.database_proxy.arn
  vpc_subnet_ids = data.aws_subnets.default.ids
  # TLS on every client connection and to the database. The proxy's certificate
  # is from ACM (Amazon Trust Services roots); the image's AGENT_DATABASE_CA
  # bundle holds those roots as well as the RDS ones.
  require_tls            = true
  vpc_security_group_ids = [aws_security_group.database_proxy.id]

  auth {
    description               = "RDS-managed master user"
    auth_scheme               = "SECRETS"
    secret_arn                = aws_db_instance.control.master_user_secret[0].secret_arn
    iam_auth                  = "DISABLED"
    client_password_auth_type = "POSTGRES_SCRAM_SHA_256"
  }

  depends_on = [aws_iam_role_policy.database_proxy, aws_cloudwatch_log_group.database_proxy]
}

# Default target group settings: the pool may use all of max_connections, and a
# client waits up to 120 s to borrow a connection (a failover's queueing).
# A transaction keeps one database connection until it ends, which is what the
# runtime relies on. Nothing it runs pins a session for longer: the migration
# runner's pg_advisory_xact_lock is transaction-scoped, which the proxy does not
# pin on (session-level advisory locks, SET, LISTEN or a temporary table would).
# A statement over 16 KB (a large migration file) pins that one connection's
# session, which costs multiplexing only.
resource "aws_db_proxy_target" "control" {
  db_proxy_name          = aws_db_proxy.control.name
  target_group_name      = "default"
  db_instance_identifier = aws_db_instance.control.identifier

  # So the proxy's first health check can already reach the database.
  depends_on = [aws_vpc_security_group_egress_rule.database_proxy_to_database, aws_vpc_security_group_ingress_rule.database_from_proxy]
}
