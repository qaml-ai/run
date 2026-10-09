### Files in tool calls: call-bound URLs, directories, and which sources get files

- Breaking: a source is sent the agent's files only when its `fileArguments` is `"on"`. That is the default for
  sources with `auth: {"type": "runtime"}`; every other MCP server and OpenAPI source is now `"off"`: its tools are
  not offered `{"$file": path}`, and a `$file` argument is a tool error that tells the model file arguments are off
  for that tool. Set `"fileArguments": "on"` on a third-party source you trust with the agent's files. chiridion's
  and camel-bots' own servers use runtime auth, so they keep getting files.
- A file goes to a tool as a URL bound to the call, `GET /v1/files/{token}/{name}`, instead of a 15-minute signed
  link: its token is an EdDSA JWT the runtime signs with its identity tokens' key (`aud: "camelrun:file"`), naming
  the tenant, agent, call, tool and the file's version. It lasts 5 minutes, takes `Range`, and answers 410 once the
  file changes. Links an application signs (`POST /v1/agents/:id/links`) are unchanged.
- Parameters marked as MCP's SEP-2631 draft marks them (`format: uri` with `x-mcp-file: {accept, maxSize,
  transferModes}`) take files: `accept` and `maxSize` are enforced, and `transferModes: ["inline"]` sends a small
  file as a `data:` URI. With `x-camelrun-directory: true` a parameter takes a directory, sent as a manifest of a
  snapshot made for the call (each file with its own URL and sha-256, and a tar.gz of them all), at most 1,000
  files and 256 MiB.
- An MCP call carries `_meta["camelrun/files"]`: each file sent as a URI, by its argument's JSON pointer, with its
  name, type, size and sha-256.
- For sources with `fileArguments` on, `resource_link` results to `https:` or `data:` URIs are saved to the
  workspace like other tool outputs; the transcript keeps their paths.
- SDKs: `verifyFileUrl` (`@camelai/run/server`) and `verify_file_url` (Python, async and `camelai_run.sync`) check
  that a URL came from the runtime for the agent a tool expects; `testRuntime().fileUrl()` and
  `TestRuntime().file_url()` make one to test with. Sources take `fileArguments` in the SDKs' types.
- Snapshot names starting with `file-arg:` are the runtime's own.
- See [Files in tool calls](../guides/tools.md#files-in-tool-calls).
