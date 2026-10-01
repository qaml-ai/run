---
name: camelrun
description: Set up camelRun (hosted durable agents) in a project, connect the account without pasting keys into chat, and run a first agent. Use when asked to add camelRun, build an agent on camelRun, or connect a coding agent to camelRun.
compatibility: Node 22+ or Bun (@camelai/run), Python 3.11+ (camelai-run). Env CAMELAI_API_KEY (art_...).
---

# camelRun setup

camelRun (https://run.camelai.com) is a hosted runtime for durable agents. It runs the model loop and keeps each
agent's history and files. Your tools stay in the project as ordinary functions.

You already know TypeScript and Python. This file covers what agents get wrong with camelRun: credentials, package
names, models and verification. The SDK changes faster than your training data. Prefer the current docs over what you
remember. The index is https://run.camelai.com/llms.txt, and the SDK reference is
https://run.camelai.com/docs/reference/sdk.md.

## 0. Say the plan, then go

Tell the user this in one message, then start right away. Don't wait for an OK: the only thing to stop for is a
missing API key (step 1).

    Here's how I'll set up camelRun:
    1. Find your camelRun API key, or ask you to add one to .env.local yourself (never in this chat)
    2. Install the SDK and build the agent you asked for, with a tool from this project
    3. Run it once and show you its reply

**What to build.** Build the agent the user asked for ("build an agent that …"). If they named nothing, or the prompt
still says `<does X>`, don't ask: pick something small and useful in this project (an agent that answers questions
about its data or code, with one tool that reads it), say what you picked, and build that. Choose sensible defaults
the same way (the agent's key, its instructions, the account's default model) rather than asking.

**Just trying camelRun, with no code?** The hosted MCP server needs no API key: signing in with GitHub or Google
creates the account. Offer it, and tell the user the command to run themselves:

- Claude Code: `claude mcp add --transport http camelrun https://run.camelai.com/mcp`, then `/mcp` to sign in.
- Codex: `codex mcp add camelrun --url https://run.camelai.com/mcp`, then `codex mcp login camelrun`.

Once it is connected, use its tools: `whoami`, then `create_agent` and `run_agent`.

## 1. Credentials: check before asking

Look in this order, and use the first that works:

1. `CAMELAI_API_KEY` in the environment, `.env.local` or `.env`. Check that the variable is set without printing its
   value.
2. A saved CLI login: `npx -y @camelai/camelrun whoami` exits 0 and prints the account and its default model.

To check a key that is only in a file, load the file in a subshell, e.g.
`(set -a; . ./.env.local; set +a; npx -y @camelai/camelrun whoami)`.

If there is no key, stop and tell the user exactly this:

> Sign in at https://run.camelai.com/console/tokens with GitHub or Google, and create an API token. Then add
> `CAMELAI_API_KEY=art_...` to `.env.local` in this project yourself, and tell me when it's done. Please don't paste
> the key into this chat.

Rules:
- Never ask for a key in chat. Never print, log or commit one.
- Keys start with `art_`. Anything else is not a camelRun API key.
- Make sure `.env.local` (or `.env`) is in `.gitignore`.
- `CAMELAI_API_KEY` is server-only. It never goes in browser code or a `NEXT_PUBLIC_` variable.

