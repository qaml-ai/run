### Claude Sonnet 5.5 cache reads at Anthropic's price

- Fixes the known issue in 0.6.0's notes: Claude Sonnet 5.5's cache reads (`anthropic/claude-sonnet-5-5`, and through
  Cloudflare's AI Gateway) are priced at $0.10 per million tokens, Anthropic's price, not Pi's catalog's $0.20, for
  usage, spend limits, billing and `GET /v1/models`. Agents made before keep counting the right price too. On builder
  workloads (about 94% cache reads) Sonnet 5.5 responses were recorded about 29% above what Anthropic bills. Bedrock's
  entry is unchanged: Bedrock publishes no price for it yet.
