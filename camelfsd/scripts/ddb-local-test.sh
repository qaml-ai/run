#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
image=amazon/dynamodb-local@sha256:1856c05cc66a0e49dc1099e483ad2851477eeebe2135250ac11a1d1227db54b1
endpoint=http://127.0.0.1:8000
# Host networking: a sprite cannot start a bridge container whose image runs as non-root (scripts/sprite-test-core.sh).
container=$(docker run -d --network host "$image" -jar DynamoDBLocal.jar -inMemory -sharedDb -port 8000)
trap 'docker rm -f "$container" >/dev/null' EXIT

for ((attempt = 0; attempt < 60; attempt++)); do
    # An unsigned GET gets an HTTP error once DynamoDB is ready to serve.
    if curl -s --max-time 1 -o /dev/null "$endpoint"; then
        CAMELFS_DDB_LOCAL="$endpoint" go test -count=1 ./internal/refstore/... ./internal/ddb/... ./internal/delivery/...
        exit
    fi
    sleep 1
done
docker logs "$container" >&2
exit 1
