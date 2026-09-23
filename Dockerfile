# Hosted agent runtime: the HTTP/SSE service, agent processes and the QuickJS sandbox.
# Build from the repository root: docker build -t agent-runtime .
# The same image runs a code executor host (no credentials, no agent state) with:
#   docker run --runtime=runsc -e AGENT_EXECUTOR_TOKEN=... agent-runtime \
#     node --experimental-strip-types --disable-warning=ExperimentalWarning src/executor/server.ts
# See infra/executor/README.md.
FROM node:22-bookworm-slim

WORKDIR /app
# Runtime dependencies only, exactly as locked; UI build tooling is in devDependencies.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY src ./src
COPY shared ./shared
# Built on the host first (npm run build:console); served at /console/.
COPY console/dist ./console/dist

RUN mkdir -p /data && chown node:node /data
USER node
ENV NODE_ENV=production \
    AGENT_DATA_DIR=/data \
    HOST=0.0.0.0 \
    PORT=8790
EXPOSE 8790
VOLUME ["/data"]
CMD ["node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", "src/server.ts"]
