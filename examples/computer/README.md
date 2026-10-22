# An agent with a Linux computer

This example gives a camelRun agent a private remote Linux environment. It can
install packages, write programs, run subprocesses and keep a web server alive
between turns. The model loop and history stay in camelRun; commands execute at
Modal, Daytona, boat.dev or E2B. The provider key stays in this adapter process.

This is an **attached-tool integration example**, not a hosted camelRun computer
service. Run the adapter while testing. There is no native `computer` option in
the console, and these provider charges are not included in camelRun workspace
spend. A shell also does not provide a graphical desktop or screenshot tool.

## Run

Requires Python 3.11+. From the repo root, create a virtual environment and
install the camelRun client plus only the provider you want:

```sh
python3 -m venv .venv-computer
.venv-computer/bin/pip install -e clients/python 'modal==1.2.4'
# Alternatives: 'daytona==0.226.0' 'anyio>=4.14,<5' or 'boat-sdk==1.10.0'
```

Set `CAMELAI_API_KEY`, and optionally `CAMELAI_BASE_URL` and
`CAMELRUN_WORKSPACE_ID`. For Modal, run `modal token new` or set `MODAL_TOKEN_ID`
and `MODAL_TOKEN_SECRET`. For Daytona set `DAYTONA_API_KEY` (and
`DAYTONA_API_URL` if needed); for boat set `BOAT_API_KEY`. Never put keys in
the agent prompt or copy them into its computer.

```sh
.venv-computer/bin/python examples/computer/agent.py \
  --provider modal --model azure/gpt-6-luna --evidence /tmp/modal-computer.json
```

Use `--provider daytona` or `--provider boat` to run the same workload there.
Choose a model available in your camelRun account. Each invocation creates a new
agent; its history remains for inspection. The computer is removed at the end.

The first turn installs `humanize`, writes a local HTTP server and state file,
starts the server, compiles the Python file, and calls its endpoint. A second
turn updates the stored counter and calls the **same running server**. A final
check outside the model confirms the response and file contents. Evidence
includes provider/computer IDs, agent/run IDs, tool calls, model usage, timing,
verification and cleanup. It is private (mode 0600); it can contain command
output and model-generated code.

Limits: one computer, 1 USD of model calls, 300 seconds per model turn, at most
120 seconds per shell command, and a 15-minute computer lease. Cleanup runs in
`finally`. Modal also has a provider-enforced 15-minute timeout; boat auto-stops
after 15 minutes; Daytona uses 15-minute idle auto-stop and an ephemeral sandbox.
Daytona's idle timeout is not a hard lifetime if background activity keeps it
alive. Provider API outages or killing this adapter can leave cleanup unfinished:
use the recorded computer ID to check the provider. A create call with an unknown
outcome also needs a provider-side check. This example never retries creation.

Commands are serialized and a retried call is not executed twice while this
process lives. After a provider error the outcome is marked uncertain. This
in-memory retry cache does not survive restarting the adapter. It never executes
commands on the adapter's own host. Tool output returned to the model is capped
at 24,000 characters per stream; provider SDKs may buffer more before truncation.
Only the bound agent can use the tools. Provider credentials are not injected
into the sandbox; boat also disables its account's default environment injection.

Run offline boundary tests with:

```sh
python3 -m unittest discover -s examples/computer -p 'test_*.py'
```

## Live verification

The same two-turn workload passed on Modal, Daytona and boat.dev using
`azure/gpt-6-luna`. Each run installed a package in a virtual environment,
started an HTTP server and updated its state in a later turn. An independent
HTTP/file check verified the result, and provider lookups confirmed cleanup.
These were functional tests, not controlled latency or cost benchmarks.

## What native support still needs

The product should let a customer attach a computer to an agent without running
this adapter. That requires:

- A sealed provider connection and an agent-owned durable computer record.
- Idempotent allocation and command records, recovery after a runtime restart,
  bounded concurrent commands, cancellation and orphan cleanup.
- Explicit choices for a persistent disk versus a disposable task environment.
- File transfer between the computer and camelRun volumes, with artifact links.
- Separate capabilities for shell, browser, graphical desktop, Docker and GPU;
  providers do not all offer the same machine or isolation boundary.
