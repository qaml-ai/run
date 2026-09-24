# Hosted agent runtime: the HTTP/SSE service, agent processes and the QuickJS sandbox.
# Build from the repository root: docker build -t agent-runtime .
FROM node:22-bookworm-slim

WORKDIR /app
# Runtime dependencies only, exactly as locked; UI build tooling is in devDependencies.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY src ./src
COPY shared ./shared
COPY migrations ./migrations
# Built on the host first (npm run build:console); served at /console/.
COPY console/dist ./console/dist

# CA bundle for verifying the RDS control-plane database over TLS (AGENT_DATABASE_CA).
# Create the directory first: ADD would create it with the file mode, and Node could no longer read /etc/ssl/openssl.cnf.
RUN mkdir -p /etc/ssl
ADD --chmod=644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /etc/ssl/rds-global-bundle.pem
RUN mkdir -p /data && chown node:node /data
USER node
ENV NODE_ENV=production \
    AGENT_DATA_DIR=/data \
    HOST=0.0.0.0 \
    PORT=8790
EXPOSE 8790
VOLUME ["/data"]
# SIGTERM drains (see AGENT_DRAIN_TIMEOUT_MS): give the container longer than that before SIGKILL.
# The load balancer checks /healthz, so the image has no HEALTHCHECK.
STOPSIGNAL SIGTERM
CMD ["node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", "src/server.ts"]
