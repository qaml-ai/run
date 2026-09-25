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

Keep the operator or API token on your backend: it can create and control every
agent in your tenant. Sign in at https://agents.camelai.dev/console to add provider
keys, create API tokens and watch agents. The TypeScript SDK is
[`@camelai/agent-runtime`](https://www.npmjs.com/package/@camelai/agent-runtime).
