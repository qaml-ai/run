# @camelai/camelrun

The camelRun CLI: deploy and manage agents on [camelRun](https://agents.camelai.dev)
from a terminal, a script or CI, and give a coding agent the same powers over MCP.

```sh
npm install -g @camelai/camelrun
camelrun login                   # an API key from the console's API tokens page
camelrun init support            # writes agent.yaml
camelrun deploy                  # the definition, and the agents it lists
camelrun run support "Which tickets look urgent?"
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
on a person (`camelrun inputs`, `camelrun answer`).

## For coding agents

The hosted MCP server needs nothing installed; sign in when the client asks:

```sh
claude mcp add --transport http camelrun https://agents.camelai.dev/mcp
```

Or run it locally, where its `deploy` also reads your repository's manifests:

```sh
claude mcp add camelrun -- npx -y @camelai/camelrun mcp
```

Every command, the manifest's fields and the MCP tools:
[CLI and MCP server](https://agents.camelai.dev/docs/reference/cli.md).
