A tenant API key can set `endUser` on `POST /v1/agents/{id}/prompt` to charge
an existing end user of that tenant instead of the agent subject. Holds, usage
and settlement follow that run. New child agents inherit its payer and bucket;
later prompts without `endUser` use the agent subject. Steers cannot set it.
Batching keeps different payer selections apart. TypeScript accepts `endUser`,
Python accepts `end_user`, and the CLI accepts `--end-user`.
