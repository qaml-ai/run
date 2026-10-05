# Quickstart

In five minutes you will have an agent that runs in the hosted runtime, calls a
tool in your own process, and answers you. The runtime keeps the model loop, the
agent's history and its files; your tools stay in your code, with your
credentials.

**With a coding agent.** Paste this into Claude Code, Codex, Cursor or any coding
agent. It asks you what the agent should do, installs the SDK, finds your API
key without you pasting it into chat, and runs your first agent:

```text
Read https://run.camelai.com/SKILL.md and set up camelRun in this project. Ask me what the agent should do.
```

**Try it with no API key.** Connect your coding agent to the hosted MCP server.
Signing in with GitHub or Google creates your account:

```sh
claude mcp add --transport http camelrun https://run.camelai.com/mcp   # then /mcp in Claude Code
codex mcp add camelrun --url https://run.camelai.com/mcp && codex mcp login camelrun
```

Then ask it to "use camelrun to build me my first agent". See the
[CLI and MCP server](reference/cli.md).

**Credit.** GitHub accounts older than 30 days start with free credit. Everyone
else (Google sign-ins, newer GitHub accounts) unlocks the same credit by verifying
a card on the console's **Billing** page. The card is not charged.

To build it into your app yourself, read on.

## 1. Get an API key

Sign in to the console at <https://run.camelai.com/console> with GitHub or Google.
Under **API keys** (<https://run.camelai.com/console/tokens>), create a key,
and export it:

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

TypeScript, `quickstart.mts` (`.mts` makes it an ES module, which top-level
`await` needs; in a project with `"type": "module"`, `.ts` works too):

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
  instructions: "You are a concise assistant.",
  tools: { weather },
});

const run = await agent.run("Should I bring an umbrella in Lisbon today?");
console.log(run.text);

await agents.close();
```

```sh
npx tsx quickstart.mts
```

Python, `quickstart.py`. The Python SDK is async-only: call it from `async`
code, and from synchronous code (a script, a Django view, a Celery task) with
`asyncio.run(...)`:

```python
import asyncio
from camelai_run import Agents, tool

@tool
def weather(city: str) -> dict:
    """Today's weather in a city"""
    return {"city": city, "forecast": "sunny", "highC": 24}

async def main():
    async with Agents() as agents:  # reads CAMELAI_API_KEY
        agent = await agents.upsert("quickstart", instructions="You are a concise assistant.", tools=[weather])
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
  -d '{"systemPrompt": "You are a concise assistant."}' | jq -r .id)
REQ=$(curl -s $BASE/v1/agents/$AGENT/prompt -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"text": "Write a haiku about durable agents."}' | jq -r .id)
# ?wait=25 answers as soon as the run ends (or after 25 s, still running: ask again).
until RUN=$(curl -s "$BASE/v1/agents/$AGENT/requests/$REQ?wait=25" -H "$AUTH") && jq -e '.state == "completed"' <<< "$RUN" > /dev/null; do :; done
jq -r 'if .status == "failed" then "failed: \(.error)" else .outcome.result.reply end' <<< "$RUN"
```

The agent names no model, so it uses your account's default: the first of the
platform's default models your account can use. To choose one (optional), list
the models you can use, and pass one as `model`:

```sh
npx -y @camelai/camelrun models --available
# or, without Node:
curl -s "https://run.camelai.com/v1/models?available=true" -H "Authorization: Bearer $CAMELAI_API_KEY" | jq -r '.[].id'
```

```ts
const agent = await agents.upsert("quickstart", { model: "<a model id from that list>", instructions: "…" });
```

```python
agent = await agents.upsert("quickstart", model="<a model id from that list>", instructions="…")
```

A model your account can't use fails the run with code `model_key_missing`, and
an error that says which key to set: pick one from that list, or add the
provider's key under **Models & keys**.

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
stream = agent.stream("And tomorrow?")
async for part in stream:
    if part.type == "text":
        print(part.text, end="", flush=True)
    elif part.type == "tool_call":
        print(f"\n[{part.name}({part.arguments})]")
    elif part.type == "done":
        print(f"\n({part.run.status})")
run = await stream.result()  # the same run as "done" has, also after a stream that broke off
```

The run's result is the truth; the stream is for display. A stream that breaks
never loses the run: `run()` (or `stream.result()`) still resolves with it.

## What just happened

- `upsert("quickstart", …)` made a keyed agent, or found the one made last time
  and brought it to this configuration. It lives until you delete it, so running
  the file again continues the same conversation. See [Concepts](concepts.md).
- Because the agent has `tools`, this process served them: the runtime called
  `weather` here, over the connection the SDK holds. One process at a time serves
  an agent's tools, and only while it runs. Serverless functions, several web
  workers or task workers, and multi-user backends serve tools over HTTP
  instead, which also keeps them working through deploys; see [Several
  processes, workers and deploys](guides/tools.md#several-processes-workers-and-deploys).
- `run()` resolved with a `Run`: `status` (`completed`, `input_required` or
  `failed`), `text`, `inputs`, `error`, `toolCalls` (Python `tool_calls`: each
  tool it called), `toolErrors` (Python `tool_errors`). A failed run throws a
  `RunError` unless you pass `throwOnError: false` (`throw_on_error=False`). A
  `completed` run can still list tool errors, e.g. `connection_lost` when the
  process serving its tools went away mid-call: check them.
- `agents.close()` let the process exit. The agent stays in the runtime.

Next: [Concepts](concepts.md), then the guide for what you are building:
[a chat in your app](frontend.md) (`npm create @camelai/run-app`),
[tools](guides/tools.md), [asking people](guides/human-input.md),
[showing an agent in a browser](guides/browser.md), [files](guides/files.md),
[agents for many users](guides/multi-user.md), [webhooks](guides/webhooks.md).
Before you ship, read the [production checklist](production.md).
