# Sandbox boundary and remaining production work

js_exec runs on V8: a bare V8 isolate in a process of its own per execution, `v8-exec`
(`sandbox/v8-exec`, `src/v8-exec.ts`), started for one execution and killed when it ends, inside
the [sandbox processes](#layers). See [The V8 engine](#the-v8-engine-v8-exec). Each
`code_execution` metric line carries `Engine: v8`, and the runtime does not start if js_exec does
not run (the `listening` log line's `sandbox` field says where it runs).

Until October 2026 a second engine, QuickJS compiled to WebAssembly on pooled worker threads, was
the default, and a tenant could be pinned to either (`codeEngine`). It is gone: a tenants-file
entry with `"codeEngine": "quickjs"` stops the runtime loading the file (remove it with
`infra/tenant.sh clear-engine <tenant>` before deploying), `PUT /v1/tenants/{id}/limits` refuses a
`codeEngine` other than `null` (which clears one stored before), and `AGENT_JS_EXEC` is ignored.

## Limits of an execution

Scripts default to a 30-second external deadline. A tenant may ask for at most
60 seconds (`timeoutMs`; admin tenants 120 s), unless its operator set another
(`codeMaxTimeoutMs`, at most 120 s); a longer `timeoutMs` is cut to it.

Each execution may use 2 seconds of CPU (`codeCpuMs` per tenant, at most 30 s).
Time waiting on tools does not count. v8-exec enforces it from a watchdog thread,
and `RLIMIT_CPU` behind it ([CPU](#the-v8-engine-v8-exec)).

The guest's V8 heap is capped at 128 MiB (reaching it ends the execution) and its
ArrayBuffers at 128 MiB besides (past it, a catchable `RangeError`).

Nothing the model or a tenant supplies is parsed on the runtime's own thread.
v8-exec strips TypeScript (oxc, in linear time) and compiles the code, under the
CPU budget. On the host, tool-argument checks skip the tenant's `pattern` and
`patternProperties` regular expressions, which could backtrack for hours; the
tool checks those itself. A failed check of arguments over 16 KiB names no
fields. `tools.search` reads at most 500 characters and 32 words of a query.

**Fairness.** An execution keeps its v8-exec process while it waits on tools.
Tenants with a concurrency limit therefore share what 40% of the task's memory
affords at 128 MiB an execution (its heap limit), at least 2 and at most 32: 6 on
a 2 GB task (`AGENT_CODE_WORKERS_MAX` lowers it). Each such tenant may run 4 at
once (2 on free credit; `codeConcurrency` per tenant). Executions beyond that wait
for a turn, tenant by tenant in rotation, within their own `timeoutMs`, so a busy
tenant delays only its own. Admin tenants have no limit unless their entry sets
one: they are admitted at once and bounded only by the v8-exec processes a node
runs at once (`AGENT_V8_MAX`, 64). Their memory is the operator's to plan for.

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
External side effects cannot be rolled back by a killed process or AbortSignal.
Adapters must honor cancellation and must implement idempotency for writes.

## Layers

The guest has ECMAScript built-ins plus `tools`, `fs` (the file tools over its
mounts, answered by the runtime), `text` and captured `console` methods. There is
no `process`, `Bun`, `require`, host filesystem, `fetch`, sockets,
workers, timers, shared memory or WebAssembly. Every module import is
denied, including `node:`, `file:`, `data:` and HTTP URLs. `eval` and function
constructors stay inside the guest's V8 context; they never create host functions.

Guest code is contained by layers, each assuming the one inside it failed:

1. **A bare V8 isolate in a process of its own.** v8-exec has no Node: its one
   context holds the ECMAScript built-ins and the bootstrap's helpers, and
   nothing else. Nothing is reused between executions, so no globals, heap or
   memory carry over, and a process serves one tenant's one execution. It
   confines itself further (no JIT, a seccomp allowlist, rlimits): see
   [Confinement](#the-v8-engine-v8-exec).
2. **A separate process with its own uid.** v8-exec runs under sandbox
   processes (`src/sandbox-server.ts`, `AGENT_SANDBOX_PROCESSES`, default 2),
   not under the runtime. The image's entrypoint, `agent-launcher`
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
   crashes rare paths. Its v8-exec processes inherit all of it.

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
kills the execution's v8-exec process.

Without the launcher (macOS, tests, not root, or `AGENT_SANDBOX_PROCESSES=0`),
the runtime process spawns v8-exec itself (`src/codemode.ts`), with layer 1
only; the `listening` log line says which mode is active, and the image sets
`AGENT_SANDBOX_REQUIRED=1` so production cannot start that way. Running from a
checkout needs the binary built first (`npm run build:v8-exec`; or
`AGENT_V8_EXEC` names one). `tests/image-isolation.ts` boots the image and
proves the other layers from inside a sandbox process.

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
run inside the guest under its limits. Host errors surface as plain guest
`Error`s whose stacks are guest frames only. The module loader rejects every
import. The watchdog and memory limits are not guest-callable.

The supervisor, Pi process, tool schemas and tool implementations remain trusted
code with OS access.

The tests cover known escape patterns and limits; they are not a security audit
or proof against engine vulnerabilities. A sandbox process serves many tenants'
executions in turn, each in a fresh v8-exec process. Shared-VM operation still
needs resource quotas around the sandbox, tool-specific authorization,
controlled egress for tool hosts, and a maintained engine/security update process.

## The V8 engine: v8-exec

`v8-exec` is a Rust program on the [`v8` crate](https://crates.io/crates/v8) (rusty_v8's
prebuilt V8, the same V8 as Deno's): no Node, so no Node built-ins, modules, `process`, file system
or network to lock down. A sandbox process (or, without sandbox processes, the runtime) spawns it
for one execution, with no environment and only its three pipes, and speaks the codemode frames to
it over stdin and stdout. Nothing is reused between executions, and a cancelled or timed-out
execution's process is killed (SIGKILL).

**What code sees.** One V8 context holding the ECMAScript built-ins and `tools`, `fs`, `text` and
`console` from the bootstrap (`src/sandbox-bootstrap.ts`). There is no
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
- **Wall time and cancellation.** The runtime's timer and abort kill the process.
- **Output, tool calls and transfer.** Bounded in the process and again in the runtime.

**Confinement.** On top of what it inherits from its sandbox process (uid, `no_new_privs`, no
capabilities, agent-launcher's seccomp denylist), the process confines itself before any of the
guest's code is parsed:

- **No JIT** (`AGENT_V8_JITLESS`, on by default): V8 interprets, so its optimizing compilers, the
  usual source of V8 exploits, never run, and no memory is ever executable. CPU-bound code runs
  about 3 times slower than with the JIT; code that mostly waits on tools does not notice.
- **A seccomp allowlist** (`sandbox/v8-exec/src/seccomp.rs`) on all its threads: memory
  (`mmap`, `munmap`, `mprotect`, `madvise`, `mremap`, `brk`), `read` and `write` on its pipes,
  clocks and sleeps, futexes, signal masks, `getpid`/`gettid`/`getrandom`, exit. Any other call
  kills the process (SIGSYS), with three exceptions: `openat` fails with `EACCES` (V8 and glibc read
  `/proc/self/maps` and CPU counts as they go, and do without); `prctl` fails with `EINVAL` (V8 on
  x86_64 names the memory it maps, `PR_SET_VMA`); and `tgkill` is allowed to the process itself, so an
  `abort()` ends as one. If V8 runs out of heap for good (one allocation past it), the process answers
  `Codemode memory limit exceeded` rather than aborting. Under no-JIT, `mmap` or `mprotect`
  asking for executable memory kills it too. The filter checks the architecture (x86_64 or
  aarch64; other ABIs are killed), and fails closed: an execution whose process cannot install it
  fails. `scripts/v8-syscalls.ts` traces what the process calls (with strace, and `--seccomp-trap`, which prints a refused call and its first argument), to update the list.
- **Rlimits it cannot lift:** no processes (`RLIMIT_NPROC` 0), no file writes (`RLIMIT_FSIZE` 0),
  no core dumps, and not dumpable, so processes of its own uid (its sandbox process, other
  executions') cannot read its memory.

**Processes.** Each sandbox process runs at most `AGENT_V8_MAX` (64 by default, shared among the
sandbox processes) at once; more wait their turn within their timeout. Each sandbox process
keeps 2 started ahead (`AGENT_V8_PRESPAWN`), past V8's setup and waiting for an execution, so
most executions skip the 3 ms start. A process waiting on tools holds about 20 MB resident (4 MB
proportional: the binary's pages are shared). A process that cannot be started, or that the kernel killed (seccomp, rlimits, the OOM
killer), writes a `v8_exec` metric line (`Event`: `spawn_failed` or `killed`) and fails its
execution with what happened.

**What it does not protect against.** A V8 bug reachable from the interpreter still gives native
code in the process; it then has the allowlist above, its sandbox process's uid and filter, and
nothing of the runtime's. It shares no memory with other executions. V8's own heap sandbox is not on: rusty_v8 publishes no
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
