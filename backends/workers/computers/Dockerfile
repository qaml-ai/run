FROM node:24-trixie-slim
# git and curl for work that reaches granted hosts (computer.egress); ca-certificates lets the runtime trust the CA
# that signs intercepted HTTPS (update-ca-certificates at start). libnss-myhostname answers the machine's own hostname
# (Cloudflare's read-only /etc/hosts lacks it, and offline DNS waits 28 s): git resolves it for every reflog it writes.
RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates libnss-myhostname && rm -rf /var/lib/apt/lists/*
COPY parse.mjs /usr/local/lib/camelrun-parse.mjs
WORKDIR /
CMD ["sleep", "infinity"]
