# Projects

A project is something an agent builds for your users, a bot, a site, a report,
that your application then runs or serves. The agent works on the files with its
file tools; your application checks them and publishes versions. The pattern:

1. **A volume per project**, made once per key (`projects.create`).
2. **An agent that works in it**, with the volume mounted read-write and its own
   workspace beside it (`project.mount`).
3. **A publish step in your code**: snapshot the volume, read every file at that
   snapshot, check them, and store them where your application keeps what it
   serves (`project.publish`). The snapshot is the version: what you checked is
   exactly what you stored, whatever the agent writes meanwhile.
4. **A `publish` tool the model calls** when its work is ready (`publishTool`),
   which finds the project from the call's signed identity and tells the model
   what to fix when the check fails.

## Making a project

```ts
import { Agents } from "@camelai/run";

const agents = new Agents();
const project = await agents.runtime.projects.create({
  key: `bot-${bot.id}`,
  template: { "bot.ts": starterCode, "README.md": "# My bot\n" },
});
```

- `key` names the project within your account: the first create makes its
  volume, and every later one returns the same volume, for as long as it lives
  (`POST /v1/volumes {key}`; `existing: true` on the later ones). Store
  `project.id` if you like, or create by key every time.
- `template` (path to text or bytes) seeds a new project. It never overwrites a
  file that is there; a project with no files is seeded again, so a create cut
  off half-way finishes on its retry.
- A deleted project's key makes no other (a 409): pick a new key.

## The agent that builds it

```ts
const builder = await agents.upsert(`builder-${bot.id}`, {
  definition: "bot-builder",            // its prompt and tools, including your publish tool
  subject: owner.id, context: { bot: bot.id },
  ...project.mount("/bot"),
});
```

`project.mount(path)` mounts the project's volume read-write at `path`, first,
so relative paths are the project's, keeps the agent's own workspace at
`/workspace` beside it (uploads, tool outputs and scratch files go there, not
into the project), and turns file tools on. To move an existing agent onto a
project, add `remount: true` to its upsert.

## Publishing

```ts
const result = await project.publish({
  prefix: "/",                                  // only these files (default: all)
  validate: files => check(files),              // [] when nothing is wrong
  store: async (files, version) => saveRelease(bot.id, files, version.id),
  keep: 20,                                     // published versions kept (default 20)
});
if (!result.ok) console.log(formatProblems(result.problems));
```

- `files` are `{path, size, contentType, sha256, text | data}`: `text` for UTF-8
  files, base64 `data` for any other (`fileBytes(file)` gives the bytes).
- `validate` returns problems, `{path?, line?, message}`. Any problem keeps the
  version from being published, and its snapshot is deleted.
- `store` runs once per version. It gets the version (`{id, seq, name,
  createdAt}`) and `{project, identity}` (the identity when `publishTool`
  published it); keep `version.id` to read that version again with
  `project.files({ version })`.
- `project.versions()` lists the published versions, oldest first. A volume
  keeps at most 100 snapshots, so older versions beyond `keep` are deleted.
- `idempotencyKey` publishes once per key: a retried call gets the version the
  first one made.

## The publish tool

Give the model a tool that publishes, served by your application with
[`serveTools`](tools.md#served-tools-over-http-for-serverless-and-many-users) and named in the agent's
definition with `auth: { type: "runtime" }`:

```ts
import { publishTool } from "@camelai/run";
import { serveTools } from "@camelai/run/server";

export default {
  fetch: serveTools({
    publish: publishTool({
      // Who the call is for comes from the runtime's signed token, never from the model.
      project: identity => agents.runtime.projects.get(volumeOfBot(identity.context.bot)),
      validate: files => check(files),
      store: (files, version, { identity }) => saveRelease(String(identity!.context.bot), files, version.id),
    }),
  }, { runtime: "https://run.camelai.com", tenant: "acme" }),
};
```

It takes no arguments. On success the model gets `{published: true, version}`;
otherwise the call fails with the problems, one a line (`/bot.ts:12: …`), so the
model fixes them and publishes again. A retried call publishes once.

## In Python

`camelai_run.projects` has the same helper, async:

```python
from camelai_run.projects import Projects, publish_tool

projects = Projects(agents.runtime)
project = await projects.create(f"bot-{bot.id}", template={"bot.py": starter})
builder = await agents.upsert(f"builder-{bot.id}", definition="bot-builder", subject=owner.id, context={"bot": bot.id}, **project.mount("/bot"))
result = await project.publish(validate=check, store=lambda files, version, about: save_release(bot.id, files, version["id"]))

app = serve_tools([publish_tool(project=lambda identity: projects.get(volume_of_bot(identity.context["bot"])), validate=check, store=save)], runtime=RUNTIME, tenant="acme")
```

`publish_tool` works in `serve_tools` (ASGI) and in `camelai_run.sync.serve_tools`
(WSGI: Django, Flask). Files are dicts with `"text"` or base64 `"data"`
(`file_bytes(file)` gives the bytes).

## Security

- **Derive the project from identity.** `project(identity)` reads who the call
  is for from the runtime's signed token (`subject`, `context`), which you set
  when you made the agent and the model cannot change. Never take a project id,
  a path or a version from the model's arguments.
- **Check what you read, not what the model says.** `publish` reads the files
  server-side from a snapshot; the model never hands you content. Treat every
  file as untrusted input: validate it, and run it only where your application
  runs untrusted code.
- **Keep the agent to its project.** Give the builder the project's volume and
  its own workspace, nothing else of yours. Its own token can read and write its
  mounts; your API key, which reads every project, stays on your server.
- **Store versions, serve versions.** Serve what `store` kept for a published
  version, never the live volume, which the agent may be changing.

## From the REST API

| | |
| --- | --- |
| make or find a project's volume | `POST /v1/volumes {name, key}` |
| mount it beside the workspace | `mounts: [{volumeId, path: "/bot", mode: "rw"}, {workspace: true}]` on `POST /v1/agents` (`remount: true` on an upsert to change them) |
| take a version | `POST /v1/volumes/:id/snapshots {name}` |
| read every file of it at once | `GET /v1/volumes/:id/files?content=true&snapshot=snap_…` |
| list and delete versions | `GET /v1/volumes/:id/snapshots`, `DELETE /v1/volumes/:id/snapshots/:snapshot` |
