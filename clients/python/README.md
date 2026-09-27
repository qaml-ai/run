# camelai-agent-runtime

Python SDK for the camelAI hosted agent runtime. Your application defines tools as
ordinary functions; the runtime runs the model loop, keeps each agent's history,
and executes model-written code in a sandbox that can only call your tools.
Tool calls come back to your process, so your data and credentials never leave it.

Requires Python 3.11 or later.

```sh
pip install camelai-agent-runtime
```

```python
import asyncio, os
from camelai_agent_runtime import AgentRuntime, tool

@tool
async def open_tickets():
    """List open support tickets."""
    return await db.open_tickets()

async def main():
    async with AgentRuntime(url="https://agents.camelai.dev", api_key=os.environ["AGENT_RUNTIME_TOKEN"]) as runtime:
        agent = await runtime.create_agent(
            name="Support triage", model="anthropic/claude-sonnet-5",
            system_prompt="You triage support tickets. Be concise.",
            idempotency_key="support-triage", tools=[open_tickets],
        )
        await agent.prompt("Which open tickets look urgent?")

asyncio.run(main())
```

## Events

`on_event` gets the agent's events as they stream. Since 0.3.0 a `message_update`
is its delta alone (`event["assistantMessageEvent"]["delta"]` for text), without
the message it updates, and a stream that cannot replay starts with a
`{"type": "snapshot", "turn": ...}` of the running turn (see "Deltas and
snapshots" in the runtime's `clients/README.md`).

## Serving tools to many users

When one server answers tools for many users' agents, serve them over HTTP and let
the runtime say who each call is for. `serve_tools` is an ASGI app that verifies the
runtime's signed identity token on every request and hands each call a
`context.identity`:

```sh
pip install "camelai-agent-runtime[server]"
```

```python
from camelai_agent_runtime import ToolContext, serve_tools, tool

@tool
async def list_todos(context: ToolContext) -> dict:
    """The current user's to-dos"""
    who = context.identity  # user (the actor, else the agent's subject), subject, tenant, agent, context
    return {"todos": await db.todos(user=who.user, team=who.context["team"])}

app = serve_tools([list_todos], runtime="https://agents.camelai.dev")  # uvicorn, or mount in FastAPI
```

Name the server in a definition with `mcpServers=[{"name": "todos", "url": ..., "auth": {"type": "runtime"}}]`,
create agents with `subject=` and `context=`, and prompt with `from_=` or `actor=`.
The same `@tool` functions get the same identity when attached to an agent.
`verify_runtime_token(token, runtime=..., audience=...)` checks a token on its own,
and `TestRuntime()` signs tokens for tests: `await TestRuntime().call_tool(app, url, "list_todos", {}, subject="alice")`.

Keep the operator or API token on your backend: it can create and control every
agent in your tenant. Sign in at https://agents.camelai.dev/console to add provider
keys, create API tokens and watch agents. The TypeScript SDK is
[`@camelai/agent-runtime`](https://www.npmjs.com/package/@camelai/agent-runtime).

## Asking the user

A turn can wait for a person, for as long as it takes. A tool marked
`@tool(needs_approval=True)` is approved by the user before each call, shown as
the runtime sees it; inside a tool, `context.confirm(message)`,
`context.ask(message, schema)` and `context.require_url(url, message)` ask the
user. `prompt()` then returns `{"stopped": "input_required", "inputs": [...]}`,
and answering the last input resumes the turn:

```python
@tool
async def delete_app(app: str, context: ToolContext) -> dict:
    """Delete an app"""
    # Ask first: the call ends here, and runs again with the answer.
    if not await context.confirm(f"Delete {app}? Its URL stops working."):
        return {"cancelled": True}
    return await apps.delete(app, idempotency_key=context.call_id)

agent = await runtime.create_agent(tools=[delete_app], on_input=lambda input: None)  # or return {"action": "accept"}
run = await agent.prompt("Delete the demo app")
if run.get("stopped") == "input_required":
    await agent.answer(run["inputs"][0]["id"], action="accept", content={})
```

Everything in a tool before an ask runs again when the user answers. `agent.inputs(state="pending")`
lists what an agent waits on, and `runtime.inbox(state="pending")` what all your agents do.
