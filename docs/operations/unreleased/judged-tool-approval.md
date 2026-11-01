### Judged tool approvals

A definition's MCP servers and OpenAPI sources take a fourth approval policy:
`"approval": {"default": "judged"}` (or `judged` for one tool in `tools`). Before
each call, the runtime asks the decision model (`typesafe/jev-1.14`, the one
`decide` uses) whether the call is an ordinary reversible step toward the
request. An ordinary call runs with no person in the loop; a call that may
irreversibly delete or rewrite what already existed, write to production or
change permissions asks the person, as `always` does; a call that would send
credentials, secrets or private data out of the user's systems is denied before
it runs, and the model reads that denial as the call's result. A judge that
cannot answer — no OpenRouter key, a spent spend limit, a provider failure, an
answer it cannot read, or arguments or a description past what it is shown —
asks the person, so a judged call never runs unjudged; so does a turn with no
request of its own (a prompt sent with no text), since a request is the only
thing that can authorize a call.
A denial is not remembered: the next call is judged on its own, and shows in a
run's outcome as `tool_error`. A resumed turn is judged against the request that
started it, not against nothing.

A judged call costs about $0.00003 (Jev bills input tokens at $0.042 a million)
and is billed as a decision is, under `kind: "decision"`, with an end user's
credit holding and settling it when they pay. The judge sees the request's start
and end (2,000 characters), the 4,000-character description the model is shown,
and 8,000 characters of the call's arguments; past those it asks rather than
guessing. Each decision logs `tool_judged` (tool, decision, risk, and why it
asked), never the request, the arguments or the answer. Judged tools are
declared to the model directly, since code in `js_exec` cannot wait for a person.

Implementation: `src/tool-judge.ts` (the questions and the decision table),
`src/tool-sources.ts` (the gate), the judge is built per session in
`src/client-sessions/spend.ts` (`judgeFor`). Limits: `JUDGE_LIMITS` in
`src/limits.ts`.
