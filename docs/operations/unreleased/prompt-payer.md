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

The low-level `steer` request now uses prompt admission too: when idle or when
the payer differs, it starts its own turn instead of holding input for a future
turn. The SDKs' `client.steer` follows the same rule.
