# @camelai/cli

Deploy and manage agents on the [camelAI agent runtime](https://agents.camelai.dev) from a
terminal, a script or CI, and give a coding agent the same powers over MCP.

```sh
npm install -g @camelai/cli
camelai login                    # an API key from the console's API tokens page
camelai init support             # writes agent.yaml
camelai deploy                   # the definition, and the agents it lists
camelai run support "Which tickets look urgent?"
```

`agent.yaml` keeps an agent's configuration in your repository; deploying again makes a new
revision only when it changed, and `--apply` moves live agents to it between their turns:

```yaml
key: support
model: anthropic/claude-sonnet-5-5
systemPromptFile: prompts/support.md
builtins: [web_search, ask_user]
mcpServers:
  - name: app
    url: https://app.example.com/mcp
    auth: { type: bearer, token: "${APP_MCP_TOKEN}" }
agents:
  - key: support
```

Output is JSON when stdout is not a terminal (or with `--json`); exit code 2 means a run waits
on a person (`camelai inputs`, `camelai answer`).

## For coding agents

```sh
claude mcp add camelai -- npx -y @camelai/cli mcp
```

`camelai mcp` serves `deploy`, `run_agent`, `get_run`, `agent_history`, `list_agents`,
`answer_input`, `read_docs` and the rest over stdio. Other clients: `{"command": "npx", "args":
["-y", "@camelai/cli", "mcp"]}`.

Every command, the manifest's fields and the MCP tools:
[CLI and MCP server](https://agents.camelai.dev/docs/reference/cli.md).
