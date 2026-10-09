### Projects: restore in place, and checks that hand on what they computed

- `POST /v1/volumes/:id/restore {snapshot}` makes a volume as a snapshot of it was, in place: files the snapshot
  lacks are removed and files that differ are written back, in one write, each a change agents mounting it see.
  SDKs: `volume.restore(snapshot)`, and `project.restore(version)` for a published version.
- A project's `validate` may return `{problems, data}`: `data` reaches `store` as `checked` and comes back in the
  publish result (and `publishTool`'s `published`), so what the check computed (a bundle, its manifest) is not
  computed again. Both SDKs.
- The projects guide shows `publishTool`'s `project(identity)` for an agent whose mounts change during its life: look
  up its current mounts (`runtime.mounts(identity.agent)`).
- Fix: `publishTool` called by a client that sends no idempotency key (`_meta["agent-runtime/idempotencyKey"]`) took
  the JSON-RPC id as the publish's key, so a later call with the same id (every call of `testRuntime().callTool`,
  which sent id 1) stored the first publish's files again. Only a key that outlives the request dedupes now, and
  `callTool` / `call_tool` send a fresh key per call (`idempotencyKey` / `idempotency_key=` to repeat one). Both SDKs.
