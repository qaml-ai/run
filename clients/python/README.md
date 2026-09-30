# camelai-run

The Python SDK for camelRun: durable agents you upsert by key
and run, with tools that are ordinary functions in your code. The runtime runs
the model loop, keeps each agent's history and files, and runs model-written
code in a sandbox that can only call your tools.

```sh
pip install camelai-run
```

Python 3.11 or later. Get an API key from the console at
<https://run.camelai.com/console> and export it as `CAMELAI_API_KEY`.

```python
import asyncio
from camelai_run import Agents, tool

@tool
def weather(city: str) -> dict:
    """Today's weather in a city"""
    return {"city": city, "forecast": "sunny", "highC": 24}  # runs here, in your process

async def main():
    async with Agents() as agents:
        agent = await agents.upsert("quickstart", model="anthropic/claude-sonnet-5-5",
                                    instructions="You are a concise assistant.", tools=[weather])
        run = await agent.run("Should I bring an umbrella in Lisbon today?")
        print(run.text)

asyncio.run(main())
```

- **Keyed agents.** `upsert(key, ...)` makes the agent for your key, or brings the
  existing one to the configuration given; its history and files last until you
  delete it.
- **Runs.** `run()` returns a `Run` (`status`, `text`, `inputs`, `error`,
  `tool_errors`) and raises `RunError` on failure (unless `throw_on_error=False`).
  No timeout unless you pass `timeout=`. `agent.stream()` yields text, tool calls
  and results as they happen, then the run.
- **Tools.** `@tool` takes async or plain functions (plain ones run in a thread),
  `timeout=` in seconds, and `needs_approval=True`. `context.idempotency_key` is
  stable across retries; `context.progress("...")` reports progress.
- **People in the loop.** `await run.inputs[0].answer(True, from_="alice")` resumes
  a run waiting on approval.
- **Events.** `on_event` may be a plain or an async function; it runs in order,
  apart from the connection. `close()` stops it: events still queued are dropped.

Documentation: [Quickstart](https://run.camelai.com/docs/quickstart.md),
[Concepts](https://run.camelai.com/docs/concepts.md),
[SDK reference](https://run.camelai.com/docs/reference/sdk.md),
and all of it as Markdown at <https://run.camelai.com/llms.txt>.

## Serving tools to many users

When one server answers tools for many users' agents, serve them over HTTP and let
the runtime say who each call is for. `serve_tools` is an ASGI app that verifies the
runtime's signed identity token on every request and hands each call a
`context.identity`:

```sh
pip install "camelai-run[server]"
```

```python
from camelai_run import ToolContext, serve_tools, tool

@tool
async def list_todos(context: ToolContext) -> dict:
    """The current user's to-dos"""
    who = context.identity  # user (the actor, else the agent's subject), subject, tenant, agent, context
    return {"todos": await db.todos(user=who.user, team=who.context["team"])}

# tenant: yours (GET /v1/me): tokens for other tenants' agents, which may claim any user, are refused.
app = serve_tools([list_todos], runtime="https://run.camelai.com", tenant="acme")  # uvicorn, or mount in FastAPI
```

Name the server in a definition with `mcpServers=[{"name": "todos", "url": ..., "auth": {"type": "runtime"}}]`,
create agents with `subject=` and `context=`, and run them with `user=`.
The same `@tool` functions get the same identity when attached to an agent.
`verify_runtime_token(token, runtime=..., tenant=..., audience=...)` checks a token on its own,
and `TestRuntime()` signs tokens for tests: `await TestRuntime().call_tool(app, url, "list_todos", {}, subject="alice")`.

Keep the API key on your backend: it can create and control every
agent in your tenant. Sign in at https://run.camelai.com/console to add provider
keys, create API tokens and watch agents. The TypeScript SDK is
[`@camelai/run`](https://www.npmjs.com/package/@camelai/run).

## Asking the user

A tool marked `@tool(needs_approval=True)` is approved before each call; inside a
tool, `context.confirm(message)`, `context.ask(message, schema)` and
`context.require_url(url, message)` ask the user. The run then returns with
`status == "input_required"`, and answering its inputs resumes it:

```python
@tool
async def delete_app(app: str, context: ToolContext) -> dict:
    """Delete an app"""
    # Ask first: the call ends here, and runs again with the answer.
    if not await context.confirm(f"Delete {app}? Its URL stops working."):
        return {"cancelled": True}
    return await apps.delete(app, idempotency_key=context.idempotency_key)

agent = await agents.upsert("ops", tools=[delete_app])
run = await agent.run("Delete the demo app", user="alice")
while run.status == "input_required":
    run = await run.inputs[0].answer(True, from_="alice")
```

Everything in a tool before an ask runs again when the user answers.
`agent.pending_inputs()` lists what an agent waits on, and
`agents.runtime.inbox(state="pending")` what all your agents do.
