# Integration seam and next extraction

`AgentSupervisor` is the embeddable host API. `ToolBridge` is the key platform
boundary: it contains discoverable JSON schemas and `call(name,args,signal)`.
The [client adapters and runnable demos](../reference/sdk.md) implement this bridge
over SSE plus HTTP POST, with replay, execution claims, and recorded outcomes. The TypeScript release board and Python
SQLite inventory app each expose their own functions while the hosted agent
owns the model loop, sandbox and history. Run both with `npm run demo:clients`
(install the documented Python dependency first).
The agent and its scripts never import DO classes. A production adapter should
implement the bridge with a short-lived, thread-scoped RPC capability back to
the Worker, retaining its authorization and confirmation checks.

The application no longer owns model retries, model-context compaction, or
isolate-death recovery. A browser/DO reconnect observes the saved service request
ID. It never re-prompts the model to reconstruct a UI stream. The DO retains only
a UI turn marker, the SDK event cursor, and a render projection.

The service persists native messages and tool outcomes. A killed service run
resumes on the next node with "outcome unknown" tool results (at most twice,
then it completes with an uncertain error); unknown side effects are never
automatically repeated. The service retries transient provider errors itself,
so no degraded retry ladder, salvage mode, or retry budget is needed in the
application.

Remaining production migration work includes model/provider reconfiguration,
billing enforcement at the inference boundary, and testing application tools
under real deployment conditions. Configuration changes wait for a running turn;
they do not abort and regenerate it.

## Primitives for runtime features

Channels, tools and the console build on these:

- `volumes.put(tenant, volumeId, path, bytes | stream, { contentType?, ifMatch?, by?, limit? })`
  saves a file from any node, sniffing its type when none is given.
- `clients.upload(session, requestId, name, source, contentType?)` (or
  `uploadFor(agent, tenant, ...)`, from any node) saves an attachment where the
  agent's attachments go and returns its path; a prompt then carries `files: [{path}]`.
- `clients.fileFor(agent, tenant, path)` and `clients.linkFor(agent, tenant, path, expiresIn?)`
  give a file in the agent's mounts as a reference, or a signed download link, from any node.
- `fileRef(volumes, tenant, volumeId, shownPath, entry)` (`src/inspect.ts`)
  makes the transcript's reference, inspecting the file in the sandbox.
- `links.sign({ tenant, volume, path, method, expiresIn?, maxBytes?, contentType? })`
  (`FileLinks` in `src/files.ts`) returns `{url, expiresAt, ...}`.
- `downloadHeaders(contentType, name)` and `fileResponse(volumes, tenant, entry, range?)`
  serve a file safely from the runtime's origin.
