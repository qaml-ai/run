# Computers

Connect an agent to a remote Linux computer or browser from **Computers** in the
console. The agent calls its computer tools directly, or from `js_exec`, just as
it calls web search. You do not need to host an MCP server for a managed provider.

A computer is attached to one agent. Its files and processes survive between
turns in the same session. Stopping the session or reaching its expiry discards
that environment; a new session starts empty. These files are separate from
camelRun workspace files.

## Connect a provider

Choose an existing agent and provider in the console, enter its credentials,
and set the maximum session time and daily time budget. The tools appear on the
agent's next turn, including for an agent that is already running. Disconnecting
removes the tools and stops the session before deleting credentials.

| Provider | Credentials | Tools |
| --- | --- | --- |
| Modal | Token ID and token secret | Linux shell and files |
| Daytona | Sandbox API key | Linux shell and files |
| Boat | API token | Linux shell and files |
| E2B | API key | Linux shell and files |
| Sprites | API token | Linux shell and files |
| Browserbase | API key and optional project ID | Browser navigation, reading, clicking, filling and JavaScript |
| Browser Use Cloud | API key | Browser navigation, reading, clicking, filling and JavaScript |
| Cloudflare Tunnel | Runner HTTPS origin and connection token | Linux shell and files in your runner's Docker container |

Use a Browserbase plan that supports keep-alive sessions. E2B and Browserbase
require an active provider account. Connecting credentials does not establish
that your account can create a machine; the first `computer_start` does that.

Credentials are encrypted in storage and are never placed in the model's
context. A managed machine gets no camelRun host credentials. Boat machines are
created with `noEnv`, snapshots off and monitoring off.

For Fly.io Sprites, create an API token on your Sprites account page and enter
the full `org-slug/org-id/token-id/token-value` token as `apiKey`. Use provider
`sprites`. Each session creates a sprite; stopping or expiring the session deletes it.

The API equivalent is `POST /v1/computers`:

```json
{
  "agent": "YOUR_AGENT_ID",
  "provider": "daytona",
  "credentials": {"apiKey": "YOUR_PROVIDER_KEY"},
  "leaseSeconds": 900,
  "dailySeconds": 3600
}
```

Keep provider keys in your secret manager. Do not put them in the agent's prompt.

## Give the agent a task

For a shell computer, a useful instruction is:

> Use computer_start, then computer_exec to install the packages you need and
> run the task. Inspect exitCode. Keep files in the computer between turns.
> Stop the computer with computer_stop when done. Copy any results you need to
> retain into the final answer before stopping.

Browser Use Cloud uses its direct browser API; the model loop stays in camelRun.
Sessions disable recording and the optional proxy by default.

Shell computers offer `computer_exec`, `computer_read_file` and
`computer_write_file`. Browserbase and Browser Use Cloud offer `browser_navigate`, `browser_read`,
`browser_click`, `browser_fill` and `browser_evaluate`. Both offer
`computer_start`, `computer_status` and `computer_stop`.

Sessions last 60–900 seconds. Commands have a timeout of at most 120 seconds,
further limited by the session's remaining time. Output is bounded. Background
processes should redirect their output so a command can return.

The service records session ownership and tool receipts in Postgres. Retrying
the same tool call does not create another computer or execute the same command
again. A command whose result was lost is reported as uncertain: inspect the
computer before issuing a new command that could repeat a side effect.

## Bring your own computer through Cloudflare Tunnel

The runner requires Python 3, Docker and `cloudflared`. From a checkout:

```sh
python3 examples/computer/tunnel_server.py \
  --tunnel --lifetime 900 --connection-file /private/path/computer.json
```

Enter the file's `url` and `token` in the console's Cloudflare Tunnel connection.
Keep the runner online. The file is created with owner-only permissions and
removed when the runner exits. Do not share it: its token grants command access.

The runner creates a disposable Docker container with no host filesystem mounts,
no Docker socket and no host environment credentials. It limits CPU, memory and
process count. It does not give the agent your desktop or unrestricted host
shell. Container networking uses Docker's default network; it is not limited to
the public internet. The temporary tunnel and container end with the runner; run a new one and
reconnect for another session. An existing named tunnel can use `--url` instead
of `--tunnel`, with `--port` for a stable local port.

## Usage and cleanup

Compute is billed directly to your provider account. The console reports session
time by provider and by the agent's workspace when the session started, capped
at the configured expiry. Cleanup delays can add provider charges beyond these
figures.
These seconds are separate from model spend and are not a provider invoice.
Changing workspaces does not move earlier sessions. Daily budgets reserve the
whole allowed session duration before starting a computer; closing early frees
the unused time. The budget resets at midnight UTC.

camelRun stops expired sessions and retries failed cleanup. Provider timeout
settings add a fallback where supported; Daytona's fallback is an idle timeout.
Sprites pause when idle but have no provider-side lease; camelRun deletes them at expiry.
The runtime must remain available for timely cleanup. Check the provider console
if cleanup is failing. Account deletion waits for computer cleanup before
removing credentials.

If a provider accepts a create request but its reply is lost before the machine
ID is recorded, the session stays `uncertain`. Another machine is not created
automatically. Check your provider account and remove any machine from that
attempt. Only after verifying cleanup, use **Confirm provider cleanup** in the console, or acknowledge it with
`POST /v1/agents/{id}/computer/confirm-cleanup` and
`{"providerCleanupConfirmed":true}`. Acknowledgment is an account action, not an
agent tool. Normal sessions with a recorded ID are cleaned up by camelRun. You can also
confirm manual cleanup when automatic cleanup fails, for example after revoking
a provider key. Remove the machine at the provider before acknowledging it.

`GET /v1/computers` lists connection and session state;
`GET /v1/computers/usage` returns the workspace breakdown;
`POST /v1/agents/{id}/computer/stop` stops a session; and
`DELETE /v1/computers/{id}` stops and disconnects it.
