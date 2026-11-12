# s3speed

```sh
go vet ./...
go test ./...
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /tmp/s3speed .
/tmp/s3speed upload --bucket BUCKET --prefix s3speed/50m --chunks 200 --layouts chunk,pack1m,pack4m --concurrency 64
/tmp/s3speed fetch --bucket BUCKET --prefix s3speed/50m --chunks 200 --mode chunk --concurrency 64 --out /tmp/chunks --csv-header
/tmp/s3speed fetch --bucket BUCKET --prefix s3speed/50m --chunks 200 --mode pack1m --concurrency 64 --subset 0.1 --out /tmp/packs
/tmp/s3speed fetch --bucket BUCKET --prefix s3speed/50m --chunks 200 --mode pack4m --concurrency 64 --out /tmp/packs
/tmp/s3speed fetch --bucket BUCKET --prefix s3speed/50m --chunks 200 --mode range4m --concurrency 64 --subset 0.1 --out /tmp/ranges --cold-client --keep
/tmp/s3speed latency --bucket BUCKET --prefix s3speed/50m --n 200 --size-kib 4 --csv-header
/tmp/s3speed cleanup --bucket BUCKET --prefix s3speed/50m
```
