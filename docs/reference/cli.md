# CLI and MCP server

`camelai` deploys and manages agents from a terminal, a script or CI. `camelai mcp`
serves the same operations to a coding agent (Claude Code, Cursor, Codex…) as an
MCP server, so it can write an agent's manifest, deploy it, talk to the agent and
read what it did.

```sh
npm install -g @camelai/cli      # Node 22+; or npx @camelai/cli <command>
camelai login                    # paste an API key from the console's API tokens page
```

`login` checks the key and saves it to `~/.config/camelai/credentials.json` (mode
600). `CAMELAI_API_KEY` and `CAMELAI_URL` (for a self-hosted runtime), or
`--api-key` and `--url`, take precedence over it.

## Deploy from a manifest

An agent's configuration lives in your repository as `agent.yaml`, and `camelai
deploy` makes it so in the runtime. `camelai init [key]` writes one to start from.

```yaml
key: support                     # the same key is the same definition
name: Support
model: anthropic/claude-sonnet-5-5
systemPromptFile: prompts/support.md
builtins: [web_search, ask_user]
mcpServers:
  - name: app
    url: https://app.example.com/mcp
    auth: { type: bearer, token: "${APP_MCP_TOKEN}" }
openApi:
  - name: billing
    specFile: openapi.yaml
    auth: { type: runtime }
agents:                          # keyed agents made from it on deploy
  - key: support-main
  - key: support-eu
    systemPromptAppend: Answer customers in the EU region.
```

- Every field but `key`, `agents`, `systemPromptFile` and an OpenAPI source's
  `specFile` is sent as the [definition](../guides/definitions.md) (`name`,
  `model`, `systemPrompt`, `thinkingLevel`, `fileTools`, `builtins`, `webSearch`,
  `mcpServers`, `openApi`, `limits`, `mounts`), and the runtime validates it.
  `name` defaults to the key.
- `${NAME}` and `${NAME:-default}` in the manifest's strings read the
  environment, so credentials stay out of the file; an unset one is an error.
  `$${NAME}` is a literal `${NAME}`. Files named by `systemPromptFile` and
  `specFile` are read as they are, relative to the manifest.
- Each entry of `agents` is a keyed agent made from the definition, with the
  fields of `POST /v1/agents` (`name`, `subject`, `context`, `model`,
  `thinkingLevel`, `systemPromptAppend`, `ttlSeconds`, `mounts`…). An agent that
  exists is brought to them between its turns, keeping its history; who it acts
  for (`subject`, `context`) and its mounts are fixed when it is made, and
  changing them fails that agent (delete it to start over).
- A file can hold several manifests as YAML documents separated by `---`.

```sh
camelai deploy                   # ./agent.yaml (or agent.yml, agent.json)
camelai deploy agents/*.yaml     # several files
camelai deploy --dry-run         # what would change, credentials hidden
camelai deploy --apply           # also move live agents to the new revision
```

Deploying upserts each definition by its key: it is created the first time, gets
a new revision when the manifest changed it, and is `unchanged` otherwise, so
deploy on every push. Agents keep the revision they were made with until you
deploy with `--apply`, which reconfigures each live agent between its turns and
keeps its history.

## Commands

An agent is named by its key or its id (`client_…`), a definition by its key or
its id (`def_…`).

| Command | |
| --- | --- |
| `whoami` | the account the key belongs to, and its default model |
| `models [--available]` | the model catalog, or the models your account can use |
| `init [key] [--model m]` | write `agent.yaml` |
| `deploy [file…] [--apply] [--dry-run]` | deploy manifests |
| `agents list` / `agents get <agent>` | agents; one agent's configuration and tool sources |
| `agents create <key> [--definition d] [--model m] [--prompt text]` | an agent outside a manifest |
| `agents configure <agent> [--model m] [--prompt text] [--prompt-append text] [--thinking level]` | change one agent between its runs |
| `agents delete <agent> --yes` | stop an agent and purge its history and files |
| `run <agent> <message…>` | send a message and print the reply |
| `runs get <agent> <requestId> [--wait s]` | a run's result |
| `history <agent> [--limit n]` | its latest messages, tool calls included |
| `abort <agent>` | stop its running turn |
| `inputs [agent]` / `answer <agent> <inputId> <value>` | questions and approvals waiting on someone, and answering them |
| `schedules list\|add\|delete <agent>` | wake-ups: `add --text t --in 3600 [--every 86400]` |
| `definitions list\|get\|agents\|delete` | definitions, and the revision each agent has |

`run` waits for the run to end; `--wait 30` waits at most 30 seconds and
`--no-wait` not at all, printing the request id to follow with `runs get`.
`--from user-1` says who is sending, `--steer` gives the message to a run that
is going. An agent whose tools are attached by an application that is not
connected refuses the run (`APPLICATION_NOT_CONNECTED`) unless you pass
`--allow-disconnected`.

`answer` takes `true` or `false` for an approval, the chosen label or your own
words for a question (`{"<question>": "<answer>"}` for several), the fields as
JSON for a form, and `decline`.

### Output and exit codes

Output is text on a terminal and JSON otherwise (or with `--json`), so scripts
and agents get JSON without asking. Errors go to stderr, as `{"error", "status",
"code"}` in JSON mode.

| Exit | |
| --- | --- |
| 0 | done |
| 1 | an error, a failed run, or an agent in a deploy that failed |
| 2 | the run waits on a person: its `inputs` say what to `answer` |

## MCP server

`camelai mcp` is an MCP server over stdio, with tools for everything above:
`deploy` (a manifest file, or its YAML inline), `list_agents`, `get_agent`,
`create_agent`, `configure_agent`, `delete_agent`, `run_agent`, `get_run`,
`agent_history`, `abort_agent`, `list_inputs`, `answer_input`, the schedule and
definition tools, `list_models`, `whoami`, and `read_docs`, which reads these
docs. It uses the same credentials as the CLI, read on each call.

Claude Code:

```sh
claude mcp add camelai -- npx -y @camelai/cli mcp
# or, with a key of its own:
claude mcp add camelai -e CAMELAI_API_KEY=art_... -- npx -y @camelai/cli mcp
```

Cursor, Windsurf and other clients configured with JSON:

```json
{
  "mcpServers": {
    "camelai": { "command": "npx", "args": ["-y", "@camelai/cli", "mcp"], "env": { "CAMELAI_API_KEY": "art_..." } }
  }
}
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.camelai]
command = "npx"
args = ["-y", "@camelai/cli", "mcp"]
env = { CAMELAI_API_KEY = "art_..." }
```

`run_agent` and `get_run` wait at most `wait` seconds (default 50, so a call
stays inside clients' tool timeouts); a run still going comes back as `running`
with its `requestId`. A run that asks a person something comes back as
`input_required`: the coding agent should ask you and answer with what you
decided. `delete_agent` and `delete_definition` are marked destructive, so
clients that ask before such calls ask you first.

The key can create and delete every agent in the account. Give a coding agent a
key of its own (API tokens in the console) so you can revoke it alone.
