### Any model OpenRouter lists works without a catalog entry

`openrouter/<id>` now works for any model on OpenRouter's list that supports tools, including ones released after this runtime was built. The runtime reads `GET https://openrouter.ai/api/v1/models` in the background at start and hourly, and again when a request names a model it lacks, at most once a minute. Context window, longest reply, images, reasoning levels and prices come from that list; a model already in the catalog keeps its catalog entry. Calls are billed what OpenRouter reports; the listed prices set estimates and holds.

- A model OpenRouter lists without tool support gets a 400 saying so when an agent is made, configured or a definition saved.
- These models are in `GET /v1/models` with `toolCallStreaming: false`.
- `AGENT_OPENROUTER_MODELS_URL` changes the list's address, and empty turns it off. If it cannot load, the built-in catalog works as before.
