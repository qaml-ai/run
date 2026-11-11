### Model classes: camelrun/fast and camelrun/strong

Two virtual models name a class of work: `camelrun/fast` (`openrouter/meta/muse-ember`), for bulk work, and
`camelrun/strong` (`openrouter/google/gemini-4-carbon` on OpenRouter's flex service tier, half the default tier's
price), for judgment. A `strong` request sends `service_tier: "flex"`; when flex has no capacity, the Workers backend
asks again with backoff for up to `AGENT_FLEX_WAIT_SECONDS` (30 by default), then makes it on the default tier for the
rest of the turn, logged as `model_flex_fallback` and `model_flex_fallback_cost`; the Node runtime moves at once. A
response that asked flex and was served on another tier with no fallback is logged as `model_flex_unhonored`. The
tier that served a response is on its usage (`serviceTier`, and `requestedServiceTier` when one was asked), its model
attempt and its `usage.recorded` event, and the platform's price for it is that tier's. `GET /v1/models` lists each
route's tier as `serviceTiers`. Gemini 4 Carbon joins the catalog (asking for at most 32,768 output tokens, which every endpoint serves). Nothing
changes for any other model: no other request sends `service_tier`.

On the Workers backend, platform pricing now reads the same model catalog as routing: its separate copy lacked Muse
Ember, which it priced as an unknown model.
