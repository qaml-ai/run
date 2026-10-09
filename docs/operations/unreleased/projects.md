### Projects

- `POST /v1/volumes {key}`: the tenant's volume for a key, made the first time and the same one every time after
  (`existing: true`), for as long as it lives; a deleted one's key makes no other. SDKs: `createVolume({ key })`,
  Python `create_volume(key=)`.
- TypeScript SDK: `runtime.projects.create({ key, template })`, `project.mount(path)`, `project.publish({ validate,
  store })` (snapshot, read every file at it, check, store; the snapshot is the version), `project.versions()`, and
  `publishTool(...)` for `serveTools`, which finds the project from the call's identity. Python: `camelai_run.projects`
  (`Projects`, `publish_tool`). See [Projects](../guides/projects.md).
