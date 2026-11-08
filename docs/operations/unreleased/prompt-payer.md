### A tenant can bill one prompt's run to an end user (endUser)

A tenant API key can set `endUser` on `POST /v1/agents/{id}/prompt` to charge
an existing end user of that tenant instead of the agent subject. Holds, usage
and settlement follow that run. TypeScript accepts `endUser`, Python accepts
`end_user`, and the CLI accepts `--end-user`.

Child tasks, their completion notifications and messages bill the sending run's
payer and bucket, including messages to existing children. Their tool identity
stays the owner's. A steer joins only a turn with the same payer selection;
otherwise it starts a separate turn. Batching keeps different payer selections
apart. Later prompts without `endUser`, and background work outside a prompt's
run, bill the agent's subject. An override payer's bucket is not inherited by
later subject-paid runs.

The low-level `steer` request keeps idle input for the next prompt: matching
payers share its turn; other payers run separately afterward. The SDKs keep
this behavior when `client.steer` has no explicit payer.
