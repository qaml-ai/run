---
name: create-first-agent
description: Create a first camelRun agent from a plain-language description, try it with a message, and explain how to keep using it. Use when someone wants to build, set up or try an AI agent on camelRun, or asks how to get started with camelRun.
---

Help the person create a working camelRun agent and see it answer, in a few steps. Their explicit instructions
take priority over this workflow: skip or change steps when they ask.

1. Call `whoami` to confirm which camelRun account is connected and its default model. If the call fails because
   the account is not connected, ask them to connect camelRun and stop.
2. Work out what the agent is for. If the request doesn't say, ask one short question, such as "What should the
   agent do, and who will talk to it?". Don't ask for anything else up front.
3. Choose, and tell them in one line:
   - a key: 1 to 80 lowercase letters, digits and hyphens that name the agent (for example `news-digest`). The same
     key is the same agent, so check `list_agents` first and pick another key if it is taken, unless they want to
     change that agent.
   - built-in tools, only the ones the job needs: `web_search` and `web_fetch` to look things up on the web,
     `schedule` to wake itself later, `ask_user` to ask a person before acting.
   - a system prompt of a few sentences: the agent's job, its audience, its tone and what it must not do.
   Use the account's default model unless they ask for another; `list_models` shows the choices.
4. Call `create_agent` with the key, system prompt and built-ins.
5. Call `run_agent` with a first message that shows the agent doing its job, and show the reply as the agent wrote
   it. Never write or improve the agent's reply yourself.
   - `running`: call `get_run` with the `requestId` until it ends.
   - `input_required`: show the person the agent's question or approval, and call `answer_input` only with what
     they decided.
   - `failed`: show the error and suggest a fix, such as another model.
6. Finish with how to keep going: message it again by its key, change it with `configure_agent`, schedule it with
   `add_schedule`, and see it in the console at https://run.camelai.com/console. It keeps its history until
   deleted.

When they want the same configuration for several agents, or kept in a repository, write an agent.yaml manifest and
deploy it with `deploy` (call `read_docs` with `guides/definitions.md` for its fields), using `dryRun` first.

Rules:

- Never ask for, repeat or put credentials (API keys, tokens, passwords) in a manifest or a message. If the agent
  needs a tool server that takes a secret, explain that it is deployed with the camelrun CLI (`camelrun deploy`),
  which reads secrets from its environment, and point to https://run.camelai.com/docs/reference/cli.md.
- Delete agents, definitions or schedules only when the person asks, one at a time, after they confirm.
- Only act on the connected account. You can't see or change anyone else's agents.
