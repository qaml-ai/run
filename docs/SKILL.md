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

Tell the user this in one message, then start right away. Don't wait for an OK on the plan. The only things to stop
for are the agent's goal, if the user hasn't said it (below), and a missing API key (step 1).

    Here's how I'll set up camelRun:
    1. Find your camelRun API key, or ask you to add one to .env.local yourself (never in this chat)
    2. Install the SDK and build the agent you asked for, with a tool from this project
    3. Run it once and show you its reply

**What to build.** If the user said what the agent should do, build that. If they haven't (the usual prompt ends "Ask
me what the agent should do."), ask exactly one question first. Don't ask it open-ended: offer these options, using
your client's multiple-choice question UI if it has one (Claude Code's AskUserQuestion, say), else print the list:

    What should your agent do? Pick one or describe your own:
    1. Support agent: answers customers from your docs and calls your app's functions (e.g. look up an order)
    2. Chat in your web app: a chat UI backed by an agent (React/Vue/Svelte/Solid)
    3. Discord or Slack bot for your community
    4. Scheduled worker: a daily digest or report that runs on its own
    5. Other: tell me

Then follow the recipe for the answer:

| Answer | Read and follow |
|---|---|
| 1. Support agent | https://run.camelai.com/docs/guides/tools.md: tools from this project's own functions (step 3 below) |
| 2. Chat in your web app | https://run.camelai.com/docs/frontend.md: `npm create @camelai/run-app` for a new app, or `createAgentHandler` and `@camelai/run-react` in this one |
| 3. Discord or Slack bot | https://run.camelai.com/docs/guides/channels.md: a definition, then a channel that uses it |
| 4. Scheduled worker | https://run.camelai.com/docs/concepts.md#waking-later: `agent.client.schedule({ text, everySeconds })`, or the `schedule` built-in |
| 5. Other | what they describe, from this file and https://run.camelai.com/llms.txt |

