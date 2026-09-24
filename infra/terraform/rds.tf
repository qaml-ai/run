# Postgres: the runtime's control plane (ownership leases, indexes, timers, outboxes,
# counters, accounts). Bulk data (transcripts, journals, volume chunks) stays in S3.
# Every runtime node needs it, so it is Multi-AZ with synchronous standby commits.

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

resource "aws_db_subnet_group" "control" {
  name       = "${var.name}-control"
  subnet_ids = data.aws_subnets.default.ids
}

resource "aws_security_group" "database" {
  name        = "${var.name}-database"
  description = "Agent runtime Postgres: reachable from runtime nodes only"
  vpc_id      = data.aws_vpc.default.id
}

resource "aws_db_instance" "control" {
  identifier     = "${var.name}-control"
  engine         = "postgres"
  engine_version = var.database_engine_version
  instance_class = var.database_instance_class
  db_name        = "agent_runtime"
  username       = "agent_runtime"
  # RDS generates and rotates the password in Secrets Manager; it never appears in state.
  manage_master_user_password = true

  allocated_storage     = 20
  max_allocated_storage = 200
  storage_type          = "gp3"
  storage_encrypted     = true

  multi_az               = true
  db_subnet_group_name   = aws_db_subnet_group.control.name
  vpc_security_group_ids = [aws_security_group.database.id]
  publicly_accessible    = false

  backup_retention_period      = 7
  backup_window                = "09:00-09:30"
  maintenance_window           = "sun:10:00-sun:10:30"
  auto_minor_version_upgrade   = true
  copy_tags_to_snapshot        = true
  deletion_protection          = true
  skip_final_snapshot          = false
  final_snapshot_identifier    = "${var.name}-control-final"
  performance_insights_enabled = false

  lifecycle {
    prevent_destroy = true
  }
}

