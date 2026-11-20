### CamelRun v2: copy large v1 histories in bounded requests

The migration tools accept `--chunked` when copying into a fresh private
destination. Each request carries at most 1 MiB and keeps tool calls with their
results. The importer checks the offset and the previous receipt before writing
the next chunk. Existing staging verification checks the finished copy before
routing traffic to it.
