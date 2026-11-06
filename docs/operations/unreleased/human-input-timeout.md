### Inputs no one answers get an automatic answer after 15 minutes

An input (a tool approval, `ask_user`, an MCP form or URL step, an attached tool's `context.confirm`/`ask`, from a
direct call or from code) now waits 15 minutes by default instead of 7 days. Then the runtime always answers for the
person and the turn goes on with the model:

- an approval is never given. The call does not run, and its result (an error) is "The user did not respond in a timely
  manner, so this call was not approved and did not run. Continue without it, or ask again later.";
- `ask_user` returns `{"answers": {}, "timedOut": true, "message": "The user did not respond in a timely manner.
  Continue. …"}`;
- a tool's own request is cancelled: the tool is not called again, and its result says the request was cancelled.

Each text ends "(An automatic answer from the runtime after <wait> without a response: the user did not write this.)".
A call from code gets the same answer, and its script goes on. The input's state is `expired` with `answer.by`
`{system: "expired"}`, as before; a later answer is a 409 that says the input expired. `humanInput.expiresInSeconds`
still takes 60 seconds to 30 days. Definitions that set `expiresInSeconds` keep their wait, but now resume the model
when it ends.

`humanInput.onExpire` is gone: there is no mode that closes the turn on expiry any more. A definition or agent that
sends it is refused (400, as any unknown field); one stored with it loads as before, and
the field is ignored. Aborted and superseded inputs close their calls as before.
