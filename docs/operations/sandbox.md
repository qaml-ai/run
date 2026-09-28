# Sandbox boundary and remaining production work

## Limits of an execution

Scripts default to a 30-second external deadline, capped at 120 seconds. The
QuickJS interrupt handler separately allows 2 seconds spent executing guest code
(elapsed execution time, excluding time waiting for tools). Expensive built-ins
that do not invoke the interrupt handler are still bounded by the external
deadline: a guest that has not unwound 250 ms after it is cancelled has its
worker thread terminated and replaced. Every invocation has fixed 32 MiB WebAssembly memory, a 16 MiB
QuickJS allocation limit and a 256 KiB interpreter stack limit. These are guest
limits; each worker thread's own JavaScript heap is capped at 128 MiB.

Output defaults to 32,000 characters, capped at 128,000 and 1,024 emitted chunks.
Each script permits 256 tool calls with at most 32 in flight; arguments are
limited to 128 KiB JSON, results to 1 MiB JSON and aggregate tool traffic to
8 MiB. Tools are allowlisted and their arguments validated against host-owned
schemas before dispatch. Call results are copied as JSON, never host references.
All tool calls must be awaited; unfinished calls on return are rejected and
pending calls are cancelled. Cancellation cannot undo effects already dispatched.
Guest requests cannot change the executable, memory limits, workspace or tools.
Script failures, timeouts and cancellation leave the agent process available.
Tool RPCs are correlated by unique IDs, so reverse completion order is safe.
External side effects cannot be rolled back by a worker termination or AbortSignal.
Adapters must honor cancellation and must implement idempotency for writes.

## Layers

The guest has ECMAScript built-ins plus `tools`, `fs` (the file tools over its
mounts, answered by the runtime), `text` and captured `console` methods. There is
no `process`, `Bun`, `require`, host filesystem, `fetch`, sockets,
workers, timers, shared memory or nested WebAssembly. Every module import is
denied, including `node:`, `file:`, `data:` and HTTP URLs. `eval` and function
constructors stay inside QuickJS; they never create host functions.

Guest code is contained by layers, each assuming the one inside it failed:

1. **QuickJS compiled to WebAssembly.** A worker (`src/code-worker.ts`)
   compiles the QuickJS module once; every execution instantiates it with its
   own fixed WASM memory, then creates a new runtime and context, and drops all
   three when it ends. No guest state survives an execution, and one worker runs
   one execution at a time. Guest code only ever sees the QuickJS heap, never the
   worker's Node globals, `process.env`, modules or the filesystem.
2. **A separate process with its own uid.** The workers run in sandbox
   processes (`src/sandbox-server.ts`, `AGENT_SANDBOX_PROCESSES`, default 2),
   not in the runtime. The image's entrypoint, `agent-launcher`
   (`sandbox/launcher.c`), starts as root under the container's init and runs
   the runtime as `node` (uid 1000) and sandbox process *i* as uid 1001 + *i*
   (group `sandbox`, no supplementary groups), so a sandbox process cannot read
   another process's `/proc/<pid>/environ` or `mem`, or trace it. It restarts a
   sandbox process that dies, forwards termination signals to the runtime and
   exits with its status.
3. **No network, no secrets.** A sandbox process starts with an empty
   environment (a fixed `PATH`, `HOME` and `TMPDIR` only), `/dev/null` for stdin
   and no descriptors but its socket. The runtime's data directory (`/data`,
   mode 0700) is unreadable to it, and secrets are never in any environment it
   can see. It has no capabilities, `no_new_privs`, and a seccomp filter
   installed before `exec`: every `socket()` fails (`AF_UNIX` included), as do
   `ptrace`, `process_vm_readv`/`writev`, `pidfd_getfd`, the keyring calls,
   `mount`, `unshare`/`setns` and namespace flags to `clone`, `bpf`,
   `perf_event_open`, `userfaultfd`, `io_uring` (which could open sockets past
   the filter), `kexec`, module loading and `reboot`; other architectures' calls
   kill it. It is a denylist: Node, V8, libuv and glibc use a syscall set that
   shifts with their versions and the kernel, and an allowlist that misses one
   crashes rare paths.

