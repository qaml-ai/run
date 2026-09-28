# Production checklist

Before you ship an application on the runtime, check each of these.

## Keys and access

- [ ] Your API key is only on your servers, in a secret store, never in a
      browser, a mobile app or a repository. Browsers get [browser
      tokens](guides/browser.md), minted per user after your own access checks.
- [ ] An agent's token (`agent.session.token`) is secret too. You rarely need it:
      upsert by key instead. The SDKs keep it out of logs and JSON; do not print it
      yourself.
- [ ] Tools authorize every call as `context.identity.user` within
      `identity.context`, never from ids in the model's arguments. `subject` and
      `context` are set when the agent is made. See [Identity](guides/tools.md#identity-who-a-call-is-for).
- [ ] Served tools verify the runtime's token (`serveTools`, `serve_tools`,
      `runtimeAuth` do), and behind a TLS-terminating proxy the audience is your
      public URL (`nodeListener` reads `X-Forwarded-Proto`/`Host`; or pass
      `origin`). Test with `testRuntime()`.

## Agents

- [ ] Agents are keyed by your ids (`upsert("user-123", …)`), so any process finds
      them and a retry never makes a second. Keyed agents live until deleted:
      delete the ones you no longer need (`agent.delete()`), e.g. when the user or
      thread is deleted.
- [ ] Configuration lives in one place: the `upsert` call (or a definition, with
      `apply: "all"` to roll changes out). Fields fixed at creation (`subject`,
      `context`, `definition`, `mounts`) are a 409 if they change; handle that as
      "delete and recreate" only where you mean it.
- [ ] You pick a model your account has a key for, and set `spendLimit` on agents
      that act for untrusted users.

## Tools

- [ ] Every tool with side effects passes `context.idempotencyKey` to what it
      calls, so a retried or re-run call acts once.
- [ ] Long tools set `timeoutMs` and report `context.progress()`; nothing relies
      on a call finishing within the default 15 seconds.
- [ ] Tools that ask a person (`needsApproval`, `context.confirm/ask`) ask
      before they act: everything before an ask runs again once answered.
- [ ] Where tools run matches how you deploy: a long-lived process attaches
      them; serverless or several instances serve them over HTTP. Agents woken by
      schedules, channels or webhooks use served tools, or nobody may be there to
      answer (`toolErrors` with `not_connected`).
- [ ] Exactly one process attaches an agent's tools. Others run it with
      `attach: false` (or without tools). A process that loses them
      (`APPLICATION_REPLACED` on `onError`) keeps running the agent without them.

## Runs

- [ ] You reply to users from the run's result (`run.text`), not from the event
      stream. The stream is for display.
- [ ] Failures are handled: `run()` throws `RunError` (with `code`, and
      `uncertain` when a restart cut the run short); `run.toolErrors` lists tool
      calls that did not complete.
- [ ] Runs that wait on people (`status: "input_required"`) are shown to someone
      who can answer, or answered from your inbox (`agents.runtime.inbox("pending")`
      and the `input.requested` webhook). Inputs expire after 7 days by default.
- [ ] Retries reuse the run's `idempotencyKey`, so a request retried after a
      timeout observes the same run instead of starting another.
- [ ] Waits have a bound where your caller needs one (`signal`, Python
      `timeout=`), knowing the run goes on; `agent.abort()` stops it.
- [ ] `onEvent` handlers are quick or queue their work; they run in order, apart
      from the connection, and their errors go to `onError`.

## Operations

- [ ] Your process closes its agents on shutdown (`await agents.close()`, or
      `await using`), so it exits promptly and releases the agents' tools.
- [ ] You register a [webhook](guides/webhooks.md) endpoint for `run.failed` and
      `input.requested` (and `usage.recorded` to meter spend), verify signatures,
      dedupe by event `id`, and answer within 10 seconds.
- [ ] You handle 429 and 503 by waiting `Retry-After` (the SDKs retry them),
      and know the [limits](reference/limits.md) your workload approaches.
- [ ] Serverless: set `stateDirectory` only to a writable path (the default keeps
      the stream's cursor in memory, which is all it needs), and prefer served
      tools.
