### Pinned snapshots and labels

- A snapshot can be pinned, at create (`pinned: true`) or later with `PATCH /v1/volumes/:id/snapshots/:id
  {pinned, labels}`. A pinned snapshot is kept until unpinned: publish's pruning passes it by, it counts against
  10,000 pinned snapshots instead of the 100 others, and `DELETE` refuses it (409) unless `?force=true`. Deleting a
  volume deletes its pinned snapshots too. Migration 060 runs on start.
- Snapshots take `labels`, a string map of your own (16 at most), set at create or by `PATCH`, and returned with them;
  `GET /v1/volumes/:id/snapshots?label=key:value` (repeatable) lists those that have them.
- `POST /v1/volumes/:id/snapshots {files}` makes a snapshot of the files given (path to text, or `{data}` in base64; at
  most 1,000 files and 16 MiB), leaving the volume and its seq untouched: for bringing in versions kept elsewhere. It
  is made whole or not at all, and answers each file's `sha256` (`contents`) to check against what was sent.
- SDKs: `volume.snapshot({ pinned, labels, files })`, `snapshots({ labels })`, `updateSnapshot`, `deleteSnapshot(id,
  { force })`; `project.publish({ pin, labels })`, `project.versions({ labels })`, `project.pin(version, labels?)` and
  `project.unpin(version)` (Python: the same, snake_case).
