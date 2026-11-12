#!/usr/bin/env bash
# On a sprite: an S3/R2 stand-in (MinIO, else SeaweedFS) on loopback, the tests with replication on, then the bench; the
# replicated server stays up on :8080 for SERVE_MINUTES so bench/client.ts can run from another sprite.
set -euo pipefail
cd "$(dirname "$0")/.."
here=$PWD
uname -m; nproc; free -g | head -2; df -h "$HOME" | tail -1; git --version; node --version
# MinIO's binary downloads are gone (410); the last published image is fine for a stand-in. --network host: the
# sprite's Docker cannot do -p for this image reliably, and loopback is what we want anyway.
export MINIO_ROOT_USER=gitsvcbench MINIO_ROOT_PASSWORD=$(head -c 18 /dev/urandom | base64 | tr -d '/+=')
docker rm -f gitsvc-minio >/dev/null 2>&1 || true
if ! docker run -d --name gitsvc-minio --network host -e MINIO_ROOT_USER -e MINIO_ROOT_PASSWORD \
  quay.io/minio/minio:RELEASE.2025-04-22T22-12-26Z server /data --address 127.0.0.1:9000 --console-address 127.0.0.1:9001 >/dev/null; then
  # Fallback stand-in: SeaweedFS's S3 gateway (no identities configured = accepts any signed request).
  docker rm -f gitsvc-minio >/dev/null 2>&1 || true
  docker run -d --name gitsvc-minio --network host chrislusf/seaweedfs:3.80 server -dir=/data -ip=127.0.0.1 -volume.port=8081 -s3 -s3.port=9000 >/dev/null
  echo "S3 stand-in: SeaweedFS"
else echo "S3 stand-in: MinIO"; fi
trap 'docker rm -f gitsvc-minio >/dev/null 2>&1' EXIT
for i in $(seq 1 60); do curl -sS -o /dev/null http://127.0.0.1:9000/ >/dev/null 2>&1 && break; sleep 0.5; done
export S3_ENDPOINT=http://127.0.0.1:9000 S3_BUCKET=gitsvc S3_ACCESS_KEY_ID=$MINIO_ROOT_USER S3_SECRET_ACCESS_KEY=$MINIO_ROOT_PASSWORD
node --experimental-strip-types --disable-warning=ExperimentalWarning -e '
const { S3Client, CreateBucketCommand } = await import("@aws-sdk/client-s3");
await new S3Client({ endpoint: process.env.S3_ENDPOINT, region: "auto", forcePathStyle: true, credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY } }).send(new CreateBucketCommand({ Bucket: "gitsvc" })).catch(() => {});'
echo "== tests (replication on)"
node --experimental-strip-types --disable-warning=ExperimentalWarning --test test/gitsvc.test.ts
echo "== bench"
BENCH_DIR=$HOME node --experimental-strip-types --disable-warning=ExperimentalWarning bench/bench.ts
