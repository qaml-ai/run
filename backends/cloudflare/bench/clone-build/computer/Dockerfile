FROM ghcr.io/cloudflare/computer-computerd-linux-x64:0.9.0 AS computerd
FROM node:22-trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends git curl build-essential time procps util-linux ca-certificates xz-utils zstd fuse3 libfuse2t64 && rm -rf /var/lib/apt/lists/*
COPY --from=computerd /usr/local/bin/computerd /usr/local/bin/computerd
ENV PORT=8080 MOUNT_POINT=/workspace FUSE_MOUNT=auto
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/computerd"]
