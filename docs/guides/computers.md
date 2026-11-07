# Computers

Connect an agent to a remote Linux computer or browser from **Computers** in the
console. The agent calls its computer tools directly, or from `codemode`, just as
it calls web search. You do not need to host an MCP server for a managed provider.

A computer is attached to one agent. Its files and processes survive between
turns in the same session. Stopping the session or reaching its expiry discards
that environment; a new session starts empty. These files are separate from
camelRun workspace files.

## Sub-agents

By default, each sub-agent the runtime creates gets its own computer connection
when its parent has one. This applies to `spawn_agent` and `delegate`, including
children made from definitions. The
connection has the same provider, provider credentials, managed setting and
lease and daily limits. It starts without a session: the child calls
`computer_start` when it needs a machine. It never uses its parent's session.
Grandchildren inherit the same way.

Set `"subagents": false` in `POST /v1/computers` to turn this off for that
connection. The optional field defaults to `true` and appears in connection
responses. It applies at child creation; attaching later does not change
existing children. Named targets that run an existing agent keep that agent's
own connection. Tool spawn directives also target existing agents and keep
their connections.

Each connection is billed as usual, independently: managed compute uses the
child's account and end-user bucket, and bring-your-own compute uses the same
provider account. There is no new shared computer budget or cap.

A child's connection is detached and its session stopped when the child is
deleted or expires, through the same cleanup as any detach. Cleanup failures
are retried, and metering history stays. Sub-agents live for a day unless deleted
earlier. A `delegate` child's session stops when its call answers, so it bills
nothing more; its connection stays. A `spawn_agent` child keeps its session
until it calls `computer_stop`, its session expires, or it is deleted.

### Forking a computer

A sub-agent can start with its own copy of its parent's computer: the repos,
installed packages and build caches, as they are at the call. Give `delegate` or
`spawn_agent` (also from code) `computer`:

| `computer` | The child's computer |
| --- | --- |
| `"fresh"` (default) | a new, empty computer with the parent's connection settings, as above |
| `"fork"` | a copy of the parent's disk, taken now. Running processes are not copied |
| `"none"` | no computer |

```json
{ "instructions": "You fix one flaky test on a branch.", "task": "Fix tests/cluster.test.ts and push a branch", "computer": "fork" }
```

- **One snapshot per call.** The snapshot is taken when the call is made, and
  every child of that model response (or script) starts from the same one: five
  `delegate` calls in one response take one snapshot.
- **Each fork is its own machine.** A child's writes never reach its parent or
  a sibling, and the parent's later writes never reach the child. Results come
  back the usual way: push a branch, or copy files to a shared volume.
- **Where it works.** Boat (managed, or your own key) and Cloudflare container
  computers fork. Boat forks are exact: the runtime saves a snapshot of the
  running machine (about 10 seconds for a 1.7 GB workspace) and makes each child
  from it. A fork's files load in the background for the first few minutes, so
  first reads of large trees are slower. Other providers (Lambda MicroVMs,
  Sprites, E2B, Daytona, Modal, tunnels, browsers) answer `409
  FORK_UNSUPPORTED`, and nothing is made: ask for `"fresh"` instead. A computer
  with no running session answers `409 NO_SESSION`.
- **Sessions.** Each new session of a forked connection starts from the fork's
  snapshot. The connection shows where it came from in `forkedFrom`
  (`{ agent, connection, snapshot, provider, at }`).
- **Billing.** Each fork is billed as its own computer session, on the same
  provider account or credit as any. Boat saved snapshots are on the provider
  account. The runtime deletes the snapshot when the last connection made from
  it is removed (a sweep retries failed deletes).
- A fork is for a sub-agent the call makes. Delegating to an existing agent
  with `"fork"` is refused.

API users fork with `POST /v1/computers/{id}/fork`, or by agent with
`POST /v1/agents/{id}/computer/fork`:

```http
POST /v1/computers/cmp_.../fork
{ "agents": ["agt_worker_1", "agt_worker_2"] }

201 { "snapshot": { "id": "cms_...", "provider": "boat", "createdAt": 1794010786578 },
      "forks": [ { "id": "cmp_...", "agent": "agt_worker_1", "forkedFrom": { ... }, "session": null, ... }, ... ] }
```

Each agent (at most 16) must be the account's and have no computer connection
yet. One snapshot serves all of them.

The parent has no mount of a child's computer. Inline children share the
parent's volume mounts at the same paths, including its workspace when mounted;
children made from definitions use the definition's mounts. Copy results from
`/computer` to a shared volume to exchange files. Mounting children's computers
in the parent is a possible follow-up.

## Managed computers

