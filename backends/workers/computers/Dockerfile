FROM node:24-trixie-slim
COPY --from=docker.io/cloudflare/sandbox:1.0.3 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
COPY parse.mjs /usr/local/lib/camelrun-parse.mjs
WORKDIR /
CMD ["sleep", "infinity"]
