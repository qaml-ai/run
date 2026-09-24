# The executor AMI: AL2023 arm64 with Docker (first-boot image pull only), the
# ECR credential helper, gVisor, Node, the CloudWatch agent, nftables, the
# sandbox helper and the executor unit. Hosts boot from it in private subnets
# with no internet. Build with build-ami.sh, which supplies the pins in
# versions.env; the build instance itself needs internet access.
packer {
  required_plugins {
    amazon = {
      version = ">= 1.3.0"
      source  = "github.com/hashicorp/amazon"
    }
  }
}

variable "region" {
  type    = string
  default = "us-west-2"
}

# Empty: the default VPC. Otherwise a subnet with internet egress for the build instance.
variable "subnet_id" {
  type    = string
  default = ""
}

variable "gvisor_release" { type = string }
variable "gvisor_sha512" { type = string }
variable "node_version" { type = string }
variable "node_sha256" { type = string }

locals {
  stamp = formatdate("YYYYMMDDhhmmss", timestamp())
}

source "amazon-ebs" "executor" {
  region        = var.region
  instance_type = "t4g.small"
  ami_name      = "camelai-agent-executor-${local.stamp}"
  subnet_id     = var.subnet_id == "" ? null : var.subnet_id

  source_ami_filter {
    owners      = ["amazon"]
    most_recent = true
    filters = {
      name                = "al2023-ami-2023.*-kernel-*-arm64"
      architecture        = "arm64"
      root-device-type    = "ebs"
      virtualization-type = "hvm"
    }
  }

  # SSH reaches the build instance only, from the builder's address; the AMI
  # itself has sshd disabled and no authorized keys.
  ssh_username                              = "ec2-user"
  associate_public_ip_address               = true
  temporary_security_group_source_public_ip = true

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  launch_block_device_mappings {
    device_name           = "/dev/xvda"
    volume_size           = 16
    volume_type           = "gp3"
    encrypted             = true
    delete_on_termination = true
  }

  tags = {
    Name          = "camelai-agent-executor"
    BaseAmi       = "{{ .SourceAMI }}"
    GvisorRelease = var.gvisor_release
    NodeVersion   = var.node_version
  }
}

build {
  sources = ["source.amazon-ebs.executor"]

  provisioner "file" {
    sources = [
      "${path.root}/sandbox.sh",
      "${path.root}/agent-executor.service",
      "${path.root}/agent-executor.sudoers",
      "${path.root}/agent-executor.logrotate",
      "${path.root}/ami-setup.sh",
    ]
    destination = "/tmp/"
  }

  provisioner "shell" {
    inline = ["sudo GVISOR_RELEASE='${var.gvisor_release}' GVISOR_SHA512='${var.gvisor_sha512}' NODE_VERSION='${var.node_version}' NODE_SHA256='${var.node_sha256}' bash /tmp/ami-setup.sh"]
  }
}
