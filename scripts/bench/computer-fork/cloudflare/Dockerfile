# Workspace image for the fork benchmark. IMAGE_REV changes the image version
# so the harness can test whether an older snapshot restores after a redeploy.
FROM node:24-trixie-slim
ARG IMAGE_REV=1
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates fio procps util-linux bc \
 && rm -rf /var/lib/apt/lists/* && echo "$IMAGE_REV" > /etc/bench-image-rev
WORKDIR /
CMD ["sleep", "infinity"]
