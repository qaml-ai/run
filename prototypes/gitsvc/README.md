# proto/gitsvc: camelRun volumes on stock git, run as a service

Prototype only (not wired into the runtime). `DESIGN.md` is the design, `RESULTS.md` the numbers.

- `src/server.ts` — auth proxy over `git http-backend` + JSON API (refs CAS, commit via fast-import, merge via merge-ort, blob, tree, gc)
- `src/replicate.ts`, `hooks/` — the replication gate (packs + ref manifest to S3/R2 before any ref moves), restore, sweep
- `src/token.ts` — HMAC tokens (read / write with ref prefixes / admin)
- `src/core/` — the volume object core from `proto/artifacts-volumes`, unchanged except `store.ts`
- `npm test` (from this directory, with the repo's node_modules); `bench/sprite-server.sh` via `scripts/sprite-test` runs the bench with a bucket
