### Definitions that reach live agents

- `applyOnUpdate: true` on a definition: every save that makes a new revision (an upsert that changes it, or a
  `PATCH`) also applies it to every live agent made from it, as `apply: "all"` does, and the answer carries
  `applied` (`POST /v1/definitions` answers with it too). An upsert that changes nothing applies nothing. See
  [Definitions](../guides/definitions.md).
