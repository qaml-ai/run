### Pi code mode replaces js_exec

The model now calls Pi's stock `codemode` tool with `{ code }`. The old
`js_exec` name and its `timeoutMs`, `maxOutputCharacters` and `description`
arguments are gone. The name `codemode` is reserved. A script can start with
`// @options: {"max_output_tokens": 10000, "timeout_ms": 60000}`; its timeout
can only shorten the runtime's deadline.

The engine remains v8-exec, with a process per script, seccomp, CPU and memory
limits. Scripts are now durable: after a node stops, Pi replays its journal
without repeating completed calls. A call in flight when the node stopped
rejects with an unknown outcome. `execute` requests and schedules with `code`
still run outside history without durable replay and return
`{ output: string[], truncated }`, now only when the script ends: `execute` no
longer streams `output` events as it runs. Stored schedule code, and other
saved code, that uses `tools.search`, `tools.describe` or `tools.namespaces`,
or `fs`'s synchronous calls, fails from this release: rewrite it with
`searchTools`/`describeTool` (below) and `await fs.readFile` and the like.

Scripts call `await tools.<name>(args)` for the tool's data; a tool error
rejects with its message. Discovery uses `ALL_TOOLS`, `searchTools`,
`describeTool` and `describeNamespace`. These replace `tools.search`,
`tools.describe` and `tools.namespaces`. The system prompt lists tools by
namespace up to about 3,000 tokens. The reranked search service is removed;
`AGENT_TOOL_SEARCH` and its key, secret, URL and model settings are no longer read.

Use the file tools through `tools.read`, `tools.write`, `tools.ls`,
`tools.glob`, `tools.grep`, `tools.edit`, `tools.mv` and `tools.cp`. `fs` is js_exec's, kept on the file tools: `await fs.readFile(path)` (UTF-8 text, or base64 with `"base64"`), `fs.writeFile(path, text or a typed array)`, `fs.appendFile`, `fs.readdir`, `fs.exists` and `fs.mkdir`, also as `require("fs")` and `fs.promises`; its synchronous calls are not there.
`store(key, value)` and `load(key)` keep JSON values across code calls in a
conversation. `console.log`, `text`, `image`, top-level `return` and `exit`
are available.

The model reads `Script completed` or `Script failed`, wall time and output.
The returned value follows text items; console lines appear in
`<console_output>`. Failures include the error and calls made before it.
The output budget defaults to 10,000 tokens; past it the model reads the start
and end, and the whole output is saved in the workspace (`tool-results/`), as
are the images a script shows. Whatever a script's options ask, the result's
text is held to 128,000 characters. The runtime limits each script to 2
seconds of CPU by default, a 128 MiB heap, 60 seconds of wall time by default
(at most 120), 256 calls, 32 concurrent calls, 1 MiB per tool result and 8 MiB
of results in all (counted afresh when a script resumes after a restart), and 128 KiB per call's arguments. Output past 1,024 prints
or 128,000 bytes of text, or past 16 images or 8 MiB of them, is left out with
a note where it stopped; the script still completes (js_exec failed instead).

Calls from code use the model's `codemode` call id as `toolCallId` and Pi's
keys (`c1`, `c2`, …) as `innerCallId`, replacing keys such as `call_x:1`.
Idempotency keys hash these identities. Run outcomes list the calls as
`{ tool, toolCallId, innerCallId: "c1", ok }`.

The `codemode` stream event is removed from the SDK and event reference.
The model's code call emits ordinary `tool_execution_start` and
`tool_execution_end` events. Inner calls emit neither; MCP progress arrives
as `tool_execution_update` on the parent call, with `toolName: "codemode"`.

Approval and judged tools, human input, background multi-agent tools
still require direct model calls. `codeMode: false` still removes code mode.
Deprecated exposure values remain `direct`, `codemode` and `both`;
`codemode` means only callable from code. With `fileTools: false`, where `fs`
was the way to reach the workspace, scripts call the file tools instead: the
model is not offered them, but code can call `tools.read`, `tools.write` and
the rest. See `docs/guides/tools.md`, `docs/reference/limits.md` and
`docs/reference/events.md`.

Rolling back to an earlier release is safe for conversations mid-script: it has
no `codemode` tool, so it ends a `codemode` call left open as interrupted ("Tool
codemode was interrupted; its outcome is unknown and it may or may not have
run") and the turn goes on; calls the script had made are not made again.
