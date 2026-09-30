# camelRun CLI and MCP server

`camelrun` deploys and manages agents from a terminal, a script or CI. Coding
agents (Claude Code, Cursor, Codex…) get the same operations over MCP, so they can
write an agent's manifest, deploy it, talk to the agent and read what it did:
from the hosted MCP server at `https://agents.camelai.dev/mcp`, with nothing to
install ([below](#hosted-mcp-server)), or from `camelrun mcp` on your machine,
which can also deploy the manifests in your repository.

```sh
npm install -g @camelai/camelrun   # Node 22+; or npx @camelai/camelrun <command>
camelrun login                     # paste an API key from the console's API tokens page
```

`login` checks the key and saves it to `~/.config/camelrun/credentials.json`
(mode 600). `CAMELAI_API_KEY` and `CAMELAI_URL` (for a self-hosted runtime), or
`--api-key` and `--url`, take precedence over it.

## Deploy from a manifest

An agent's configuration lives in your repository as `agent.yaml`, and `camelrun
deploy` makes it so in the runtime. `camelrun init [key]` writes one to start from.

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
camelrun deploy                  # ./agent.yaml (or agent.yml, agent.json)
camelrun deploy agents/*.yaml    # several files
camelrun deploy --dry-run        # what would change, credentials hidden
camelrun deploy --apply          # also move live agents to the new revision
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

## MCP tools

Both MCP servers have tools for everything above: `deploy`, `list_agents`,
`get_agent`, `create_agent`, `configure_agent`, `delete_agent`, `run_agent`,
`get_run`, `agent_history`, `abort_agent`, `list_inputs`, `answer_input`, the
schedule and definition tools, `list_models`, `whoami`, and `read_docs`, which
reads these docs.

`run_agent` and `get_run` wait at most `wait` seconds (default 50, so a call
stays inside clients' tool timeouts); a run still going comes back as `running`
with its `requestId`. A run that asks a person something comes back as
`input_required`: the coding agent should ask you and answer with what you
decided.

Every tool has a title and states MCP's `readOnlyHint`, `destructiveHint` and
`openWorldHint`. The tools that overwrite, delete, stop or irreversibly answer
something (`deploy`, `create_agent` on an existing key, `configure_agent`, the
deletes, `abort_agent`, `answer_input`) are marked destructive, so clients that
ask before such calls ask you first. `run_agent` and `answer_input` are
open-world: the run they start can search and fetch the web and call the
agent's tool servers. A result longer than 100,000 characters is cut, saying so.

## Hosted MCP server

`https://agents.camelai.dev/mcp` serves the tools over Streamable HTTP. Add it
by URL and sign in when your client asks: the runtime's sign-in page (GitHub,
or an API token) asks you to allow the client, which then acts for your
account until you revoke it.

Claude Code:

```sh
claude mcp add --transport http camelrun https://agents.camelai.dev/mcp
# then /mcp in Claude Code to sign in; or skip signing in with a key:
claude mcp add --transport http camelrun https://agents.camelai.dev/mcp --header "Authorization: Bearer art_..."
```

Claude (claude.ai and the desktop app): Settings, Connectors, Add custom
connector, with the URL above. Cursor and other clients configured with JSON:

```json
{ "mcpServers": { "camelrun": { "url": "https://agents.camelai.dev/mcp" } } }
```

How it differs from `camelrun mcp`:

- `deploy` takes the manifest's YAML (`manifest`), not a file. The hosted
  server reads no files and no environment variables of its own, so
  `systemPromptFile`, `specFile` and `${NAME}` are refused: write the values in,
  or deploy from your machine with `camelrun deploy`.
- It keeps no session: every request stands alone, on any node.

Signing in is OAuth 2.1, as MCP's authorization spec describes: a `401` from
`/mcp` names `/.well-known/oauth-protected-resource/mcp`, which names the
runtime as the authorization server (`/.well-known/oauth-authorization-server`);
clients register themselves (`/oauth/register`) and use the authorization code
flow with PKCE. Access tokens last an hour and act as your tenant at `/mcp` and
the REST API, except that they cannot create API tokens; refresh tokens last 30
days and rotate on each use. A refresh token presented again within 10 seconds of its
rotation (a retry, or refreshes racing) gets the same new tokens; later, it revokes its grant.
The console's API tokens page lists connected apps under **Connected apps**,
where you revoke them (or `GET /v1/oauth/grants`, `DELETE
/v1/oauth/grants/{id}`). Any API token also works, as `Authorization: Bearer`.

Each agent is also an MCP server of its own, with one tool that messages it:
see [Agents as MCP servers](../guides/mcp-server.md).

## In the browser: WebMCP

The console also offers the tools to the agent built into your browser, through
[WebMCP](https://webmachinelearning.github.io/webmcp/): while you are signed in
to the console, a browser with WebMCP (Chrome with the WebMCP testing flag
turned on, for now) lists them, and they act as you, through the console's own
session. They are the hosted server's tools: `deploy` takes the manifest's YAML.
Every tool that changes something is marked consequential, so the browser can
ask you before it runs one. Signing out removes them.

## Local MCP server

`camelrun mcp` serves the tools over stdio, with the CLI's credentials (read on
each call). Its `deploy` also takes `file`, a path to a manifest (default
`./agent.yaml`), and reads the files and environment variables it names.

Claude Code:

```sh
claude mcp add camelrun -- npx -y @camelai/camelrun mcp
# or, with a key of its own:
claude mcp add camelrun -e CAMELAI_API_KEY=art_... -- npx -y @camelai/camelrun mcp
```

Cursor, Windsurf and other clients configured with JSON:

```json
{
  "mcpServers": {
    "camelrun": { "command": "npx", "args": ["-y", "@camelai/camelrun", "mcp"], "env": { "CAMELAI_API_KEY": "art_..." } }
  }
}
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.camelrun]
command = "npx"
args = ["-y", "@camelai/camelrun", "mcp"]
env = { CAMELAI_API_KEY = "art_..." }
```

A key or a connected app can create and delete every agent in the account. Give
a coding agent a key of its own, or connect it with OAuth, so you can revoke it
alone.