- Provider usage receipts attributed to the agent/workspace, separate from model
  cost until billing is reconciled, plus a computer spending limit.

The adapters here cover create, execute and destroy only. They do not claim
provider parity for snapshots, pause/resume, desktop streaming, GPUs or networking.
Keep the existing restricted `js_exec` unchanged: a full Linux computer is an
additional opt-in environment with its own lifecycle.

Provider references: [Modal sandboxes](https://modal.com/docs/guide/sandboxes),
[Daytona SDK](https://www.daytona.io/docs/en/python-sdk/sync/daytona/),
[boat Python SDK](https://docs.boat.dev/sdks/python).

## E2B and Browserbase

Install `e2b==2.59.0`, set `E2B_API_KEY`, then run the same agent with
`--provider e2b`. E2B uses a secure sandbox with a provider-enforced lease.
Nonzero shell exits are returned as command results so the agent can inspect them.

Browserbase provides a browser capability, not a shell or Linux filesystem.
Install `browserbase==1.21.0` and `playwright==1.48.0`, set
`BROWSERBASE_API_KEY` (optionally `BROWSERBASE_PROJECT_ID`), and run:

```sh
.venv-computer/bin/python examples/computer/agent.py \
  --provider browserbase --evidence /tmp/browserbase-computer.json
```

No local browser download is needed: Playwright connects to the remote browser.
The agent gets navigation, visible-page reading, click, fill and page-JavaScript
operations. Its two-turn test creates page state on example.com, then clicks a
button in the same browser to update that state. An independent check verifies
the stored counter. The session is released in `finally`, with a 15-minute
provider timeout as a fallback. Connection credentials stay out of model tools.
This example does not yet send screenshots to the model or enable persistent
Browserbase contexts across separate runs.

## Bring your own computer through Cloudflare Tunnel

On a machine with Python 3.11+, Docker, and `cloudflared` installed, run:

```sh
python3 examples/computer/tunnel_server.py --tunnel \
  --connection-file /tmp/camelrun-computer-connection.json
```

This starts one disposable Linux container and a temporary Cloudflare Tunnel.
The HTTP server binds only to loopback. Every request requires a random bearer
credential, separate from the tunnel address, and only one client can claim the
session. The connection file is mode 0600 and contains both values. Transfer it
privately to the adapter machine; never paste its contents into an agent prompt,
commit it, or share it with another tenant. On the adapter machine:

```sh
export CAMELRUN_COMPUTER_CONNECTION=/path/to/private-connection.json
.venv-computer/bin/python examples/computer/agent.py \
  --provider tunnel --evidence /tmp/tunnel-computer.json
```

The adapter runs the same Linux workload through HTTPS. Closing it removes the
container, ends the tunnel, and deletes the original connection file. Ctrl-C or
lease expiry on the host also cleans up. Any transferred copy remains yours to
delete. A forced kill or host crash can leave a stopped container; use the printed
computer ID with `docker rm -f` to remove it. The container's main process has a
15-minute lifetime even if the runner dies, but no external reaper is installed.

A tunnel transports requests; it does not grant access by itself. The runner
checks authentication before reading a request body and binds requests to a
single claim. It limits command duration, output, connection concurrency and
session command count. It never mounts host directories, the Docker socket, or
host credentials into the container, and it drops Linux capabilities. It requires
Docker: there is no fallback that runs model commands directly on your host.
Containers still share the Docker host's kernel; use a dedicated VM for stronger
isolation. Internet access from the container is enabled for package installs.

For an existing named tunnel, configure it to forward to a fixed loopback port,
then run `--port 8788 --url https://computer.example.com` instead of `--tunnel`.
Keep the bearer authentication enabled even with Cloudflare Access. This example
does not automate named-tunnel provisioning, Cloudflare Access service tokens,
account pairing, device lists, reconnects, or unattended background services.
Temporary tunnels are intended for testing. A connection does not survive a
runner restart; command receipts and claims are process-local.

This follows the separation of transport and application authorization described
in [T3 Connect](https://github.com/pingdotgg/t3code/blob/main/docs/internals/t3-connect.md),
with a smaller single-session protocol rather than T3's identity relay.
See [Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/get-started/),
[E2B](https://docs.e2b.dev/), and
[Browserbase Playwright](https://docs.browserbase.com/welcome/quickstarts/playwright).
