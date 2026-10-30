### Retries without Pi patches

Vendored Pi drops two of our patches, `GenerationHooks.beforeRetry` and `settings.retry.keepRetried`
(`1.4.0-main.f09d01b85e03-camel.2`). The host still decides every retry, now through `settings.retry` getters that Pi
reads as it classifies a failed request, and through the adapter's stream for failures Pi would not make again (a refused
forced tool choice or image, a cut lease, DeepSeek's reasoning-replay refusal). Attempts made again, the overflow Pi
compacts for, and the partial answer a lost node left in flight stay in Pi's journal marked `retried`, and out of the
history, events and billing as before. Retry events, delays and limits are unchanged.

No stored document or task version changes: this deploy can be rolled back.
