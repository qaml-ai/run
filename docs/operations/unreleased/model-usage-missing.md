### Model calls that end without usage are billed an estimate, not the whole context window

A model call that completed normally but reported no token counts and no cost (an OpenAI-style stream that ended between
its finish and its usage chunk) was billed on prepaid tenants as if it read the model's whole context window and wrote its
longest reply, and was free to end users on unbilled tenants and tenants' own keys. It is now billed as a call cut short
is: the input the host estimated at its begin (kept on the attempt, `estimated_input_tokens`) and the characters it
streamed at two a token.

- The tenant's ledger and the end user are charged that estimate, marked `estimated`. OpenRouter calls stay `estimated`
  and reconciliation replaces the estimate with the provider's figure; calls on providers with no reconciliation are
  final at the estimate.
- An end user is never charged more for an estimated call (completed or cut short) than the call held; with its hold
  gone, the estimate itself.
- Unbilled tenants and tenants' own keys charge their end users the estimate instead of nothing.
- Compaction summaries without usage use the same estimate in the run's accounting (`compaction_usage`).
- Each such call logs `model_usage_missing` once (tenant, provider, model, served host, completed or not, whether a
  generation id exists, billed and held). `infra/terraform/alarms.tf` adds the `model-usage-missing` metric filter
  and alarm (10 in 5 minutes); they take effect at the next `tofu apply`.

No migration (`model_attempts.estimated_input_tokens` exists since migration 073).
