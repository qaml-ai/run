# Provision an application

On Workers, create repos with `POST /v1/repos` and set agent mounts to
`{ repo, path, mode }`. Apply returns 400 for a `volumes` declaration,
including in dry runs. The manifest below applies to the Node runtime.

`POST /v1/apply` accepts objects keyed by resource key. Volumes are processed first, then definitions, then agents. Each group follows JSON property order. References must point to an earlier resource in the same manifest. All resources belong to the authenticated tenant.

```json
{
  "volumes": { "project": { "name": "Project files" } },
  "definitions": {
    "lead": {
      "name": "Project lead",
      "mounts": [{ "volumeId": { "$ref": "volumes.project" }, "path": "/workspace", "mode": "rw" }]
    }
  },
  "agents": { "project": { "definition": { "$ref": "definitions.lead" } } }
}
```

Call `await runtime.apply(manifest)` in TypeScript, `await runtime.apply(manifest)` with the asynchronous Python runtime, or `camelrun apply project.json`. Python's synchronous client uses `runtime.apply(manifest)`. Set `dryRun: true` or pass CLI `--dry-run` for validation without committing. The response has `volumes`, `definitions`, and `agents` maps from keys to IDs, plus `changes` entries with `resource` and `action` (`create`, `update`, or `unchanged`). Credentials are obtained separately through the existing agent credentials endpoint.

The limit is 100 resources and a 1 MiB request. Volume keys preserve the existing create-or-get behavior, including their original names. Definitions use the existing whole-configuration upsert. Existing agents must have unchanged provisioning configuration; reconfiguration returns 409. First prompts, imported/initial messages, and definition `applyOnUpdate` are refused. These operations can trigger work outside the database transaction. Use the existing single-resource APIs when they are needed.

The validation pass runs the same provisioning services in a savepoint, rolls it back, and repeats them for the commit. Failures roll back all database resources, including agent workspace volumes. Both backends use PostgreSQL; Workers uses Hyperdrive, not D1. Model runs never start during validation. Workers initializes its agent Durable Objects after commit; interrupted initialization is recovered by retrying the same manifest.

Only exact `$ref` objects are replaced. Prompt strings and `metadata` values are never interpolated. This endpoint does not introduce agent metadata support.