The launcher binds one unix socket per sandbox process at
`/run/agent-sandbox/<i>.sock` (root:node 0660, in a root:node 0710 directory, so
only the runtime's uid connects) and hands it over as fd 3; a sandbox process
cannot reach its own socket's path, only accept on it. Each execution is one
connection carrying length-prefixed JSON frames (at most 4 MiB each; either side
drops the connection on anything bigger or malformed); closing it cancels the
execution. The runtime sends each execution to the process with the fewest open,
and at startup checks that every one answers. A sandbox process that dies fails
the executions it held with "Codemode sandbox process exited", and new ones queue
on its socket until the launcher has restarted it.

The runtime treats a sandbox process as compromised: it accepts only tool-call
requests, output events and the execution's answer, rebuilt from checked fields;
it caps the number of messages, holds output to the caller's character and event
limits, validates the result, and enforces tool schemas, call count, concurrency,
and result and transfer size limits on its side, as it always has. Cancellation
reaches a guest spinning in QuickJS through a shared flag its interrupt handler
polls, and one awaiting a tool through the closed connection and message port.

Without the launcher (macOS, tests, not root, or `AGENT_SANDBOX_PROCESSES=0`),
js_exec runs on the same pool of worker threads inside the runtime process
(`src/codemode.ts`), with layer 1 only; the `listening` log line says which mode
is active, and the image sets `AGENT_SANDBOX_REQUIRED=1` so production cannot
start that way. `tests/image-isolation.ts` boots the image and proves the other
layers from inside a sandbox process.

What guest code can reach on the host, all through the trusted bootstrap
(`src/sandbox-bootstrap.ts`) and never as globals:

- `call(name, argsJson)`: a string name of at most 80 characters and a JSON
  string of at most 128 KiB. It returns a promise settled with the result as a
  JSON string, or rejected with an error carrying only a message of at most
  2,048 characters (tool errors keep the message the application's tool threw).
- `emit(text, flags)`: a string of at most 128,000 characters and whether it was
  cut there, is the code's return value, or is JSON, returning nothing.
- The tool catalog (names, descriptions and parameter schemas), as one JSON
  string at start.

Arguments cross as strings the host copies out after checking their length;
guest objects are never read from the host, so getters, proxies and `toJSON`
run inside QuickJS under its limits. Host errors surface as plain guest
`Error`s whose stacks are guest frames only. The module loader rejects every
import. The interrupt handler and memory limits are not guest-callable.

The WASM linear memory has equal initial and maximum sizes, and initialization
checks that QuickJS actually uses that memory. This matters because the pinned
QuickJS package's `setMemoryLimit` alone can undercount large arrays/strings:
[upstream report #271](https://github.com/justjake/quickjs-emscripten/issues/271).
Regression tests allocate retained bulk arrays and strings beyond the nominal
heap limit and verify that the fixed WASM boundary stops them.

The supervisor, Pi process, tool schemas and tool implementations remain trusted
code with OS access.

The tests cover known escape patterns and limits; they are not a security audit
or proof against engine vulnerabilities. A sandbox process serves many tenants'
executions in turn, so an escape that persists in one would see later executions
routed to it. Shared-VM operation still needs resource quotas around the
sandbox, tool-specific authorization, controlled egress for tool hosts, and a
maintained engine/security update process.

## Parsing untrusted files

Inspecting an image's header or a PDF (page count, and text for models that
cannot read PDFs) parses untrusted input, so it never runs on the runtime's
main thread, which holds secrets and database credentials. With sandbox
processes (production) the bytes go over the sandbox socket in frames of 2 MiB,
and the sandbox process (its own uid, empty environment, no sockets, seccomp)
parses them on a worker thread; an exploit reaches nothing, and a crash takes
down only that process, which the launcher restarts. Without sandbox processes
(development) the worker runs in the runtime process. Either way the worker has
a 256 MiB V8 heap, 10 seconds, and a ceiling of 512 MiB on its process's
resident memory, checked every 20 ms: pdf.js inflates streams into
ArrayBuffers, which heap limits do not count, so a 400 KB PDF that inflates to
400 MB is stopped by the ceiling. Answers are rebuilt from checked fields
(`inspection` in `src/inspect.ts`). PDFs are parsed with
[unpdf](https://github.com/unjs/unpdf) (pdf.js, pure JavaScript, no native
addons, `isEvalSupported: false`). Images are only measured: their bytes go to
the provider as they were uploaded.
