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
invalidates the old one.

Our application logs do not record hook paths or tokens. Platform request logs
(such as a proxy, load balancer, or hosting provider) may include the URL. If the
sender supports custom headers, use the token-less URL `/v1/hooks` and put the
token in `X-Camelrun-Hook-Token`. Extract it from the one-time URL's final path
segment, or use **Copy header token** in the console. Configure platform logs to
redact that header too. Token rotation invalidates both forms.

DELETE `/v1/agents/{id}/triggers/{triggerId}` disables it.

The `prompt` supplies the instructions. The runtime appends selected headers and
payload inside an explicitly untrusted data block, escaping its delimiters.
Bodies over 16,000 characters are uploaded as `untrusted-webhook-payload.json`
and attached to the prompt. The prompt identifies the attached file as untrusted too. Bodies over 1 MiB receive 413. Only selected headers enter the prompt;
`Authorization`, `Cookie`, and `X-Camelrun-Hook-Token` cannot be selected. No payload is included in
the delivery log. Pending work retains its payload until submission or failure;
after submission the run retains its own prompt and attachment.

`mode: "continue"` prompts this agent. `mode: "fresh"` creates an agent from the
source agent's definition for each event, with a seven-day lifetime. Fresh mode
requires that the source was created from a definition. `budget: {usd: number}`
is required and becomes the prompt's spend limit. A trigger has at most 200 live
fresh run agents, including reservations being provisioned. Tenant run and agent
limits are checked before provisioning. The shared fresh-run adapter owns this
admission path. Human approval behavior still uses the agent configuration until
the unattended-policy integration is available; the trigger submission hook
requests `humanInput.unattended: "decline"` when that adapter is installed.

Verification operates on raw request bytes:

- `none` trusts possession of the URL.
- `github` checks `X-Hub-Signature-256` with SHA256 and `sha256=`.
- `stripe` checks `Stripe-Signature`, including its timestamp and any v1 signature.
- `slack` checks `X-Slack-Signature` and `X-Slack-Request-Timestamp` using Slack's v0 format.
- `hmac` needs `secret` and `header`. `algorithm` is `sha256` (default) or `sha1`;
  `prefix` defaults to empty. Optional `timestampHeader` signs `timestamp.rawBody`.

Timestamped signatures default to a 300-second tolerance, adjustable with
`toleranceSeconds` (1–3600). Generic HMAC accepts hexadecimal or standard base64 signatures with the configured
prefix. Signing secrets are sealed with the runtime secrets
key and never returned. Signatures use constant-time comparison.

`filter: {path, equals}` compares a dotted JSON path before queueing work. Ignored
events return 202. `deliveryIdHeader` deduplicates verified deliveries for 24
hours against queued or submitted work; filtered, rate-limited, and permanently
failed submissions never suppress a sender's retry. The default is
`X-GitHub-Delivery`, the event's `id` for Stripe, or `event_id` for Slack.
Slack `url_verification` challenges return the signed challenge without starting
a run. `X-Slack-Retry-Num` is never used as an event identity. Services
without delivery IDs can run more than once if they retry. `rateLimit` defaults
to 60 accepted events per trigger per minute (maximum 600); excess receives 429.
Bad signatures receive 401 and never start work or create delivery rows. The
view includes an aggregate rejection counter instead. Ingress counters apply to
all attempts, including bad signatures: at most 600 per token and 1,200 per client
IP each minute on the receiving Node process or Workers isolate. Counters have a
bounded number of entries; a full counter table refuses new sources until a new
minute. The durable per-trigger work rate limit still applies across receivers.
An excessive `Content-Length` is rejected before any database access.

Accepted events return 202 after durable queueing. Submission happens in the
background, never in the POST handler. GET `/v1/agents/{id}/triggers/{triggerId}/deliveries` returns the latest
100 records from the last 24 hours, with `status`, `verified`, `deduped`,
`runId` (the prompt request id), `agentId`, and a scrubbed `error`. `submitted` means the
runtime accepted the prompt, not that the model completed it. Queued work is
reclaimed after a worker crash; a deterministic request id prevents resubmission
from running the prompt twice. Transient submission errors retry internally up to five attempts, with delays of
30 seconds, one minute, two minutes, and five minutes. Payloads stay queued during
backoff and are discarded only after acceptance or terminal failure. Permanent
errors fail immediately; exhausted retries are recorded as `failed`. `attempts`
and `nextAt` expose retry progress. Workers maintenance dispatches up to four
submissions concurrently and scans separately from other maintenance jobs.

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
