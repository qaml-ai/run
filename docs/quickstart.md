# Quickstart

In five minutes you will have an agent that runs in the hosted runtime, calls a
tool in your own process, and answers you. The runtime keeps the model loop, the
agent's history and its files; your tools stay in your code, with your
credentials.

## 1. Get an API key

Sign in to the console at <https://run.camelai.com/console>, then:

- under **Models & keys**, check that a model is marked *Usable*. New accounts
  start with credit for the platform's models. Or you can add your own provider
  key.
- under **API tokens**, create a token, and export it:

```sh
export CAMELAI_API_KEY=art_...
```

The key can create and control every agent in your account. Keep it on your
server and never ship it to a browser.

## 2. Install

TypeScript (Node 22 or later, or Bun):

```sh
npm install @camelai/run
```

Python (3.11 or later):

```sh
pip install camelai-run
```

## 3. Run an agent

TypeScript, `quickstart.ts`:

```ts
import { Agents, schema, tool } from "@camelai/run";

const agents = new Agents(); // reads CAMELAI_API_KEY

// A tool is an ordinary function: it runs here, in your process.
const weather = tool({
  description: "Today's weather in a city",
  input: schema.Object({ city: schema.String() }),
  execute: ({ city }) => ({ city, forecast: "sunny", highC: 24 }),
});

// The same key is the same agent, with its history, every time you run this.
const agent = await agents.upsert("quickstart", {
  model: "anthropic/claude-sonnet-5-5",
  instructions: "You are a concise assistant.",
  tools: { weather },
});

const run = await agent.run("Should I bring an umbrella in Lisbon today?");
console.log(run.text);

await agents.close();
```

```sh
npx tsx quickstart.ts
```

Python, `quickstart.py`:

```python
import asyncio
from camelai_run import Agents, tool

@tool
def weather(city: str) -> dict:
    """Today's weather in a city"""
    return {"city": city, "forecast": "sunny", "highC": 24}

async def main():
    async with Agents() as agents:  # reads CAMELAI_API_KEY
        agent = await agents.upsert("quickstart", model="anthropic/claude-sonnet-5-5",
                                    instructions="You are a concise assistant.", tools=[weather])
        run = await agent.run("Should I bring an umbrella in Lisbon today?")
        print(run.text)

asyncio.run(main())
```

```sh
python quickstart.py
```

curl (the agent has no tools of yours here: tools that run in your process need an
SDK, or a server of your own, see [Tools](guides/tools.md)):

```sh
BASE=https://run.camelai.com; AUTH="Authorization: Bearer $CAMELAI_API_KEY"
# The Idempotency-Key is the agent's key: the same key is the same agent.
AGENT=$(curl -s $BASE/v1/agents -H "$AUTH" -H "Content-Type: application/json" -H "Idempotency-Key: quickstart" \
  -d '{"model": "anthropic/claude-sonnet-5-5", "systemPrompt": "You are a concise assistant."}' | jq -r .id)
REQ=$(curl -s $BASE/v1/agents/$AGENT/prompt -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"text": "Write a haiku about durable agents."}' | jq -r .id)
until curl -s $BASE/v1/agents/$AGENT/requests/$REQ -H "$AUTH" | jq -e '.state == "completed"' > /dev/null; do sleep 1; done
curl -s $BASE/v1/agents/$AGENT/requests/$REQ -H "$AUTH" | jq -r '.outcome.result.reply // .outcome.error'
```

If you see `No ... API key configured`, pick a model your account can use:
`GET /v1/models?available=true`, or the console's **Models & keys**.

## 4. Stream it

`run()` waits for the whole run. To show it as it happens, `stream()` yields its
text as the model writes it, each tool call and result, and last the run:

```ts
for await (const part of agent.stream("And tomorrow?")) {
  if (part.type === "text") process.stdout.write(part.text);
  if (part.type === "tool_call") console.log(`\n[${part.name}(${JSON.stringify(part.arguments)})]`);
  if (part.type === "done") console.log(`\n(${part.run.status})`);
}
```

```python
async for part in agent.stream("And tomorrow?"):
    if part.type == "text":
        print(part.text, end="", flush=True)
    elif part.type == "tool_call":
        print(f"\n[{part.name}({part.arguments})]")
```

The run's result is the truth; the stream is for display. A stream that breaks
never loses the run: `run()` (or `stream.result()`) still resolves with it.

## What just happened

- `upsert("quickstart", …)` made a keyed agent, or found the one made last time
  and brought it to this configuration. It lives until you delete it, so running
  the file again continues the same conversation. See [Concepts](concepts.md).
- Because the agent has `tools`, this process served them: the runtime called
  `weather` here, over the connection the SDK holds. One process at a time serves
  an agent's tools. A serverless function or a multi-user backend serves tools
  over HTTP instead; see [Tools](guides/tools.md).
- `run()` resolved with a `Run`: `status` (`completed`, `input_required` or
  `failed`), `text`, `inputs`, `error`, `toolErrors`. A failed run throws a
  `RunError` unless you pass `throwOnError: false` (`throw_on_error=False`).
- `agents.close()` let the process exit. The agent stays in the runtime.

Next: [Concepts](concepts.md), then the guide for what you are building:
[tools](guides/tools.md), [asking people](guides/human-input.md),
[showing an agent in a browser](guides/browser.md), [files](guides/files.md),
[agents for many users](guides/multi-user.md), [webhooks](guides/webhooks.md).
Before you ship, read the [production checklist](production.md).
