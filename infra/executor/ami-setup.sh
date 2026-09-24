#!/bin/bash
# Runs as root on the Packer build instance (see ami.pkr.hcl), with the files it
# uploads in /tmp. Everything an executor host needs at boot is installed here:
# hosts have no internet, only VPC endpoints.
set -euo pipefail
: "${GVISOR_RELEASE:?}" "${GVISOR_SHA512:?}" "${NODE_VERSION:?}" "${NODE_SHA256:?}"
[[ "$(uname -m)" == aarch64 ]] || { echo "The pinned checksums are for arm64" >&2; exit 1; }

dnf install -y awscli-2 docker amazon-ecr-credential-helper amazon-cloudwatch-agent nftables logrotate sudo tar xz bzip2
dnf clean all

work=$(mktemp -d)
cd "$work"
# gVisor, pinned by release date and checksum. runsc needs the gvisor-bin sidecars next to it.
curl -fsSLo gvisor.tar.bz2 "https://storage.googleapis.com/gvisor/releases/release/$GVISOR_RELEASE/aarch64/gvisor.tar.bz2"
echo "$GVISOR_SHA512  gvisor.tar.bz2" | sha512sum -c -
install -d -m 755 /usr/local/lib/gvisor
tar -xjf gvisor.tar.bz2 -C /usr/local/lib/gvisor --no-same-owner runsc gvisor-bin
chmod -R go-w /usr/local/lib/gvisor
/usr/local/lib/gvisor/runsc --version

# Node for the executor service; the sandboxes use the runtime image's own Node.
curl -fsSLo node.tar.xz "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-arm64.tar.xz"
echo "$NODE_SHA256  node.tar.xz" | sha256sum -c -
install -d -m 755 /opt/node
tar -xJf node.tar.xz -C /opt/node --strip-components=1 --no-same-owner
/opt/node/bin/node --version

useradd --system --no-create-home --home-dir /nonexistent --shell /sbin/nologin agent-executor
install -D -m 755 /tmp/sandbox.sh /usr/local/libexec/agent-executor/sandbox
install -m 440 /tmp/agent-executor.sudoers /etc/sudoers.d/agent-executor
visudo -cf /etc/sudoers.d/agent-executor
install -m 644 /tmp/agent-executor.service /etc/systemd/system/agent-executor.service
install -m 644 /tmp/agent-executor.logrotate /etc/logrotate.d/agent-executor
install -d -m 755 /var/log/agent-executor /etc/agent-executor

# gVisor runs on this kernel and platform (systrap).
/usr/local/lib/gvisor/runsc --network=none "do" true

# user-data.sh starts Docker once to pull the image and enables the executor.
systemctl disable docker.service docker.socket
systemctl enable amazon-ssm-agent
# No SSH on executor hosts: SSM only.
systemctl disable sshd.service
rm -f /home/ec2-user/.ssh/authorized_keys /root/.ssh/authorized_keys
cd /
rm -rf "$work" /tmp/sandbox.sh /tmp/agent-executor.* /tmp/ami-setup.sh