**Credit.** Signing in creates the account. GitHub accounts older than 30 days start with free credit. Everyone
else (Google sign-ins, newer GitHub accounts) unlocks the same credit by verifying a card on the
[Billing page](https://run.camelai.com/console/billing). Verifying a card does not charge it. If a run fails for
credit, tell the user this in one sentence with that link.

## 2. Detect the project; don't ask

- `package.json` means TypeScript. Install `@camelai/run` with the project's package manager.
- `pyproject.toml` or `requirements.txt` means Python. Install `camelai-run`, and import from `camelai_run`.
- A Next.js app that wants a chat UI can use `@camelai/run-react` with `createAgentHandler` (see
  https://run.camelai.com/docs/guides/browser.md). For a new app, use `npm create @camelai/run-app`.

No other package names exist. `@camelai/sdk`, `camelrun-sdk` and `camelai` on PyPI are wrong.

## 3. Write one agent

TypeScript:

```ts
import { Agents, schema, tool } from "@camelai/run";

const agents = new Agents(); // reads CAMELAI_API_KEY
const agent = await agents.upsert("my-project-assistant", {
  instructions: "…",
  tools: {
    lookup_order: tool({
      description: "…",
      input: schema.Object({ id: schema.String() }),
      execute: async ({ id }) => ({ /* real code from this project */ }),
    }),
  },
});
```

Python:

```python
import asyncio
from camelai_run import Agents, tool

@tool
def lookup_order(id: str) -> dict:
    """The docstring is the tool's description."""
    ...

async def main():
    async with Agents() as agents:  # reads CAMELAI_API_KEY
        agent = await agents.upsert("my-project-assistant", instructions="…", tools=[lookup_order])

asyncio.run(main())
```

- **ES modules.** The TypeScript uses top-level `await`, which needs an ES module: a `.mts` or `.mjs` file, or
  `"type": "module"` in `package.json`. In a CommonJS project (no `"type"`, or `"commonjs"`), use `.mts`/`.mjs`
  rather than changing the project's module type.
- **Python is async-only.** Every call is `await`ed inside `async def`. From synchronous code (a script, a Django
  view, a Celery task), run it with `asyncio.run(...)`. Python names are snake_case: `run.tool_errors`,
  `throw_on_error=False`, `context.idempotency_key`, a stream part's `is_error`.

- **Keys.** `upsert(key, …)` with the same key is the same agent, with its history. Choose a stable key.
- **Model.** Leave out `model`, and the account's default is used: the first default model the account can use. To
  choose another, list the usable ones with `npx -y @camelai/camelrun models --available`.
- **Where tools run.** Tools run in the process that called `upsert`, and one process serves an agent's tools at a
  time. With several processes (serverless, uvicorn or gunicorn workers, Celery, several instances), serve them over
  HTTP instead: `serveTools` from `@camelai/run/server`, or `serve_tools` in Python, named in a definition; then
  every process upserts the agent from that definition with no `tools`. Served tools also keep working through your
  deploys and restarts, which tools attached to a process don't. See
  https://run.camelai.com/docs/guides/tools.md#several-processes-workers-and-deploys.
- **Data back, not prose.** When the code needs an object (classification, extraction, a triage decision), pass a
  schema: `agent.run(text, { output: zodSchema })` gives a typed `run.output`; Python `output=PydanticModel`. Don't
  parse JSON out of `run.text`. See https://run.camelai.com/docs/guides/structured-output.md.

## 4. Verify with one real run

Write a short script that:
1. upserts the agent;
2. calls `agent.run("<a message that needs the tool>")`;
3. prints `run.status` and `run.text`;
4. closes the client (`await agents.close()`, or the `async with` block).

Run it with the key loaded. For example, use `node --env-file=.env.local check.mjs` for TypeScript. For Python, use
the project's dotenv setup, or `(set -a; . ./.env; set +a; python check.py)`.

It is done when the status is `completed` and the reply used the tool. Show the user the agent's reply exactly as it
wrote it. Then send them to https://run.camelai.com/console/agents, where the run's transcript and tool calls appear.

## 5. When it fails

| Error | What to do |
|---|---|
| `No ... API key is configured` | Leave out `model`, or pick one from `npx -y @camelai/camelrun models --available` |
| `INSUFFICIENT_CREDIT` / 402 | Tell the user: verify a card for starting credit (no charge), or add credit, at https://run.camelai.com/console/billing |
| `APPLICATION_NOT_CONNECTED` | No process is serving the agent's tools. Run the script that calls `upsert`. |
| 401 | The key is wrong or revoked. Go back to step 1. |

The full list is at https://run.camelai.com/docs/reference/errors.md.

## Other ways in

- **Config in the repo.** `npx -y @camelai/camelrun init` writes an `agent.yaml`. Check it with
  `npx -y @camelai/camelrun deploy --dry-run`, then apply it with `npx -y @camelai/camelrun deploy`. See
  https://run.camelai.com/docs/reference/cli.md.
- **A terminal login for the CLI.** The user runs `npx -y @camelai/camelrun login` in their own terminal. It saves a
  key they paste from the console, for the CLI only. The SDKs still read `CAMELAI_API_KEY`.
