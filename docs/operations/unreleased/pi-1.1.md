### Pi 1.1: Claude Haiku 5.5, Bedrock inference profiles

- The runtime runs on Pi 1.1 (`@earendil-works/pi-ai` and `pi-agent-core` 1.1.0). New in the catalog: Claude Haiku 5.5
  (`anthropic/claude-haiku-5-5`, and on Bedrock `amazon-bedrock/global.anthropic.claude-haiku-5-5` and its `us.`,
  `eu.`, `au.` and `jp.` profiles), and Claude Sonnet 5.5's `us.` and `eu.` profiles on Bedrock. Haiku 5.5's prompts
  over 100,000 tokens are priced higher, as Anthropic prices them.
- Bedrock serves Anthropic's models only through inference profiles: a base id (`amazon-bedrock/anthropic.claude-sonnet-5`)
  is no longer listed in `GET /v1/models`, and an agent that names one is called through its global profile (its US
  one where it has no global one).
- A Claude model that always reasons on Anthropic's API does on Bedrock too (Haiku, Sonnet and Opus 5.5, Opus 5,
  Fable): a call asking for no reasoning gets the least it takes, as on Anthropic.
- History's assistant messages carry `durationMs` (how long the response took) and tool results theirs (how long
  the tool ran) ([events](../reference/events.md)).
- Context estimates count 3.5 characters a token (4 before), so compaction starts a little earlier on text-heavy history.
- Anthropic tool changes mid-conversation use the `inline-tools-2026-09-15` beta; Bedrock's Claude 5 calls bind thinking to
  their prompt, dropping stale thinking blocks after the tools or system prompt change instead of failing.
- The provider `azure-openai-responses` is now `azure`, as Pi names it.
