### Projects: restore in place, and checks that hand on what they computed

- `POST /v1/volumes/:id/restore {snapshot}` makes a volume as a snapshot of it was, in place: files the snapshot
  lacks are removed and files that differ are written back, in one write, each a change agents mounting it see.
  SDKs: `volume.restore(snapshot)`, and `project.restore(version)` for a published version.
- A project's `validate` may return `{problems, data}`: `data` reaches `store` as `checked` and comes back in the
  publish result (and `publishTool`'s `published`), so what the check computed (a bundle, its manifest) is not
  computed again. Both SDKs.
- The projects guide shows `publishTool`'s `project(identity)` for an agent whose mounts change during its life: look
  up its current mounts (`runtime.mounts(identity.agent)`).
