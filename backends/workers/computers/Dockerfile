FROM node:24-trixie-slim
# git and curl for work that reaches granted hosts (computer.egress); ca-certificates lets the runtime trust the CA
# that signs intercepted HTTPS (update-ca-certificates at start). libnss-myhostname answers the machine's own hostname
# (Cloudflare's read-only /etc/hosts lacks it, and offline DNS waits 28 s): git resolves it for every reflog it writes.
# python3 (with venv and pip) and build-essential: Python projects, and npm packages that compile native code
# (node-gyp). They take the image from 360 MB to 650 MB (local build).
RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates libnss-myhostname \
      python3 python3-venv python3-pip build-essential && rm -rf /var/lib/apt/lists/*
COPY parse.mjs /usr/local/lib/camelrun-parse.mjs
WORKDIR /
CMD ["sleep", "infinity"]
