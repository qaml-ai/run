### An operator's entry key is the tenant's key: it never charges credit

A key in a tenant's tenants-file entry (`apiKeys`) is now billed like a key the tenant stored itself. A
`"billing": "prepaid"` entry was charged credit, with OpenRouter's funding multiplier, for model calls (turns, compaction,
tool ranking) and for decisions, transcription, images, speech and realtime voice made on its entry's keys, as if they
were the platform's. Only a key from the top-level `platformKeys` (and the platform's Azure deployments and Anthropic
federation) charges credit now, on Node and Workers alike; web search and page rendering already followed this rule.

Calls on entry keys also stop counting as platform usage in `/v1/usage` (`platformResponses`, `platformCost`) for
unbilled admin tenants; their `cost`, and the model-spend metrics, are unchanged. Entries without `apiKeys`, and
`"billing": "none"` entries (the default), are charged exactly as before. See `docs/operations/billing.md`.
