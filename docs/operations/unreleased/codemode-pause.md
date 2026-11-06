### Code pauses for people

A call from a `codemode` script that needs a person (an approval policy, a judged call the judge escalates,
`ask_user`, an MCP server's `input_required` or older -32042, an attached tool's `context.confirm`/`ask`) now pauses
the turn as a direct call does, instead of failing with "call it directly". The run ends `input_required`; each input's
`toolCallId` is `<codemode call>/c<n>`. The agent unloads while it waits (no code slot, memory or model call). The
answer's `resume` run goes on with the script: calls it had finished are not made again, and the call that asked starts
again with its answer. Calls that ask together are one suspension. An input no one answers in time gets the runtime's
automatic answer, and the script goes on (an approval rejects as a declined one does). Inputs closed by an abort, and
a new message instead of an answer end the `codemode` call as aborted. The runtime's script deadline does not count the
wait; a script's own `timeout_ms` does (a deadline from its start): an answer after it does not make the call. Nor does one for a script that cannot resume (its sandbox changed, as across a deploy that changes v8-exec): the call that asked runs only once its script, started again, makes it again. `ask_user` and tools needing approval are callable from code, and an approval
policy no longer makes a code-only tool declared to the model.
