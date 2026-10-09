"""Projects: an agent builds something in a volume of its own (a bot, a site, a report), and your application publishes
checked versions of it. The same helper as the TypeScript SDK's (see the Projects guide):

    from camelai_run import AgentRuntime
    from camelai_run.projects import Projects, publish_tool

    projects = Projects(runtime)
    project = await projects.create("bot-1", template={"bot.py": starter})
    await agents.upsert("builder-1", definition="bot-builder", subject=owner, context={"bot": "1"}, **project.mount("/bot"))
    result = await project.publish(validate=check, store=save)

publish_tool(...) is a tool for serve_tools (ASGI or camelai_run.sync's WSGI): the model calls it with no arguments, the
project comes from the call's signed identity, and problems go back to the model to fix.
"""
import base64
import inspect
import uuid

from . import Tool, ToolContext

_PUBLISHED = "published:"


def file_bytes(file):
    """A project file's contents as bytes, whichever way it came ("text", or base64 "data")."""
    return file["text"].encode() if "text" in file else base64.b64decode(file.get("data", ""))


def format_problems(problems):
    """Problems ({"path"?, "line"?, "message"}) as the model reads them, one a line."""
    def one(problem):
        where = (problem["path"] + (f":{problem['line']}" if problem.get("line") else "") + ": ") if problem.get("path") else ""
        return where + problem["message"]
    return "\n".join(one(problem) for problem in problems)


async def _maybe(value):
    return await value if inspect.isawaitable(value) else value


async def _check(validate, files):
    """A check's answer, whichever form it took: a list of problems, or {"problems"?, "data"}."""
    answer = await _maybe(validate(files)) if validate else None
    if isinstance(answer, dict):
        return list(answer.get("problems") or []), answer.get("data")
    return list(answer or []), None


class Project:
    def __init__(self, volume):
        self.id = volume.id
        self.volume = volume

    def mount(self, path="/project"):
        """What to give an agent so it works in the project (spread into agents.upsert): the volume at `path`,
        read-write and first, its own workspace beside it, and file tools. Add remount=True to move an existing agent."""
        return {"mounts": [{"volumeId": self.id, "path": path, "mode": "rw"}, {"workspace": True}], "file_tools": True}

    async def files(self, *, prefix=None, version=None):
        """The files as they are now (one read at one seq), or as a version has them."""
        return await self.volume.read_all(prefix=prefix, snapshot=version)

    async def restore(self, version):
        """Put the project back as a published version had it, in place: the agent working in it sees the files change.
        The version stays published; publish again to make the restored files a new one."""
        return await self.volume.restore(version)

    async def versions(self):
        """Published versions, oldest first: {"id", "seq", "name", "createdAt"}."""
        return [{key: snapshot[key] for key in ("id", "seq", "name", "createdAt")}
                for snapshot in await self.volume.snapshots() if snapshot["name"].startswith(_PUBLISHED)]

    async def publish(self, *, store, validate=None, prefix=None, keep=20, idempotency_key=None, identity=None):
        """Snapshot the project, read every file at the snapshot, `validate` them (a list of problems, empty to publish, or
        {"problems", "data"}) and `store(files, version, about)` them: {"ok": True, "version", "stored", "checked"?}, or
        {"ok": False, "problems"} (the snapshot is then deleted). `about` is {"project", "identity", "checked"?}: `checked`
        is the check's `data` (a bundle's manifest, say), so nothing is worked out twice. Versions beyond `keep`
        (default 20) are deleted; the same `idempotency_key` publishes once."""
        keep = min(max(1, keep), 90)
        name = f"{_PUBLISHED}{idempotency_key or uuid.uuid4()}"[:120]
        about = {"project": self, "identity": identity}
        if idempotency_key:
            done = next((version for version in await self.versions() if version["name"] == name), None)
            if done:
                # Published already (a retried call): its files are checked again only for what the check hands on.
                files = (await self.files(prefix=prefix, version=done["id"]))["files"]
                _, checked = await _check(validate, files)
                return self._published(done, await _maybe(store(files, done, self._about(about, checked))), checked)
        snapshot = await self.volume.snapshot(name=name)
        version = {key: snapshot[key] for key in ("id", "seq", "name", "createdAt")}
        try:
            files = (await self.files(prefix=prefix, version=version["id"]))["files"]
            problems, checked = await _check(validate, files)
            if problems:
                await self.volume.delete_snapshot(version["id"])
                return {"ok": False, "problems": problems}
            stored = await _maybe(store(files, version, self._about(about, checked)))
            versions = await self.versions()
            for old in versions[:max(0, len(versions) - keep)]:
                await self.volume.delete_snapshot(old["id"])
            return self._published(version, stored, checked)
        except BaseException:
            try:
                await self.volume.delete_snapshot(version["id"])
            except Exception:
                pass
            raise

    @staticmethod
    def _about(about, checked):
        return about if checked is None else {**about, "checked": checked}

    @staticmethod
    def _published(version, stored, checked):
        return {"ok": True, "version": version, "stored": stored, **({} if checked is None else {"checked": checked})}


class Projects:
    def __init__(self, runtime):
        self.runtime = runtime

    async def create(self, key, *, name=None, template=None):
        """The project for `key`: its volume is made the first time (and seeded with `template`, path to str or bytes),
        and is the same one every time after. A project with no files is seeded again; files there are never overwritten."""
        made = await self.runtime.create_volume(name=name or key[:120], key=key)
        project = self.get(made["id"])
        if template and (not made.get("existing") or made.get("files") == 0):
            for path, content in template.items():
                try:
                    await project.volume.write(path, content, version=0)
                except Exception as error:
                    if getattr(error, "status", None) != 412:
                        raise
        return project

    def get(self, volume_id):
        """A project by its volume's id."""
        return Project(self.runtime.volume(volume_id))


def publish_tool(*, project, store, validate=None, prefix=None, keep=20, description=None, published=None):
    """A `publish` tool for serve_tools: the model calls it (no arguments) when its work is ready. `project(identity)`
    (sync or async) finds the project from the call's signed identity, never from the model; failures go back to the model
    as "path:line: message" lines so it fixes them and publishes again. A retried call publishes once."""
    async def publish(context: ToolContext):
        if context.identity is None:
            raise RuntimeError('publish needs the runtime\'s identity token: serve it with serve_tools and auth {"type": "runtime"}')
        target = await _maybe(project(context.identity))
        # A key that is only this request's JSON-RPC id (a client that sends none) is no key: unrelated calls share ids.
        keyed = context.idempotency_key != context.call_id
        result = await target.publish(store=store, validate=validate, prefix=prefix, keep=keep,
                                      idempotency_key=context.idempotency_key if keyed else None, identity=context.identity)
        if not result["ok"]:
            raise RuntimeError("Not published. Fix these and publish again:\n" + format_problems(result["problems"]))
        return published(result) if published else {"published": True, "version": result["version"]["id"]}
    return Tool("publish", description or ("Publish the project: its files are checked, and if nothing is wrong they become the new version. "
                                           "If anything is wrong, the call fails with what to fix; fix it and publish again."),
                {"type": "object", "properties": {}, "additionalProperties": False}, publish, True, None, None, "direct")
