### Reading many files at once, and snapshots

- `GET /v1/volumes/:id/files?content=true` returns every matching file with its contents in one answer, as the
  volume was at one seq: `{seq, files: [{path, size, version, contentType, sha256, text | data}]}`, at most 1,000
  files and 16 MiB (else 413). SDKs: `volume.readAll({ prefix, glob, snapshot })`, Python `read_all`.
- `GET /v1/volumes/:id/changes?prefix=` keeps the changes at or under a path, and `GET /v1/volumes?ids=a,b` returns up
  to 50 volumes as they are now, each with its seq (SDKs: `changes(since, { prefix })`, `runtime.volumes(ids)`).
- `snapshot=` reads a snapshot: on the listing, on `content=true`, and on `GET /v1/volumes/:id/files/{path}`
  (SDKs: `list`, `read`, `readAll` take `snapshot`).
