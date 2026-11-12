#!/usr/bin/env bash
# On a sprite: MinIO (the S3/R2 stand-in) on loopback, the tests with replication on, then the bench; the
# replicated server stays up on :8080 for SERVE_MINUTES so bench/client.ts can run from another sprite.
set -euo pipefail
cd "$(dirname "$0")/.."
here=$PWD
uname -m; nproc; free -g | head -2; df -h "$HOME" | tail -1; git --version; node --version
bin=$HOME/.cache/gitsvc/minio
if [ ! -x "$bin" ]; then mkdir -p "$(dirname "$bin")"; curl -fsSL -o "$bin" https://dl.min.io/server/minio/release/linux-amd64/minio; chmod +x "$bin"; fi
data=$(mktemp -d "$HOME/gitsvc-minio-XXXX")
export MINIO_ROOT_USER=gitsvcbench MINIO_ROOT_PASSWORD=$(head -c 18 /dev/urandom | base64 | tr -d '/+=')
"$bin" server "$data" --address 127.0.0.1:9000 --console-address 127.0.0.1:9001 >"$data.log" 2>&1 &
minio=$!
trap 'kill $minio 2>/dev/null; rm -rf "$data" "$data.log"' EXIT
for i in $(seq 1 60); do curl -fsS http://127.0.0.1:9000/minio/health/ready >/dev/null 2>&1 && break; sleep 0.5; done
export S3_ENDPOINT=http://127.0.0.1:9000 S3_BUCKET=gitsvc S3_ACCESS_KEY_ID=$MINIO_ROOT_USER S3_SECRET_ACCESS_KEY=$MINIO_ROOT_PASSWORD
node --experimental-strip-types --disable-warning=ExperimentalWarning -e '
const { S3Client, CreateBucketCommand } = await import("@aws-sdk/client-s3");
await new S3Client({ endpoint: process.env.S3_ENDPOINT, region: "auto", forcePathStyle: true, credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY } }).send(new CreateBucketCommand({ Bucket: "gitsvc" })).catch(() => {});'
echo "== tests (replication on)"
node --experimental-strip-types --disable-warning=ExperimentalWarning --test test/gitsvc.test.ts
echo "== bench"
BENCH_DIR=$HOME node --experimental-strip-types --disable-warning=ExperimentalWarning bench/bench.ts
