# Webhooks

The runtime can tell your server when runs start and end, when an agent asks a
person for input, and what each model response cost, so you react without
holding a connection open. Register an endpoint with the event types it wants:

```http
POST /v1/webhooks
Authorization: Bearer $CAMELAI_API_KEY

{"url": "https://example.com/hooks/agents", "events": ["run.completed", "run.failed", "input.requested"], "description": "prod"}
```

The answer carries the endpoint's `id` (`we_…`) and its signing `secret`
(`whsec_…`), shown only then. `GET /v1/webhooks` lists your endpoints (at most
16); `GET`, `PATCH` and `DELETE /v1/webhooks/:id` read, change and remove one;
`POST /v1/webhooks/:id/secret` replaces its secret (the old one also signs for 24
hours).

Each endpoint's `setBy` says who last set it: `token:<API token id>`, `console`,
`operator`, or `oauth:<grant id>` for one an OAuth app set before they no longer
could (null: set before this was recorded). An endpoint keeps sending when the
token that set it is revoked: revoking one answers with `left`, the endpoints
(and usage webhook and trace export) it set, so you can review them. OAuth apps
cannot create or change webhooks.

## Events

Every event is an envelope:

```json
{"id": "evt_3f9c0a1b2c3d4e5f60718293", "type": "run.completed", "created": 1790000000,
 "data": {"agentId": "client_…", "requestId": "…", "method": "prompt", "metadata": {"source": "web"},
          "replyIndex": 3, "messageCount": 4,
          "usage": {"responses": 2, "input": 2300, "output": 140, "cacheRead": 0, "cacheWrite": 0, "costUsd": 0.0081}}}
```

| Type | When | `data` |
| --- | --- | --- |
| `run.started` | A run (`method`: `prompt`, `continue`, `resume`, `execute`) began | `agentId`, `requestId`, `method`, `actor`, `metadata`; `resumes` when a node resumed a turn whose node was lost |
| `run.completed` | It ended without an error | as above, and `usage`; `stopped` (`input_required` with `inputIds`, `spend_limit` or `turn_limit`) if it stopped early; `replyIndex` and `messageCount`; `steeredInto` for a message a running turn took |
| `run.failed` | It ended with an error, the runtime's or the model's | as above, and `usage`, `error`, `code` where the error has a name (`cancelled`: a stop cancelled it before it began; `aborted`; `model_stream_stalled`; `turn_limit`…), and `uncertain` when a restart cut it short |
| `input.requested` | The agent asks a person for input (the run waits) | `agentId`, `requestId`, `inputId`, `toolCallId`, `kind`, `expiresAt` |
| `input.resolved` | An input settled | `agentId`, `requestId`, `inputId`, `state` |
| `usage.recorded` | A model response's usage was counted, a transcription's, or images' | `agentId`, `requestId`, `subject`, `actor`, `context`, `keyScope`, `provider`, `model`, `kind` (`response`, `compaction`, `transcription` or `image`), tokens, `audioSeconds` (a transcription's, with no tokens), `images` (how many images were made), `cost: {usd, source}`, `at`. A [transcription](voice.md) made with `POST /v1/transcriptions`, or [images](images.md) made with `POST /v1/images`, has `agentId: null`, and the `subject`, `context` and `actor` it was sent with. Treat a `kind` you do not know as other usage: kinds may be added |
| `billing.balance.low` | Funded balance crosses below the alert threshold (default $2) | `balance`, `previousBalance`, `threshold` (integer micro-USD), `source` |
| `billing.balance.depleted` | Positive balance reaches zero or below | Same balance fields |

Billing events are recorded in the transaction that changes the balance, including
usage, storage, refunds and adjustments. Remaining below a threshold does not
repeat the event; recovering above it allows a later crossing to notify again.
One charge can emit both types. A new account with no credit emits neither.
A threshold change can emit `billing.balance.low` with `source: "threshold_changed"`
and no `previousBalance`; ordinary crossings have `source: "balance"`.

- Payloads are small: ids and the key facts. Read the rest with your API key: the
  run (`GET /v1/agents/:id/requests/:requestId`, with its reply in
  `outcome.result.reply`), history, or inputs. `metadata` is what the message that
  started the run carried, so you can route an event without a lookup.
- `created` is in Unix seconds. An event's `data` only gains fields; a change you
  could not ignore comes as a new type.
- An endpoint receives the runs that begin after it is made.

## Verifying and handling

Requests are signed per [Standard Webhooks](https://www.standardwebhooks.com/):
`webhook-id` (the event's `id`), `webhook-timestamp` (Unix seconds) and
`webhook-signature`, `v1,<base64 HMAC-SHA256 of "<id>.<timestamp>.<body>">` keyed
with the secret's base64 part (space-separated when two secrets sign during a
rotation). Any Standard Webhooks library verifies them:

```ts
import { Webhook } from "standardwebhooks";
const event = new Webhook(process.env.WEBHOOK_SECRET!.replace(/^whsec_/, "")).verify(body, headers) as WebhookEvent;
```

(`WebhookEvent` is typed in `@camelai/run`.) In Python, `verify_webhook` checks
the signature in constant time and that the request was sent within 5 minutes,
and returns the event; pass the raw body, before parsing it:

```python
from camelai_run import WebhookVerificationError, verify_webhook

@app.post("/hooks/agents")  # Flask; in Django, request.body and request.headers
def hook():
    try:
        event = verify_webhook(request.get_data(), request.headers, os.environ["WEBHOOK_SECRET"])
    except WebhookVerificationError:
        return "", 400
    queue.put(event)
    return "", 200
```

During a rotation, pass both secrets as a list. The SDKs also manage endpoints:
`create_webhook(url, events)`, `webhooks()`, `update_webhook`, `delete_webhook`
and `rotate_webhook_secret` on `AgentRuntime` (Python).

- Delivery is at least once. Answer 2xx within 10 seconds; anything else is
  retried with exponential backoff, from 5 seconds to an hour apart, for 3 days.
- Dedupe by `id` (a retried event keeps it), and order by `created`: retries can
  reorder deliveries.
- Do the work after answering: queue it, then return 200.

## Continuing from a webhook

A handler can act on the agent itself. Send your own ids as `metadata` with each
message; they come back on the run's events, so the handler finds the agent by
its key without a lookup:

```ts
// When the message was sent: agent.run(text, { metadata: { thread: thread.id } })
if (event.type === "run.failed" && event.data.metadata?.thread) {
  const agent = await agents.upsert(`thread-${event.data.metadata.thread}`, config);
  await agent.run("The last step failed; tell the user what happened and what to try.");
}
```

A serverless handler that upserts without local tools never contends with the
process serving the agent's tools; see [Concepts](../concepts.md#processes-and-connections).

## The usage webhook (deprecated)

Before endpoints, `PUT /v1/usage-webhook {"url"}` set one URL that receives each
model response's usage in its own body (not an envelope). It still works, but
new integrations should register an endpoint for `usage.recorded` instead.
