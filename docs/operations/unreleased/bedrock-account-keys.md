### Bedrock API keys for the whole account, and their region

- `PUT /v1/providers/amazon-bedrock/key` takes `{apiKey, region}`: an account's own Bedrock API key (a bearer token)
  and the AWS region its calls go to (it was refused as needing AWS credentials). The console's Models page asks for
  the region, and `GET /v1/providers` shows it. Migration 059 runs on start.
- Fix: a key scope entry's Bedrock `region` now reaches the call. Before, Pi's client took the region from the
  runtime host's `AWS_REGION` (or the catalog's `us-east-1`), unless the entry's `baseUrl` was a regional endpoint.
- Bedrock takes Bedrock API keys only: no AWS access keys or SigV4, never the host's AWS credentials. See
  [Amazon Bedrock](../guides/models-and-keys.md#amazon-bedrock).
