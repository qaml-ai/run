### Model failures say how they failed

- A run that a model call failed has `errorClass` (`billing`, `rate_limit`, `server`, `refusal`, `auth`, `timeout`,
  `other`), `providerStatus` (the provider's HTTP status, when known), `retryable` (whether the runtime retries such a
  failure itself) and `model` (`provider/model-id`) on its `error`, beside `code` and `message`, which are unchanged.
  The `run.failed` webhook carries them too, and the stream's events for a failed response (`message_end`) and its
  retries (`auto_retry_start`, `auto_retry_end`) as `failure`. A fallback no longer has to parse the message for a 402
  or a 429 ([Model failures](../reference/errors.md#model-failures)).
- A run's result has `servedModel`, the model that made its last response; so do `run.completed` and `run.failed`.
- The `ErrorClass` metric dimension has a `refusal` class, and a quota used up that a provider sends as a 429
  (OpenAI's `insufficient_quota`) counts as `billing`, not `rate_limit`.
