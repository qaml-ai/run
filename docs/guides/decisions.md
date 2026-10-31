# Decisions

`POST /v1/decisions` answers typed questions about a state (a message, a record, a document) with a decision model:
yes/no, one of a set of options, or a level on a scale, each with calibrated probabilities instead of text. It is
fast (a few hundred milliseconds) and cheap (about $0.00002 for three questions about a short message), so it suits
moderation, routing, triage, and classifying or scoring a dataset. Every agent has the `decide` tool by default (from
`js_exec`, `tools.decide`); see [In an agent](#in-an-agent) for who doesn't and how to opt out.

Decisions run on TypeSafe's Jev (`typesafe/jev-1.14`), through OpenRouter's decisions API, with the OpenRouter key a
model call of yours would use: a [key scope](models-and-keys.md#key-scopes)'s, your own
(`PUT /v1/providers/openrouter/key`), else the platform's, which a prepaid account pays for at what OpenRouter charges.

## Asking about one state

```bash
curl -X POST "$RUNTIME/v1/decisions" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{
  "state": "hey can someone help me reset my password? i keep getting locked out",
  "questions": {
    "is_support": { "type": "noul", "instructions": "The message asks for account or technical help." },
    "topic": { "type": "choice", "instructions": "Main topic of the message.",
               "criteria": { "billing": "payments, invoices", "account": "login, password, access", "bug": "something broken", "other": "" } },
    "toxicity": { "type": "score", "instructions": "How abusive the message is.",
                  "criteria": ["not at all", "mildly rude", "insulting", "hateful or threatening"] }
  }
}'
```

```json
{
  "model": "typesafe/jev-1.14-20261014",
  "answers": {
    "is_support": { "type": "noul", "noul": 0.99 },
    "topic": { "type": "choice", "choice": "account", "confidence": 1, "probabilities": { "billing": 0, "account": 1, "bug": 0, "other": 0 } },
    "toxicity": { "type": "score", "score": 0, "confidence": 1, "probabilities": [1, 0, 0, 0] }
  },
  "usage": { "inputTokens": 444, "outputTokens": 77 }, "costUsd": 0.000018648, "ms": 310
}
```

| Question | Fields | Answer |
| --- | --- | --- |
| `noul` | `instructions`: a yes/no question or statement; `criteria?`: `{true?, false?}`, what counts as yes and as no (a side left out: yes is the statement itself, no is anything else) | `noul`: the probability it is true |
| `choice` | `instructions`: what to decide; `criteria`: `{option: description}`, 2 to 255 (an empty description judges the option by its name) | `choice`, the likeliest option; `confidence`; `probabilities` by option |
| `score` | `instructions`: what to rate; `criteria`: 2 to 10 levels, lowest first | `score`, the expected level from 0 (may be fractional); `confidence`; `probabilities` by level |

Ask every question about a state in one request: they are answered together, for about the price of one. Question
ids are yours (letters, digits, `_` and `-`), at most 32 a state.

Probabilities are calibrated, so act on them with thresholds (block at 0.95, flag at 0.8) rather than on the top
answer alone. Tune thresholds on your own data, for the model you pinned: another model's probabilities differ.

| Field | |
| --- | --- |
| `state` | text, or JSON (an object or array): at most 64,000 characters |
| `questions` | the questions, by id |
| `items` | a batch instead: 1 to 100 `{state, questions}` (below) |
| `model` | `typesafe/jev-1.14` (default) or `typesafe/jev-1.13`: a pinned version, so answers do not shift under your thresholds |
| `maxUsd` | refuse (402) before anything is sent if the estimate is more |
| `keyScope` | a key scope whose OpenRouter key goes first (not its `baseUrl`: decisions always go to OpenRouter) |
| `dataCollection` | `"deny"`: only hosts that do not keep the state (sent on as OpenRouter's `provider.data_collection`; TypeSafe, Jev's only host, serves it). An agent's `decide` calls carry its own `dataCollection` |
| `subject`, `context`, `actor`, `bucket` | who it is for, who asked, and the end user's credit bucket, as for an agent's runs |

## Batches

`items` asks about up to 100 states in one request, each with its own questions. They are answered in parallel, one
provider call per state (within your account's [decision concurrency](#throughput); the rest wait), and the answer lists
each item's `answers`, or its `error`, in order: one item failing does not fail the others, and is not billed.

```json
{ "items": [ { "state": "first message", "questions": { "spam": { "type": "noul", "instructions": "This is spam." } } },
             { "state": "second message", "questions": { "spam": { "type": "noul", "instructions": "This is spam." } } } ] }
```

```json
{ "model": "typesafe/jev-1.14-20261014", "results": [ { "answers": { "spam": { "type": "noul", "noul": 0.02 } }, "usage": { "inputTokens": 120, "outputTokens": 12 }, "costUsd": 0.000005 },
                                                     { "error": { "status": 400, "code": "DECISION_REFUSED", "message": "…" } } ],
  "usage": { "inputTokens": 120, "outputTokens": 12 }, "costUsd": 0.000005, "ms": 290 }
```

A call the provider fails for now (rate limited, overloaded, or no answer within 10 seconds) is retried up to 3 times
with backoff, honouring its Retry-After; a request answers within 60 seconds. A request's body is at most 2 MB.
Nothing is cached: send each distinct state once. Neither states nor answers are logged or kept.

### Throughput

Each state is one provider call, and an account makes at most its **decision concurrency** of them at once on a
runtime node: 16 by default, more on higher [usage tiers](../reference/limits.md#usage-tiers) (32 on Tier 1, 48 on
Tier 2, 64 from Tier 3), or what the operator set for the account. A node makes at most 64 at once for everyone
(`AGENT_DECISION_NODE_CONCURRENCY`), and an account's concurrency is never more than that. A batch takes one slot per
item, so it does not raise the ceiling. At Jev's typical 300 ms a call, 16 at once is about 50 decisions a second per
node, and 48 about 160.

Calls past it wait their turn. An account's waiting calls and the characters its requests hold are bounded on each
node: 1,000 waiting and 8 million characters at the default concurrency, scaled up with a higher one (3,000 and 24
million at 48), the characters at most the node's 32 million. Past them a request is refused with 429 `RATE_LIMITED`
before its body is read. `GET /v1/limits` has the account's `decisionConcurrency`, and where it comes from.

The operator sees a `decision_wait` metric line (tenant, how many calls of the request waited past 250 ms, the
longest wait, the queue's depth) and a `decision_load` gauge (calls in flight and waiting, per account), so an
account nearing its ceiling shows before it gets 429s. Operators set an account's concurrency with
`decisionConcurrency` (its tenants-file entry, or `PUT /v1/tenants/{id}/limits`; null returns to the tier's).

The provider answers one state a call, with all of its questions answered in parallel: asking several questions about a
state in one call is the way to get more from a call. Neither OpenRouter's decisions API nor TypeSafe's own takes
several states in one call.

## In an agent

Every agent has the `decide` tool, with no builtin to list: it asks directly (`{state, questions}` or `{items}`, as
above), and from `js_exec` as `tools.decide`. The exceptions:

- An agent with no `js_exec` (`codeMode: false`) and no tools of its own, and a run with no tools at all, have none
  unless they ask for it (`decide: true`).
- `decide: false` on an agent (`POST /v1/agents`, `PATCH /v1/agents/{id}/configuration`; `null` goes back to the
  default), a run, or a definition (for its agents) opts out.
- It is not offered where it could only fail: on an account with no OpenRouter key decisions can use (your own, a key
  scope's, or the platform's). An agent whose `dataCollection` is `deny` has it, and its calls carry that policy.

The tool adds about 300 tokens to each request's tool list (cached with the rest of the prompt). Listing `decide` in
`builtins` is accepted and changes nothing.

```js

```js
const questions = { spam: { type: "noul", instructions: "This message is spam." } };
let spam = 0;
for (let start = 0; start < rows.length; start += 100) {
  const { results } = await tools.decide({ items: rows.slice(start, start + 100).map(row => ({ state: row.text, questions })) });
  for (const result of results) if (!result.error && result.answers.spam.noul > 0.9) spam++;
}
```

One `tools.decide` call takes up to 100 states; a script may have several in flight (`Promise.all` over a few chunks),
within js_exec's limits (256 tool calls and 30 seconds by default per execution, 128 KB of arguments a call). For more
than one execution holds, loop executions over files in the workspace. What the calls cost counts against the agent's
and the run's spend limits (the run's `usage.decisionCostUsd`), and the run's budget is checked against each call's
estimate before it is sent.

## Errors

| Status | Code | |
| --- | --- | --- |
| 400 | | a malformed request, said before anything is sent |
| 400 | `DECISION_REFUSED` | the provider refused the request (its reason, without your state) |
| 400 | `DECISIONS_UNAVAILABLE` | no OpenRouter key for this account |
| 400 | `DECISIONS_DATA_POLICY` | `dataCollection: "deny"` (the request's, or the agent's), and no host serves the model without collecting data |
| 402 | `SPEND_LIMIT` | the estimate is more than `maxUsd` or the run's budget |
| 413 | `DECISION_TOO_LARGE` | a state over 64,000 characters, or a state and its questions over 96,000 |
| 429 | `RATE_LIMITED` | too many decisions waiting for the account on a node |
| 502 | `DECISION_FAILED`, `DECISIONS_UNAVAILABLE` | the provider failed after retries, or its decisions API (in alpha) is unavailable |

## Cost

`costUsd` is what OpenRouter charged. On your own OpenRouter key that is all, and the runtime charges nothing. On the
platform's key a prepaid account (and an end user's credit) pays it times the OpenRouter credit multiplier, as for
model calls on that key (see [Pricing](../pricing.md)). A provider answer that reports neither a cost nor tokens is
billed at the request's estimate, never at nothing. Jev is $0.042 per million input tokens, and output is free. Each question adds about 100
tokens of the provider's own prompt to the state's, so three questions about a short message come to about 450 tokens
($0.00002). Usage shows decisions as their own kind (`decision`, `responses` counting the questions answered), and each
request is a `usage.recorded` event with `decisions`.
