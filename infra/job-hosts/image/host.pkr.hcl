# The job host image (docs/design/job-hosts-plan.md, slice 1): Amazon Linux 2023 arm64 with Firecracker, the guest
# kernel, initrd and root image, the host agent and egress proxy, the base network rules, and Nitro Sandboxes set up.
# One AMI per pool kind (the memory pool differs). Building it launches a temporary instance in Miguel's account, so it
# runs only after the go-ahead, by hand (README.md); CI only validates this template.
packer {
  required_plugins {
    amazon = {
      version = "= 1.8.4"
      source  = "github.com/hashicorp/amazon"
    }
  }
}

variable "pool" {
  type        = string
  description = "build or test: the memory pool reserved for sandboxes differs"
  validation {
    condition     = contains(["build", "test"], var.pool)
    error_message = "The pool is build or test."
  }
}
variable "region" {
  type    = string
  default = "us-west-2"
}
variable "instance_type" {
  type        = string
  default     = "r8gd.4xlarge"
  description = "The builder: the same family the pool runs, so the image's boot units see the hardware they will"
}
variable "subnet_id" {
  type        = string
  description = "A private subnet with a route to the internet (packages, the Firecracker release) and to SSM"
}
variable "source_revision" {
  type        = string
  description = "The camelRun commit whose jobhost/ and shared/ the image carries"
}

source "amazon-ebs" "host" {
  region        = var.region
  instance_type = var.instance_type
  subnet_id     = var.subnet_id
  ami_name      = "camelrun-job-host-${var.pool}-{{timestamp}}"
  # Amazon Linux 2023, arm64, kernel 6.18 (the spike's), newest.
  source_ami_filter {
    filters = {
      name                = "al2023-ami-2023.*-kernel-6.18-arm64"
      architecture        = "arm64"
      virtualization-type = "hvm"
      root-device-type    = "ebs"
    }
    owners      = ["amazon"]
    most_recent = true
  }
  # No SSH: Packer reaches the builder through SSM Session Manager, as operators reach a host.
  communicator  = "ssh"
  ssh_username  = "ec2-user"
  ssh_interface = "session_manager"
  temporary_iam_instance_profile_policy_document {
    Statement {
      Action   = ["ssm:UpdateInstanceInformation", "ssmmessages:*", "ec2messages:*"]
      Effect   = "Allow"
      Resource = ["*"]
    }
    Version = "2012-10-17"
  }
  metadata_options {
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    http_endpoint               = "enabled"
  }
  enable_nitro_enclave = true
  launch_block_device_mappings {
    device_name           = "/dev/xvda"
    volume_size           = 30
    volume_type           = "gp3"
    delete_on_termination = true
    encrypted             = true
  }
  tags = {
    "camelrun:component" = "job-host"
    "camelrun:pool"      = var.pool
    "camelrun:revision"  = var.source_revision
  }
}

build {
  sources = ["source.amazon-ebs.host"]
  provisioner "file" {
    source      = "${path.root}/"
    destination = "/tmp/camel-image"
  }
  provisioner "file" {
    source      = "${path.root}/../../../jobhost"
    destination = "/tmp/camel-image/jobhost"
  }
  provisioner "file" {
    source      = "${path.root}/../../../shared"
    destination = "/tmp/camel-image/shared"
  }
  provisioner "shell" {
    inline = ["sudo POOL=${var.pool} bash /tmp/camel-image/provision/host-setup.sh /tmp/camel-image"]
  }
  provisioner "shell" {
    inline = ["sudo bash /tmp/camel-image/check-image.sh"]
  }
}
