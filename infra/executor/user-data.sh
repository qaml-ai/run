#!/bin/bash
# First boot of a code executor host. A Terraform templatefile() with exactly the
# variables region, image, token_secret_arn, log_group, runtime_callback_cidr and
# max_concurrency (see README.md); a doubled dollar sign escapes an interpolation.
# It holds no secret: the instance role pulls the image, and the executor reads
# its token from Secrets Manager itself. Docker, gVisor, Node, the CloudWatch
# agent, the sandbox helper and the unit come from the AMI (ami.pkr.hcl), so
# boot needs no internet, only the VPC endpoints.
set -euo pipefail
umask 022

region='${region}'
image='${image}'
registry=$${image%%/*}

# Logs first, so a failed boot shows up in CloudWatch too.
cat > /opt/aws/amazon-cloudwatch-agent/etc/agent-executor.json <<'JSON'
{
  "agent": { "run_as_user": "root" },
  "logs": {
    "logs_collected": {
      "files": {
        "collect_list": [
          { "file_path": "/var/log/agent-executor/executor.log", "log_group_name": "${log_group}", "log_stream_name": "{instance_id}/executor" },
          { "file_path": "/var/log/cloud-init-output.log", "log_group_name": "${log_group}", "log_stream_name": "{instance_id}/boot" }
        ]
      }
    }
  }
}
JSON
/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s \
  -c file:/opt/aws/amazon-cloudwatch-agent/etc/agent-executor.json

# The executor's user reaches the runtime's callback listener, the instance role's
# credentials (IMDS) and HTTPS (Secrets Manager; the security group allows only
# the VPC endpoints), and nothing else. Port 8790 answers the runtime only.
# The unit loads this on every start.
install -d -m 755 /etc/agent-executor
cat > /etc/agent-executor/egress.nft <<'NFT'
table inet agent_executor
delete table inet agent_executor
table inet agent_executor {
  chain input {
    type filter hook input priority filter; policy accept;
    tcp dport 8790 ip saddr != ${runtime_callback_cidr} drop
  }
  chain output {
    type filter hook output priority filter; policy accept;
    meta skuid "agent-executor" jump executor
  }
  chain executor {
    ct state established,related accept
    oifname "lo" accept
    ip daddr 169.254.169.254 tcp dport 80 accept
    ip daddr ${runtime_callback_cidr} meta l4proto tcp accept
    tcp dport 443 accept
    counter reject
  }
}
NFT

cat > /etc/agent-executor/executor.env <<ENV
AWS_REGION=$region
AGENT_EXECUTOR_TOKEN_SECRET_ARN=${token_secret_arn}
AGENT_EXECUTOR_MAX_CONCURRENCY=${max_concurrency}
ENV

# Pull with the instance role, then keep only the filesystem: the sandboxes'
# read-only root, and a copy of /app for the executor itself. The rootfs sits in a
# root-only directory, so the executor's user cannot plant files in it.
install -d -m 700 /root/.docker
printf '{"credHelpers":{"%s":"ecr-login"}}\n' "$registry" > /root/.docker/config.json
systemctl start docker
pull() {
  for _ in 1 2 3 4 5; do docker pull --quiet "$image" && return 0; sleep 10; done
  return 1
}
pull
install -d -m 700 /opt/agent-executor/sandbox
install -d -m 755 /opt/agent-executor/sandbox/rootfs
container=$(docker create "$image")
docker export "$container" | tar -x -C /opt/agent-executor/sandbox/rootfs
docker rm "$container" >/dev/null
docker rmi "$image" >/dev/null
# Nothing else needs Docker, and its socket is root-equivalent.
systemctl disable --now docker.service docker.socket
test -f /opt/agent-executor/sandbox/rootfs/app/src/executor/sandbox-child.ts
cp -a /opt/agent-executor/sandbox/rootfs/app /opt/agent-executor/app
chown -R root:root /opt/agent-executor/app
chmod -R go-w /opt/agent-executor/app

systemctl enable --now agent-executor.service
