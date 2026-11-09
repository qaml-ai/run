### Provision keyed resources together

`POST /v1/apply`, the SDK's `apply(manifest)`, and `camelrun apply file.json` provision keyed volumes, definitions, and agents in a PostgreSQL transaction. `dryRun: true` validates with the ordinary upsert paths and returns IDs and create/update/unchanged actions without committing. References use `{"$ref":"volumes.key"}` or `{"$ref":"definitions.key"}`.

This initial implementation provisions new agents and accepts unchanged agents. It refuses reconfiguration of existing agents, initial messages, first prompts, and definition `applyOnUpdate`. Use the existing configuration endpoints for those operations. Model and provider preparation runs before the tenant apply lock. Database ownership, conflicts, and rate limits are checked again in the transaction. Workers reserves creation capacity before committing and initializes volume and agent Durable Objects from the committed records afterward. Unchanged agents receive no configuration update. Retry the same manifest if initialization fails.

No migration is required. Existing individual provisioning calls are unchanged.
