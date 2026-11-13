# camelfsd for the api tier (infra/camelfs/terraform/ecs.tf): the one Go binary, cross-compiled on the build
# machine's own architecture for the target's (Graviton: linux/arm64), on a slim Debian with CA certificates and
# nothing else. Build from the repository root:
#   docker buildx build --platform linux/arm64 -f infra/camelfs/Dockerfile -t camelfsd .
# infra/camelfs/deploy.sh does this and pushes the result.
#
# CGO is on: the daemon links SQLite (internal/refs, the host-local caches), so the build stage installs the
# target's GNU toolchain rather than emulating the target.

ARG BASE_REGISTRY=public.ecr.aws/docker/library

FROM --platform=$BUILDPLATFORM ${BASE_REGISTRY}/golang:1.24-bookworm AS build
ARG TARGETARCH
RUN set -eux; case "$TARGETARCH" in \
      arm64) gnu=aarch64-linux-gnu; deb=arm64 ;; \
      amd64) gnu=x86-64-linux-gnu; deb=amd64 ;; \
      *) echo "unsupported TARGETARCH $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    apt-get update; apt-get install -y --no-install-recommends "gcc-$gnu" "libc6-dev-$deb-cross"; \
    rm -rf /var/lib/apt/lists/*; \
    echo "${gnu//x86-64/x86_64}-gcc" > /cc
WORKDIR /src
COPY camelfsd/go.mod camelfsd/go.sum ./
RUN go mod download
COPY camelfsd/ ./
RUN --mount=type=cache,target=/root/.cache/go-build \
    CC="$(cat /cc)" CGO_ENABLED=1 GOOS=linux GOARCH=$TARGETARCH \
    go build -trimpath -ldflags "-s -w" -o /camelfsd ./cmd/camelfsd

FROM ${BASE_REGISTRY}/debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1000 camelfs && useradd --uid 1000 --gid 1000 --no-create-home --shell /usr/sbin/nologin camelfs \
    && mkdir -p /var/lib/camelfs && chown camelfs:camelfs /var/lib/camelfs
COPY --from=build /camelfsd /usr/local/bin/camelfsd
USER camelfs
# The role and its flags come from the task definition's command (api_command) and environment (CAMELFS_*).
ENTRYPOINT ["/usr/local/bin/camelfsd"]
