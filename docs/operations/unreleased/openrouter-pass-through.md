### Any OpenRouter model passes through

`openrouter/<id>` now works for a model not in the catalog. The runtime makes one lookup of that model (`GET /api/v1/models/{id}/endpoints`) when an agent takes it, and the agent keeps what it says: the largest context window, the longest reply every host serves, images, tool support and the dearest host's prices, which set estimates and holds. Calls are billed what OpenRouter reports.

- OpenRouter has no such model, or lists no tool support for it: a 400 when the agent is made or moved to it.
- OpenRouter out of reach: the agent starts with a 128,000-token window and 8,192-token replies, held at $3 and $15 per million. A provider's overflow compacts and asks again, as for any model.
- These models are not listed in `GET /v1/models`. `AGENT_MODEL_FALLBACKS` and `AGENT_CONTENT_FILTER_FALLBACKS` still refuse a name the catalog lacks, so a typo stops the node.
- A model that takes reasoning always gets at least `low`, with no `temperature`: the lookup does not say whether it can turn reasoning off, and a third of OpenRouter's models answer a 400 to that.
