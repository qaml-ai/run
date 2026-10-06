# Hosted agent runtime: the HTTP/SSE service, agent processes and the js_exec sandboxes (V8, in v8-exec).
# Build from the repository root: docker build -t agent-runtime .

# agent-launcher (sandbox/launcher.c): starts the sandbox processes and the runtime. Static, so the
# final image needs no libseccomp.
FROM node:22-bookworm-slim AS launcher
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev libseccomp-dev && rm -rf /var/lib/apt/lists/*
COPY sandbox/launcher.c /src/launcher.c
RUN gcc -O2 -Wall -Wextra -Werror -static -o /agent-launcher /src/launcher.c -lseccomp

# v8-exec (sandbox/v8-exec): js_exec on a bare V8 isolate, one process per execution (src/v8-exec.ts).
# Built on the build machine's own architecture and cross-compiled to the target's: rusty_v8 ships
# prebuilt static V8 libraries for both, so no V8 build and no emulated compile.
FROM --platform=$BUILDPLATFORM rust:1.95.0-slim-bookworm AS v8exec
ARG TARGETARCH
RUN set -eux; case "$TARGETARCH" in \
      arm64) triple=aarch64-unknown-linux-gnu; gnu=aarch64-linux-gnu; deb=arm64 ;; \
      amd64) triple=x86_64-unknown-linux-gnu; gnu=x86_64-linux-gnu; deb=amd64 ;; \
    esac; \
    echo "$triple" > /triple; \
    apt-get update; apt-get install -y --no-install-recommends ca-certificates curl "gcc-$(echo $gnu | tr _ -)" "libc6-dev-$deb-cross"; \
    rm -rf /var/lib/apt/lists/*; \
    rustup target add "$triple"
ENV CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc \
    CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER=x86_64-linux-gnu-gcc
WORKDIR /src
# This image is the toolchain sandbox/v8-exec/rust-toolchain.toml pins (keep the two in step); the file stays
# out so rustup uses the image's, with its cross targets.
COPY sandbox/v8-exec/Cargo.toml sandbox/v8-exec/Cargo.lock ./
COPY sandbox/v8-exec/src ./src
RUN --mount=type=cache,target=/usr/local/cargo/registry --mount=type=cache,target=/src/target,id=v8exec-$TARGETARCH \
    cargo build --release --locked --target "$(cat /triple)" && cp "target/$(cat /triple)/release/v8-exec" /v8-exec

FROM node:22-bookworm-slim

WORKDIR /app
# Runtime dependencies only, exactly as locked; UI build tooling is in devDependencies.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY src ./src
COPY shared ./shared
# The hosted MCP endpoint (/mcp) serves the camelrun CLI's MCP tools.
COPY packages/cli/package.json ./packages/cli/package.json
COPY packages/cli/src ./packages/cli/src
COPY migrations ./migrations
# One-off tasks around storage collection (docs/operations/persistence.md): pin backfill, and the check before deletion.
COPY scripts/backfill-pins.ts scripts/verify-gc.ts scripts/check-storage.ts ./scripts/
# Served at /docs/, /llms.txt and /llms-full.txt, and the UI registry at /r/ (src/docs.ts).
COPY docs ./docs
COPY packages/registry/public/r ./packages/registry/public/r
# Built on the host first (npm run build:console); served at /console/.
COPY console/dist ./console/dist

# CA bundle for verifying the control-plane database over TLS (AGENT_DATABASE_CA): the RDS CAs, which sign
# the instance's own endpoint, and the Amazon Trust Services roots, which sign RDS Proxy's (ACM) certificates.
# The runtime connects through RDS Proxy; the instance endpoint stays for migrations and debugging.
# Create the directory first: ADD would create it with the file mode, and Node could no longer read /etc/ssl/openssl.cnf.
RUN mkdir -p /etc/ssl
ADD --chmod=644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /tmp/database-ca/rds.pem
ADD --chmod=644 --checksum=sha256:2c43952ee9e000ff2acc4e2ed0897c0a72ad5fa72c3d934e81741cbd54f05bd1 https://www.amazontrust.com/repository/AmazonRootCA1.pem /tmp/database-ca/
ADD --chmod=644 --checksum=sha256:a3a7fe25439d9a9b50f60af43684444d798a4c869305bf615881e5c84a44c1a2 https://www.amazontrust.com/repository/AmazonRootCA2.pem /tmp/database-ca/
ADD --chmod=644 --checksum=sha256:3eb7c3258f4af9222033dc1bb3dd2c7cfa0982b98e39fb8e9dc095cfeb38126c https://www.amazontrust.com/repository/AmazonRootCA3.pem /tmp/database-ca/
ADD --chmod=644 --checksum=sha256:b0b7961120481e33670315b2f843e643c42f693c7a1010eb9555e06ddc730214 https://www.amazontrust.com/repository/AmazonRootCA4.pem /tmp/database-ca/
ADD --chmod=644 --checksum=sha256:870f56d009d8aeb95b716b0e7b0020225d542c4b283b9ed896edf97428d6712e https://www.amazontrust.com/repository/SFSRootCAG2.pem /tmp/database-ca/
# Some of the files lack a final newline, so join them one per line; then refuse to build a bundle without both kinds of root.
RUN for pem in /tmp/database-ca/*.pem; do cat "$pem"; echo; done | sed '/^$/d' > /etc/ssl/rds-global-bundle.pem \
 && chmod 644 /etc/ssl/rds-global-bundle.pem && rm -rf /tmp/database-ca \
 && node -e 'const { X509Certificate } = require("node:crypto"); const pems = require("node:fs").readFileSync("/etc/ssl/rds-global-bundle.pem", "utf8").match(/-----BEGIN CERTIFICATE-----[^-]+-----END CERTIFICATE-----/g); const subjects = pems.map(pem => new X509Certificate(pem).subject); for (const cn of ["CN=Amazon Root CA 1", "CN=Amazon RDS us-west-2 Root CA RSA2048 G1"]) if (!subjects.some(subject => subject.includes(cn))) throw new Error(`database CA bundle lacks ${cn}`); console.log(`database CA bundle: ${pems.length} certificates`)'
# js_exec runs in sandbox processes as their own uid, which must not read the runtime's data.
# Sandbox process i runs as uid 1001 + i in this group.
RUN groupadd --gid 1001 sandbox \
 && useradd --uid 1001 --gid 1001 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin sandbox \
 && mkdir -p /data && chown node:node /data && chmod 700 /data
COPY --from=launcher /agent-launcher /usr/local/bin/agent-launcher
# No startup snapshot of our own: measured, it saved nothing over V8's built-in one (bench/v8-exec-*.json).
COPY --from=v8exec /v8-exec /usr/local/bin/v8-exec
# No USER: the launcher starts as root, then runs the runtime as node (uid 1000) and the
# sandbox processes as their own uids. The runtime refuses to start without them.
ENV NODE_ENV=production \
    HOME=/home/node \
    AGENT_SANDBOX_REQUIRED=1 \
    AGENT_DATA_DIR=/data \
    HOST=0.0.0.0 \
    PORT=8790
EXPOSE 8790
VOLUME ["/data"]
# SIGTERM drains (see AGENT_DRAIN_TIMEOUT_MS): give the container longer than that before SIGKILL.
# The load balancer checks /healthz, so the image has no HEALTHCHECK.
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/local/bin/agent-launcher"]
CMD ["node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", "src/server.ts"]
