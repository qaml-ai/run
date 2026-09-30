# Human input

A run can stop and wait for a person: the model asks a question, a tool needs
approval before it runs, or a tool asks for a form or a setup step. The call that
needs the person stays open and the run **suspends**: it ends with
`status: "input_required"` and the `inputs` it waits on, the agent goes to sleep
(nothing is billed while it waits), and once the last input is answered, minutes
or days later and from any process, the turn resumes. The model sees an ordinary
tool call and result, told who answered and how long it took.

```ts
let run = await agent.run("Delete the staging database", { user: "alice" });
while (run.status === "input_required") {
  const input = run.inputs[0];
  console.log(input.kind, input.message);          // "approval", "Allow db__drop to run?"
  run = await input.answer(true, { from: "alice" }); // resolves with the resumed run
}
console.log(run.text);
```

```python
run = await agent.run("Delete the staging database", user="alice")
while run.status == "input_required":
    run = await run.inputs[0].answer(True, from_="alice")
print(run.text)
```

## Where inputs come from

- **Approvals.** A tool with `needsApproval: true` (`@tool(needs_approval=True)`),
  or a function of its arguments deciding per call, is approved before each call.
  A definition's sources take an approval policy:
  `"approval": {"default": "never" | "always" | "destructive", "tools": {"delete_repo": "always"}}`
  (`destructive`: MCP tools annotated `destructiveHint`, OpenAPI operations other
  than GET, HEAD and OPTIONS; OpenAPI also takes `"methods": ["POST", "DELETE"]`).
  The person sees the real call: the tool, its source and its arguments. An
  approved call runs with exactly those arguments, and carries the approval
  (`context.identity.approval`), so a tool can require it; a declined call never
  runs.
- **Questions.** The `ask_user` built-in (`"builtins": ["ask_user"]` on the
  agent or its definition) lets the model ask 1 to 4 multiple-choice questions, with free text
  allowed where it says so.
- **The tool itself.** `context.confirm(message)`, `context.ask(message,
  schema)` (a flat form) and `context.requireUrl(url, message)` (a step on an
  https page: connect an account, sign something). An ask ends the call; once the
  person answers, the runtime calls the tool again with the same arguments and the
  ask returns the answer. **Everything before an ask runs again then**, so ask
  first and act after, and key side effects by `context.idempotencyKey`, which is
  the same on both calls.

```ts
const deleteApp = tool({
  description: "Delete an app", input: schema.Object({ app: schema.String() }),
  execute: async ({ app }, context) => {
    if (!await context.confirm(`Delete ${app}? Its URL stops working.`)) return { cancelled: true };
    return apps.delete(app, { idempotencyKey: context.idempotencyKey });
  },
});
```

Code in `js_exec` cannot wait for days: a call from code that would ask fails
with "needs the user's input: call it directly". Tools that ask are therefore
always offered to the model directly.

## Answering

`input.answer(value, { from })` takes a plain value by the input's `kind`:

| kind | value |
| --- | --- |
| `approval` | `true` to approve, `false` to decline |
| `question` | the chosen option's label (or labels, or free text where allowed); for several questions, `{ "<question>": answer, … }` |
| `form` | the fields, as an object (checked against the form's schema) |
| `url` | `true` once the person has done what the page asks, else `false` |

`input.decline()` declines any input. Answering resolves with the resumed run, or,
when the run waits on other inputs too, with the run still `input_required`
listing those. Answering the same way twice is safe; a different answer to an
input already settled is a 409 that says how it settled.

Inputs outlive your process: answer later from anywhere.

- `agent.pendingInputs()` (Python `pending_inputs()`) lists an agent's waiting
  inputs, each with `answer()`.
- `agents.runtime.inbox("pending")` lists the inputs waiting across all your
  agents, for an approvals queue.
- Over REST: `GET /v1/agents/:id/inputs?state=pending`, and `POST
  /v1/agents/:id/inputs/:inputId {action: "accept" | "decline" | "cancel",
  content?, from?}`. A question's `content` is `{answers: {"<question>":
  "<label>" | ["<label>"] | "<own words>"}}`, a form's its fields. It answers
  `{input, request}`, where `request` is the resumed run (null until the last
  input is answered): poll it like a prompt.
- `onInput` (`on_input`) on `upsert` hears each input as it is asked: return an
  answer to give it at once, or nothing to answer later.
- An MCP client talking to the agent through its [MCP endpoint](mcp-server.md)
  is asked through elicitation, when it supports it.
- The agent's events include `input_required` and `input_resolved`, and
  [webhooks](webhooks.md) `input.requested` and `input.resolved`.

## Who may answer

By default the person whose message started the turn (the run's `user`, or its
`actor`) and the definition's `humanInput.approvers`. An answer must say who is
answering (`from`) whenever the input names who may (`responders.audience`, or
the definition has approvers): the SDKs refuse to send one without it, and the
runtime refuses it with 400; a `from` who may not answer is a 403. The model has
no way to answer.

## Waiting, and giving up

- A new message to the agent supersedes its waiting inputs: their calls close
  with "Not answered: the user sent a new message instead", then the message runs.
- `agent.abort()` cancels them.
- Inputs expire after `humanInput.expiresInSeconds` (7 days by default, at most
  30). Expired and cancelled inputs close their calls and the turn without
  calling the model, unless `humanInput.onExpire` is `resume`.

```json
{"name": "Ops", "builtins": ["ask_user"], "humanInput": {"expiresInSeconds": 86400, "approvers": ["slack:U0123"]},
 "mcpServers": [{"name": "github", "url": "…", "approval": {"tools": {"delete_repo": "always"}}}]}
```

## In a channel

In Slack, Telegram or Discord, a suspended turn's reply ends with its first input
as text: a question's numbered options, the call to approve, the URL, a
confirmation. The next message from someone allowed to answer, if it fits (an
option's number or label, `approve`/`yes` or `deny`/`no`, `done`), is the answer;
anything else is a new message. See [Channels](channels.md).
