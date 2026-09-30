# Files

Every agent has files: its own workspace at `/workspace` by default, or the
**volumes** you mount. Files you attach to a message land there, the model works
on them with its file tools and with code, tools save their outputs there, and
you read what the agent made by path.

## Attaching files to a message

```ts
const run = await agent.run("What changed in Q3?", {
  files: ["./q3.pdf", screenshotBytes, new File([csv], "data.csv"), { path: "/workspace/notes.md" }],
});
```

```python
run = await agent.run("What changed in Q3?", files=[Path("q3.pdf"), screenshot_bytes, {"name": "data.csv", "data": csv}, {"path": "/workspace/notes.md"}])
```

A file is bytes, a `Blob` or `File`, `{name, data, contentType?}`, a local path
(the Node entry `@camelai/run/node`, or a `str`/`Path` in Python), or
`{path}` for a file already in the agent's mounts. The SDKs upload each first,
streamed, to `uploads/<run id>/<name>` in the agent's workspace, then send the
message referring to them by path, so a retried run never uploads twice.

- At most 20 files per message, each at most 256 MiB.
- Over REST, upload with `PUT /v1/agents/:id/uploads/:requestId/:name`, then
  `POST /v1/agents/:id/prompt {text, requestId, files: [{path}]}`. The prompt also
  takes small files inline, `{name, data: <base64>, contentType?}`, up to 4 MiB in
  all.

## What the model sees

The message carries a line per file, such as
`[File /workspace/uploads/r1/q3.pdf (application/pdf, 2.1 MB)]`, and the file
itself where the model can take it:

| | Shown natively | Limits |
| --- | --- | --- |
| Images (PNG, JPEG, GIF, WebP) | models with image input | 5 MiB and 8,000 px a side each |
| PDFs | Anthropic, Google, OpenAI and OpenRouter models with image input | 16 MiB and 100 pages each |
| Per model request | | 24 MiB and 100 files shown; older files past that are named only |

Anything else is only named, and the model reads it with its file tools. The
transcript keeps a reference to each file's content, never its bytes, so a file
changed or deleted later still reads as it was when attached.

## The agent's file tools

`read`, `write`, `edit`, `ls`, `glob` and `grep` work on mount paths
(`/workspace/notes.md`). `read` shows an image or PDF to a model that can view
it. Every file has a version, and `write` and `edit` take one, so an edit based on
a stale read fails and the model reads again. An application whose own tools
handle files can leave these out with `fileTools: false` (in a definition, or when
the agent is made).

Code in `js_exec` has `fs` over the same mounts:

```js
const csv = await fs.readFile("/workspace/data.csv", { encoding: "utf8" });
await fs.writeFile("/workspace/out/chart.png", png, { contentType: "image/png" });
await fs.stat("/workspace/out/chart.png");  // {path, type, size, version, updatedAt, contentType}
await fs.list("/workspace/out");
```

One `fs` call moves at most about 700 KiB; read larger files in windows with
`tools.read({ path, offset, encoding: "base64" })`.

## Files out

A run lists what it wrote: `run.files` (`[{path, version, size, contentType}]`,
every file written, up to 100) and, in `run.raw.presented`, the files the model
handed over with `present_file` (with a caption). Each presented file is also a
`file_presented` event as soon as it is presented, with a signed download `url`.

Read them with the agent's own access:

```ts
const { data, contentType } = await agent.files.download("/workspace/out/chart.png");
const listing = await agent.files.list({ path: "/workspace/out" });
const link = await agent.files.link("/workspace/out/report.pdf", { expiresIn: 3600 }); // for a browser or another service
await agent.files.upload("/workspace/in/config.json", JSON.stringify(config));
```
Python has the same: `agent.files.download(path)` (`.data`, `.content_type`, `.version`), `list(path=...)`,
Python has the same: `agent.files.download(path)`, `list(path=...)`,
`link(path, expires_in=...)`, `upload(path, data)`.

## Volumes

A volume is a shared file tree. Without `mounts`, each agent gets its own
workspace volume at `/workspace`; mount the same volume in several agents to
share files, read-only or read-write:

```ts
const docs = await agents.runtime.createVolume({ name: "shared docs" });
await agents.runtime.volume(docs.id).write("handbook.md", handbook);
const agent = await agents.upsert("support", { mounts: [{ volumeId: docs.id, path: "/docs", mode: "ro" }], … });
```

- Mounts are `{volumeId, path, mode: "ro" | "rw", subpath?, notify?}`. `notify`
  prompts the agent (about a second after, coalesced) when others change files
  under the mount. Only your own volumes can be mounted, and an agent's mounts
  are fixed when it is made (`PUT /v1/agents/:id/mounts` replaces them).
- `volume.write(path, data, { version })` writes only if nobody changed the file
  since that version (`0`: it must not exist), `read`, `list`, `remove`,
  `changes(since)`.
- `volume.snapshot()` and `volume.fork({ snapshot })` copy metadata only: a fork
  shares its source's content and diverges independently.
- Every file has a content type: the upload's, else sniffed from its bytes and
  name. Downloads are served so a file can never run as the runtime's origin.
- Uploads may take 15 minutes; a volume suits up to about 100,000 files.
- Deleted files, volumes and snapshots stop being stored and billed about a day
  after nothing refers to them any more. A file an agent was sent or shown stays,
  as the agent's history refers to it, until the agent is deleted.

## Signed links

`volume.link(path, options)` or `agent.files.link(path, options)` returns `{url,
expiresAt}`: a URL that downloads (`GET`) or uploads (`PUT`, with `maxBytes` and
`contentType`) that one file without a token, so a browser, a tool server or a
channel moves the bytes directly. Links last 15 minutes by default, at most 24
hours, and cannot be revoked sooner. Downloads take `Range`.

From your server, with your API key, `POST /v1/agents/:id/links {path, method?,
expiresIn?, maxBytes?, contentType?}` signs a link to a file of an agent by the
path the agent sees (`/workspace/report.pdf`), without the agent's token; `POST
/v1/volumes/:id/links` does the same by a volume's own path. Both answer `{url,
method, path, expiresAt}`, and a retry with the same `Idempotency-Key` never
returns the link again.
