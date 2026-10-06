# Sandbox boundary and remaining production work

## Engines

Two engines run js_exec, each inside the [sandbox processes](#layers):

- **QuickJS** (`quickjs`): QuickJS compiled to WebAssembly, on pooled worker threads that each
  restore a snapshot between executions (`src/quickjs-sandbox.ts`). The limits and layers below
  describe it unless they say otherwise.
- **V8** (`v8`): a bare V8 isolate in a process of its own per execution, `v8-exec`
  (`sandbox/v8-exec`, `src/v8-exec.ts`), started for one execution and killed when it ends. See
  [The V8 engine](#the-v8-engine-v8-exec).

`AGENT_JS_EXEC` (`quickjs` or `v8`; default `quickjs`) is the runtime's engine. A tenant's own
overrides it: an admin tenant's tenants-file entry (`"codeEngine": "quickjs"`), or a self-serve
tenant's `PUT /v1/tenants/{id}/limits` with `{"codeEngine": "v8"}` (`null` returns it to the
runtime's). An agent takes its engine when its host starts, so a change reaches agents as they next
load. Each `code_execution` metric line names the engine that ran it (`Engine`), and the `listening`
log line's `sandbox` field reports the default (`engine`) and whether each engine runs (`engines`);
the runtime does not start if its default does not. Plan for a rollout: V8 the default, the
heaviest tenants pinned to `quickjs` in the tenants file, then their pins removed one by one.

## Limits of an execution

Scripts default to a 30-second external deadline. A tenant may ask for at most
60 seconds (`timeoutMs`; admin tenants 120 s), unless its operator set another
(`codeMaxTimeoutMs`, at most 120 s); a longer `timeoutMs` is cut to it.

Each execution may keep its worker thread busy for 2 seconds (`codeCpuMs` per
tenant, at most 30 s). Time waiting on tools does not count. This is enforced
twice. The QuickJS interrupt handler stops guest code between bytecodes. The
pool's watchdog (`src/codemode.ts`) reads the worker thread's event-loop
utilization every 50 ms from outside it and terminates the thread at the budget
plus 250 ms, whatever it is doing. That covers built-ins that never reach the
interrupt handler (a long `indexOf`, a huge BigInt's digits) and preparing the
source. Busy time is CPU time while the host has a core for the thread; on an
oversubscribed host it also counts the wait for one, so an execution there is
stopped sooner. A cancelled guest that has not unwound 250 ms later has its
worker terminated and replaced too.

Every invocation has fixed 32 MiB WebAssembly memory, a 16 MiB QuickJS
allocation limit and a 256 KiB interpreter stack limit. These are guest limits;
each worker thread's own JavaScript heap is capped at 128 MiB.

Nothing the model or a tenant supplies is parsed on the runtime's own thread.
The worker strips TypeScript (sucrase, which can take exponential time on
hostile input) and compiles the code, under the CPU budget. On the host,
tool-argument checks skip the tenant's `pattern` and `patternProperties`
regular expressions, which could backtrack for hours; the tool checks those
itself. A failed check of arguments over 16 KiB names no fields. `tools.search`
reads at most 500 characters and 32 words of a query.

**Fairness.** An execution keeps its worker, about 85-100 MB resident, while it
waits on tools. Tenants with a concurrency limit therefore share what 40% of the
task's memory affords at 128 MiB a worker, at least 2 and at most 32: 6 on a
2 GB task. Each such tenant may run 4 at once (2 on free credit; `codeConcurrency`
per tenant). Executions beyond that wait for a turn, tenant by tenant in
rotation, within their own `timeoutMs`, so a busy tenant delays only its own.
Admin tenants have no limit unless their entry sets one: they are admitted at
once and bounded only by the pool's workers (at most 32 a node,
`AGENT_CODE_WORKERS_MAX`), as before. Their memory is the operator's to plan for.

**Stuck agents.** Under `process` hosting the supervisor pings each agent
process every 5 s and kills one that leaves a ping unanswered for 30 s. A run
still going 60 s past its time limit (`maxRunSeconds`) is aborted, and its agent
is stopped 60 s after that. Either way the run fails, and the agent's next start
closes the interrupted turn, as after a crash.

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
   compiles the QuickJS module once. It then builds one instance, runtime and
   context in a fixed, bounded WASM memory, runs the bootstrap, and snapshots
   that memory before any guest code runs. Every execution starts from the
   snapshot with a fresh `Math.random` seed. When it ends, however it ends, the
   whole memory is written back to the snapshot: the snapshot's pages where it
   has any, and zeros everywhere else, including pages the guest grew. Globals,
   prototypes, heap and stack therefore never carry over, and the memory holds no
   guest's data between executions (`tests/sandbox-snapshot.test.ts`). A failure
   outside the guest's own errors (a trap, say) drops the image, and the next
   execution builds a new one. One worker runs one execution at a time, for any
   tenant in turn. Guest code only ever sees the QuickJS heap, never the worker's
   Node globals, `process.env`, modules or the filesystem.
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
or proof against engine vulnerabilities. A worker, and a sandbox process, serve
many tenants' executions in turn. The snapshot restore removes what a guest left
in QuickJS's memory, but an escape out of WASM into the worker could persist
there and see later executions routed to it. Shared-VM operation still needs resource quotas around the
sandbox, tool-specific authorization, controlled egress for tool hosts, and a
maintained engine/security update process.

## The V8 engine: v8-exec

`v8-exec` is a Rust program on the [`v8` crate](https://crates.io/crates/v8) (rusty_v8's
prebuilt V8, the same V8 as Deno's): no Node, so no Node built-ins, modules, `process`, file system
or network to lock down. A sandbox process (or, without sandbox processes, the runtime) spawns it
for one execution, with no environment and only its three pipes, and speaks the same frames to it
as to a QuickJS worker over stdin and stdout. Nothing is reused between executions: there is no
snapshot to restore, and a cancelled or timed-out execution's process is killed (SIGKILL).

**What code sees.** One V8 context holding the ECMAScript built-ins and `tools`, `fs`, `text` and
`console` from the same bootstrap as QuickJS's (`src/sandbox-bootstrap.ts`). There is no
`SharedArrayBuffer`, `Atomics` or `WebAssembly`; every `import()` is refused. `Intl` works: ICU
data is compiled in (any locale; `en-US` and UTC by default). TypeScript is stripped in the process
by [oxc](https://oxc.rs) (types removed, enums and parameter properties compiled), in linear time.

**Limits**, each enforced in the process and the next one outside it:

- **CPU.** A watchdog thread reads the process's CPU time every 5 ms; at the budget (`codeCpuMs`, 2 s
  by default) it terminates V8 (`Codemode CPU limit exceeded: …`), and if V8 has not stopped 250 ms
  later (a long built-in), it answers with the same error and exits. `RLIMIT_CPU`, in whole seconds
  past both, kills a process that got around the watchdog.
- **Memory.** The V8 heap is capped at 128 MiB: reaching it ends the execution
  (`Codemode memory limit exceeded`), which code cannot catch. ArrayBuffers, outside the heap, are
  counted by the process's allocator and refused past 128 MiB, as a catchable `RangeError`.
  `RLIMIT_DATA` (512 MiB of writable mappings) backs both; `RLIMIT_AS` cannot, since V8 reserves
  about 17 GB of address space it never touches.
- **Wall time and cancellation.** The runtime's timer and abort, as for QuickJS, kill the process.
- **Output, tool calls and transfer.** The same bounds as QuickJS's, in the process and again in the runtime.

**Confinement.** On top of what it inherits from its sandbox process (uid, `no_new_privs`, no
capabilities, agent-launcher's seccomp denylist), the process confines itself before any of the
guest's code is parsed:

- **No JIT** (`AGENT_V8_JITLESS`, on by default): V8 interprets, so its optimizing compilers, the
  usual source of V8 exploits, never run, and no memory is ever executable. CPU-bound code runs
  about 3 times slower than with the JIT (still several times faster than QuickJS); code that
  mostly waits on tools does not notice.
- **A seccomp allowlist** (`sandbox/v8-exec/src/seccomp.rs`) on all its threads: memory
  (`mmap`, `munmap`, `mprotect`, `madvise`, `mremap`, `brk`), `read` and `write` on its pipes,
  clocks and sleeps, futexes, signal masks, `getpid`/`gettid`/`getrandom`, exit. Any other call
  kills the process (SIGSYS), except `openat`, which fails with `EACCES` (V8 and glibc read
  `/proc/self/maps` and CPU counts as they go, and do without). Under no-JIT, `mmap` or `mprotect`
  asking for executable memory kills it too. The filter checks the architecture (x86_64 or
  aarch64; other ABIs are killed), and fails closed: an execution whose process cannot install it
  fails. `scripts/v8-syscalls.ts` traces what the process calls, to update the list.
- **Rlimits it cannot lift:** no processes (`RLIMIT_NPROC` 0), no file writes (`RLIMIT_FSIZE` 0),
  no core dumps, and not dumpable, so processes of its own uid (its sandbox process, other
  executions') cannot read its memory.

**Processes.** Each sandbox process runs at most `AGENT_V8_MAX` (64 by default, shared among the
sandbox processes) at once; more wait their turn within their timeout. When V8 is the default,
each sandbox process keeps 2 started ahead (`AGENT_V8_PRESPAWN`), past V8's setup and waiting for
an execution, so most executions skip the 3 ms start. A process waiting on tools holds about
20 MB resident (4 MB proportional: the binary's pages are shared), against 45-100 MB for a QuickJS
worker. A process that cannot be started, or that the kernel killed (seccomp, rlimits, the OOM
killer), writes a `v8_exec` metric line (`Event`: `spawn_failed` or `killed`) and fails its
execution with what happened.

**Compared with QuickJS**, as agents see it: V8's error messages and stack traces; `Intl`,
`Temporal`, `DisposableStack` and `SuppressedError` exist, `InternalError` does not; heap exhaustion
ends the execution instead of throwing; ArrayBuffers may hold 128 MiB, not 32. Code runs 4-10 times
faster. A trivial execution costs about 3 ms of CPU against QuickJS's 0.4 ms, mostly V8 starting.

**What it does not protect against.** A V8 bug reachable from the interpreter still gives native
code in the process; it then has the allowlist above, its sandbox process's uid and filter, and
nothing of the runtime's. It shares no memory with other executions (unlike a QuickJS worker,
which serves many tenants in turn). V8's own heap sandbox is not on: rusty_v8 publishes no
prebuilt library with it.

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
