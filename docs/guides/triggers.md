# Incoming webhook triggers

A trigger starts work when an outside service posts an event. Use a trigger for a
support ticket, deployment notification, or other one-way automation. Use
[channels](channels.md) for conversations and replies to the sending service.
[Webhooks](webhooks.md) send runtime events out to your application.

Create a trigger in **Manage agent → Triggers**, or use the SDK:

```ts
const trigger = await agent.createTrigger({
  name: "Issue triage",
  prompt: "Summarize the issue and suggest who should investigate.",
  mode: "continue",
  budget: { usd: 1 },
  verify: { type: "github", secret: process.env.GITHUB_WEBHOOK_SECRET! },
  deliveryIdHeader: "X-GitHub-Delivery",
  headers: ["X-GitHub-Event"],
  filter: { path: "action", equals: "opened" },
});
// Save trigger.url in the sending service now. Listings never return it.
```

POST `/v1/agents/{id}/triggers` accepts the same JSON. The URL has a random
256-bit token, stored only as a hash. POST to that URL without an API token.
Keep it secret even when signatures are enabled. POST
`/v1/agents/{id}/triggers/{triggerId}/rotate` returns a new URL and immediately
invalidates the old one. DELETE `/v1/agents/{id}/triggers/{triggerId}` disables it.

The `prompt` supplies the instructions. The runtime appends selected headers and
payload inside an explicitly untrusted data block, escaping its delimiters.
Bodies over 16,000 characters are uploaded as `payload.json` and attached to the
prompt. Bodies over 1 MiB receive 413. Only selected headers enter the prompt;
authorization and cookie headers cannot be selected. No payload is included in
the delivery log. Pending work retains its payload until submission or failure;
after submission the run retains its own prompt and attachment.

`mode: "continue"` prompts this agent. `mode: "fresh"` creates an agent from the
source agent's definition for each event, with a seven-day lifetime. Fresh mode
requires that the source was created from a definition. `budget: {usd: number}`
is required and becomes the prompt's spend limit. Human approval behavior still
uses the agent configuration; automatic decline for unattended triggers is not
yet implemented.

Verification operates on raw request bytes:

- `none` trusts possession of the URL.
- `github` checks `X-Hub-Signature-256` with SHA256 and `sha256=`.
- `stripe` checks `Stripe-Signature`, including its timestamp and any v1 signature.
- `slack` checks `X-Slack-Signature` and `X-Slack-Request-Timestamp` using Slack's v0 format.
- `hmac` needs `secret` and `header`. `algorithm` is `sha256` (default) or `sha1`;
  `prefix` defaults to empty. Optional `timestampHeader` signs `timestamp.rawBody`.

Timestamped signatures default to a 300-second tolerance, adjustable with
`toleranceSeconds` (1–3600). Signing secrets are sealed with the runtime secrets
key and never returned. Signatures use constant-time comparison.

`filter: {path, equals}` compares a dotted JSON path before queueing work. Ignored
events return 202. `deliveryIdHeader` deduplicates verified deliveries for 24
hours; the default is `X-GitHub-Delivery`, or the event's `id` for Stripe. Services
without delivery IDs can run more than once if they retry. `rateLimit` defaults
to 60 accepted events per trigger per minute (maximum 600); excess receives 429.
Bad signatures receive 401 and never start work.

Accepted events return 202 after durable queueing. Submission happens in the
background. GET `/v1/agents/{id}/triggers/{triggerId}/deliveries` returns the latest
100 records from the last 24 hours, with `status`, `verified`, `deduped`,
`runId` (the prompt request id), `agentId`, and a scrubbed `error`. `submitted` means the
runtime accepted the prompt, not that the model completed it. Queued work is
reclaimed after a worker crash; a deterministic request id prevents resubmission
from running the prompt twice. A submission failure is recorded as `failed`.

The TypeScript agent exposes `createTrigger`, `triggers`, `deleteTrigger`,
`rotateTrigger`, and `triggerDeliveries`. Python exposes `create_trigger`,
`triggers`, `delete_trigger`, `rotate_trigger`, and `trigger_deliveries`.

```sh
camelrun triggers add my-agent --input '{"name":"Event","prompt":"Summarize the event","budget":{"usd":1}}'
camelrun triggers list my-agent
camelrun triggers deliveries my-agent TRIGGER_ID
camelrun triggers rotate my-agent TRIGGER_ID
camelrun triggers delete my-agent TRIGGER_ID
```
