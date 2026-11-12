# proto/search

Trigram code search over content-addressed snapshots: per-blob shards, snapshot = shard list + path table,
O(1) forks, delta shards at checkpoints. Read [DESIGN.md](DESIGN.md) and [RESULTS.md](RESULTS.md).

```sh
go test .                                                    # vs a brute-force oracle: checkpoints, forks, merge, compaction
go build -o camelsearch .
./camelsearch index -store st -repo ~/src/linux -commit HEAD -ref main
./camelsearch search -store st -snap main -regex -context 2 'kmalloc\(.*GFP_ATOMIC'
./camelsearch serve -store st -addr :7700                    # GET /v1/snapshots/{ref}/search?q=…&regex=1&path=…
scripts/sprite-test HEAD bash prototypes/search/bench/run.sh gen,k8s,linux   # every RESULTS.md measurement
```