Ask nothing else: choose the rest yourself (the language from the project, the agent's key, its instructions, the
account's default model, a tool from this project), and say what you chose.

**No answer possible.** Only when you cannot ask (you run non-interactively) or get no answer, build a default:
in a project, something small and useful (an agent that answers questions about its data or code, with one tool that
reads it); in an empty folder, the demo below. Say what you picked.

**An empty folder.** With no project to read and no answer to the question, build a TypeScript ES module project
(`npm init -y && npm pkg set type=module && npm install @camelai/run`) with a one-tool demo: an agent that answers
questions about a small business from a `facts.json` it reads with a `get_facts` tool (opening hours, prices, a
policy or two). Use Python instead only if the user asked for it. With an agent named but no project, build that
agent in the same kind of project.

**Just trying camelRun, with no code?** The hosted MCP server needs no API key: signing in with GitHub or Google
creates the account. Offer it, and tell the user the command to run themselves:

- Claude Code: `claude mcp add --transport http camelrun https://run.camelai.com/mcp`, then `/mcp` to sign in.
- Codex: `codex mcp add camelrun --url https://run.camelai.com/mcp`, then `codex mcp login camelrun`.

Once it is connected, use its tools: `whoami`, then `create_agent` and `run_agent`.

## 1. Credentials: check before asking

Look in this order, and use the first that works:

1. `CAMELAI_API_KEY` in the environment, `.env.local` or `.env`. Check that the variable is set without printing its
   value.
2. A saved CLI login: `npx -y @camelai/camelrun whoami` exits 0. Outside a terminal it prints JSON: `tenant` (the
   account's id), `login` (the GitHub login or Google address it signed in with, if any), `via` (how the key
   authenticated), `defaultModel` and `url` (the runtime). A non-zero exit means no usable key.

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
- Neither, and the folder is empty: see **An empty folder** in step 0.
- `pyproject.toml` or `requirements.txt` means Python. Install `camelai-run`, and import from `camelai_run`.
- A Next.js app that wants a chat UI can use `@camelai/run-react` with `createAgentHandler` (see
  https://run.camelai.com/docs/frontend.md). For a new app, use `npm create @camelai/run-app` (it reads
  `CAMELAI_API_KEY` from the environment; never pass the key as an argument).

- A project already on the OpenAI Agents SDK (`from agents import Agent`, `@openai/agents`) or LangGraph is a port:
  read https://run.camelai.com/docs/guides/migrating.md first, and say which of its features have no equivalent.

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

- **Runs or agents.** An agent keeps its history: right for chats, assistants and anything that remembers. When each
  answer stands alone (classify, extract, vote, judge, summarize one input), use a stateless run instead:
  `agents.run({ instructions, input, output })` (Python `agents.run(input, instructions=…, output=…)`, REST
  `POST /v1/runs`) is one call, keeps nothing between runs, and makes no agent, so it never uses up agent creates.
  Don't make an agent per input. A run has no tools from this process (`tools`); give it built-ins or a definition's
  served tools. See https://run.camelai.com/docs/guides/stateless-runs.md.
- **Keys.** `upsert(key, …)` with the same key is the same agent, with its history. Choose a stable key.
- **Branching.** To branch a conversation (a user edits an earlier message, or you try another approach), fork the
  agent: `agent.fork({ key, atMessage })` copies its configuration, history and files into a new agent. Don't rebuild
  history by hand with `initialMessages`. See https://run.camelai.com/docs/concepts.md#forking.
- **Model.** Leave out `model`, and the account's default is used: the first default model the account can use. To
  choose another, list the usable ones with `npx -y @camelai/camelrun models --available`.
- **Where tools run.** Tools run in the process that called `upsert`, and one process serves an agent's tools at a
  time. With several processes (serverless, uvicorn or gunicorn workers, Celery, several instances), serve them over
  HTTP instead: `serveTools` from `@camelai/run/server`, or `serve_tools` in Python, named in a definition; then
  every process upserts the agent from that definition with no `tools`. Served tools also keep working through your
  deploys and restarts, which tools attached to a process don't. See
  https://run.camelai.com/docs/guides/tools.md#several-processes-workers-and-deploys.
- **Tools and js_exec.** Besides your tools as tools of their own, the model gets `js_exec`, a sandbox where it
  writes code that calls them (`tools.<name>(args)`), and by default it can call any of your tools from there (an
  agent's tools are `exposure: "both"` up to 10 of them, `"codemode"` past that). Mark a tool
  `exposure: "direct"` (Python `@tool(exposure="direct")`) when it must be called on its own: when the app renders
  its arguments as they stream in, or must see each call as it happens. See
  https://run.camelai.com/docs/guides/tools.md#keeping-tools-out-of-js_exec.
- **Limits to design around.** The one that matters is **busy agents**: how many agents may run at once, 20 on
  free credit, 25 once the account has paid $5 for credit, then 100, 250 and 1,000 (usage tiers); past it a run gets
  429 `BUSY_AGENT_LIMIT`, which says what the next tier unlocks. Runs are limited to 240 a minute on free credit (600
  paid). Creating agents is limited only against abuse (600 a minute; an `upsert` of an unchanged configuration does
  not count). Past a limit, calls get 429 (the SDKs wait and retry); responses carry `X-RateLimit-Remaining` and
  `-Reset`. Make one agent per user or conversation and reuse it; for independent one-off questions, run them on one
  agent with `history: "none"` (the model sees only the instructions and that message). See
  https://run.camelai.com/docs/reference/limits.md#rate-limits.
- **Tool-less agents.** An agent that only answers (a classifier, a judge, a one-line reply) needs no runtime tools:
  `upsert(key, { instructions, codeMode: false, fileTools: false })` drops `js_exec` and the runtime's tool rules, so
  each request is your instructions and the message, a few hundred tokens instead of about 2,000.
- **Data back, not prose.** When the code needs an object (classification, extraction, a triage decision), pass a
  schema: `agent.run(text, { output: zodSchema })` gives a typed `run.output`; Python `output=PydanticModel`. Don't
  parse JSON out of `run.text`. See https://run.camelai.com/docs/guides/structured-output.md.

## 4. Verify with one real run

Write a short check script that:
1. upserts **one check agent** for the script, under a fresh key (the app's own key with a timestamp, e.g.
   `` `my-project-assistant-check-${Date.now()}` ``), so it starts with no history: an agent remembers, and on the
   app's stable key it could answer from what it already said and call no tool. Make it once, not once per check: a
   check agent per run of the script is enough, and leaves no pile of agents behind;
2. runs each check on that agent: `agent.run("<a message that needs the tool>")`, one run per check. The agent
   remembers earlier checks in the script, so give each one a question it cannot answer from them (a different
   order, a different record);
3. prints, for each run, `run.status`, `run.text` and the tools it called: `run.toolCalls.map(call => call.tool)`
   (Python `[call["tool"] for call in run.tool_calls]`), and any `run.toolErrors` (Python `run.tool_errors`);
4. deletes the check agent at the end (`await agent.delete()`, in a `finally`) and closes the client
   (`await agents.close()`, or the `async with` block).

Run it with the key loaded. For example, use `node --env-file=.env.local check.mjs` for TypeScript. For Python, use
the project's dotenv setup, or `(set -a; . ./.env; set +a; python check.py)`.

It is done when the status is `completed`, the tool calls include your tool, and there are no tool errors. A run can
be `completed` with tool errors: the model worked around a call that failed. Show the user the agent's reply exactly
as it wrote it, and the tools it called. Then send them to https://run.camelai.com/console/agents, where the run's
transcript and tool calls appear.

## 5. When it fails

| Error | What to do |
|---|---|
| `model_key_missing` (`No ... API key is configured`) | Leave out `model`, or pick one from `npx -y @camelai/camelrun models --available` |
| `INSUFFICIENT_CREDIT` / 402 | Tell the user: verify a card for starting credit (no charge), or add credit, at https://run.camelai.com/console/billing |
| `APPLICATION_NOT_CONNECTED` | No process is serving the agent's tools. Run the script that calls `upsert`. |
| 401 | The key is wrong or revoked. Go back to step 1. |
| `RATE_LIMITED` / 429 | Too many runs started this minute (240 on free credit, 600 paid), or agents made (600, against abuse). Wait out `Retry-After`; reuse agents instead of making one per check or request. |
| `BUSY_AGENT_LIMIT` / 429 | As many agents running at once as the account's usage tier allows (20 on free credit). The message says what the next tier unlocks; or wait for a run to finish. |

The full list is at https://run.camelai.com/docs/reference/errors.md.

## Other ways in

- **Config in the repo.** `npx -y @camelai/camelrun init` writes an `agent.yaml`. Check it with
  `npx -y @camelai/camelrun deploy --dry-run`, then apply it with `npx -y @camelai/camelrun deploy`. See
  https://run.camelai.com/docs/reference/cli.md.
- **A terminal login for the CLI.** The user runs `npx -y @camelai/camelrun login` in their own terminal. It saves a
  key they paste from the console, for the CLI only. The SDKs still read `CAMELAI_API_KEY`.