Where the runtime offers them, choose **Managed (no key needed)** in the console, or leave out the credentials:

```json
{"agent": "YOUR_AGENT_ID", "provider": "lambda"}
```

There is no provider account to set up. By default the computer is an ARM64 Linux
machine on AWS Lambda MicroVMs (1 vCPU, 2 GiB). Commands may run for up to 30 minutes.
Save results before the fixed session expiry: 2 hours by default, at most 8 hours,
including suspended time. Idle machines suspend after 5 minutes by default; the
next command or file operation resumes them with files and processes preserved.
Command timeouts end the command's process group.

The runtime supplies no AWS execution role or host credentials to the machine.
Public internet access supports package installation and signed file transfers.
Use ARM64 binaries; UDP is blocked except for DNS through the VM's resolver.

Compute is charged to your credit from observed running time and snapshot activity,
at provider cost unless the operator sets a price. An account using prepaid billing
must have bought credit. The operator can select Boat instead, keeping its 2-hour
idle lease and 24-hour maximum. Both `lambda` and `boat` without credentials request
the runtime's configured managed provider; Boat with credentials uses your account.
`GET /v1/computers/options` says whether managed computers are available.

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
> retain into workspace files with `cp` before stopping.

Browser Use Cloud uses its direct browser API; the model loop stays in camelRun.
Sessions disable recording and the optional proxy by default.

Shell computers offer `computer_exec`, `computer_read_file` and `computer_write_file`.
The shared file tools also reach the computer through `/computer`. Browserbase and Browser Use Cloud offer
`browser_navigate`, `browser_read`,
`browser_click`, `browser_fill` and `browser_evaluate`. Both offer
`computer_start`, `computer_status` and `computer_stop`.

### Computer files and transfers

After `computer_start`, `/computer` mounts the computer's home directory (`~`),
read-write. For example, `/computer/project/main.py` is `~/project/main.py` in
`computer_exec`. It is not the computer's `/`. `read`, `write`, `edit`, `ls`,
`glob` and `grep` use the same paths as other mounts. A stopped
or expired computer has no mount; calls under `/computer` say to call
`computer_start`. Browser-only connections do not have a filesystem mount.

Computer files live only as long as the session and are gone after it expires
or is stopped. Save results to a volume before then:

```js
await tools.cp({ from: "/workspace/input.bin", to: "/computer/input.bin" });
await tools.cp({ from: "/computer/result.zip", to: "/workspace/result.zip" });
await tools.mv({ from: "/computer/output", to: "/workspace/output" });
```

`cp` and `mv` take exact source and destination paths in any mounts. They return
`{from, to, files, bytes}`. Existing destinations require `overwrite: true`;
directory copies also require `recursive: true`. Each call handles at most
1,000 files. `mv` removes a source only after its copy verifies; a failed
cross-mount directory move can leave a partially moved tree, so inspect both
paths before retrying. Read-only mounts cannot receive files or have files moved
out of them. Empty directories persist only on computers; volumes hold files.

The old `computer_upload` and `computer_download` tools have been removed. Use
`cp` or `mv` instead. File contents travel between storage services and the
computer without entering the model's context. Transfers support binary files
up to 256 MiB (268,435,456 bytes) per file. Files saved to a volume get new
versions, record the agent as author, and count against storage quotas.
Computer text edits and writes are limited to 1 MiB; larger files can be copied
or read in windows. Reads and writes up to 32 KiB use inline commands; larger
ones use signed-link transfers through a writable volume. Temporary copies
live under `.camel/computer/<uuid>/` in that volume and are removed after use.
Image and PDF references pin their stored content before the temporary copy is
removed, so they survive the computer session. `present_file` keeps its copy
there as the delivered file.

The computer needs `curl`, `sha256sum`, CA certificates and outbound access to the runtime's
public API origin. The runtime supplies a signed file link that expires after
120 seconds; it is not returned to the model or recorded in logs. These links
can be reused until they expire. The runtime checks the remote file's size and
SHA-256 against the workspace file after the transfer. Each transfer has at most 120
seconds, limited by the session's remaining time. Sprites allows outbound access
by default; if you set an egress policy, allow the runtime's public host.

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

A managed computer is charged to your credit, shown as `costUsd`. Otherwise compute is billed directly to your provider account. The console reports session
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

A provider that refuses the credentials (401 or 403) on create has made nothing, so
the session closes and needs no acknowledgment. Disconnect and reconnect with a
working key.

`GET /v1/computers` lists connection and session state;
`GET /v1/computers/usage` returns the workspace breakdown;
`POST /v1/agents/{id}/computer/stop` stops a session; and
`DELETE /v1/computers/{id}` stops and disconnects it.
