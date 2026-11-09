### Incoming webhook triggers

Agents can accept one-way webhook events through random, rotatable URLs. Triggers
support signed deliveries, JSON filters, deduplication, rate limits, spend limits,
and fresh agents from definitions. Manage them with the API, SDKs, CLI, or the
console Triggers tab. See `docs/guides/triggers.md`.

Ingress checks body size before database access and rate-limits rejected requests.
Generic HMAC also accepts base64; Slack challenges and retry identities are
supported. Token-less hook URLs use `X-Camelrun-Hook-Token`. Failed submissions
retry with bounded backoff, and live fresh run agents are capped at 200 per trigger.
