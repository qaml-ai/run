"""Hosted agents over SSE + HTTP, with local tool functions and replay receipts."""
import asyncio
from dataclasses import dataclass
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import inspect
import json
import os
import random
from pathlib import Path
from typing import get_type_hints
from urllib.parse import quote, urlencode, urlparse
import uuid

import httpx

# Distinguishes "not given" from None (which means "never expires") in create_agent.
_DEFAULT = object()


class AgentError(RuntimeError):
    def __init__(self, message, status=0, request_id=None, retry_after=None):
        super().__init__(message)
        self.status, self.request_id = status, request_id
        # Seconds the runtime asked to wait before retrying (its Retry-After), for 429 and 503.
        self.retry_after = retry_after


@dataclass
class ToolContext:
    call_id: str
    # Set by the runtime, e.g. {"channel", "conversationId", "sender"} for a turn a channel message started.
    origin: dict | None = None


@dataclass
class Tool:
    name: str
    description: str
    parameters: dict
    function: object
    with_context: bool

    def definition(self):
        return {"name": self.name, "description": self.description, "parameters": self.parameters}

    def mcp_tool(self):
        """This tool as an attached MCP server lists it (tools/list)."""
        return {"name": self.name, "description": self.description, "inputSchema": self.parameters}


def _call_tool_result(result):
    """A tool's JSON value as an MCP tools/call result: a text block, plus structured content for objects."""
    text = json.dumps(result, allow_nan=False)
    return {"content": [{"type": "text", "text": text}], **({"structuredContent": result} if isinstance(result, dict) else {})}


def tool(function=None, *, name=None, description=None):
    """Expose an async function; infer its JSON schema from Python annotations."""
    def decorate(fn):
        hints = get_type_hints(fn)
        properties, required = {}, []
        with_context = False
        kinds = {str: "string", int: "integer", float: "number", bool: "boolean", dict: "object", list: "array"}
        for key, parameter in inspect.signature(fn).parameters.items():
            if key == "context" and hints.get(key) is ToolContext:
                with_context = True
                continue
            annotation = hints.get(key)
            if annotation not in kinds:
                raise TypeError(f"Annotate {key} with str, int, float, bool, dict, list, or use context: ToolContext")
            if parameter.kind not in (parameter.POSITIONAL_OR_KEYWORD, parameter.KEYWORD_ONLY):
                raise TypeError("Tool parameters must be named arguments")
            properties[key] = {"type": kinds[annotation]}
            if parameter.default is parameter.empty:
                required.append(key)
        if not inspect.iscoroutinefunction(fn):
            raise TypeError("Tools must be async functions; use asyncio.to_thread for blocking work")
        return Tool(name or fn.__name__, description or inspect.getdoc(fn) or fn.__name__,
                    {"type": "object", "properties": properties, "required": required, "additionalProperties": False}, fn, with_context)
    return decorate(function) if function else decorate


def _origin(url):
    address = urlparse(url)
    if address.username or address.password or address.query or address.fragment or address.path not in ("", "/"):
        raise ValueError("Use a runtime origin without credentials, path, or query")
    if address.scheme != "https" and not (address.scheme == "http" and address.hostname in ("localhost", "127.0.0.1", "::1")):
        raise ValueError("Remote runtimes require https://")
    return url.rstrip("/")


def _save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_suffix(f".{uuid.uuid4()}.tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as file:
        json.dump(value, file, allow_nan=False)
        file.flush()
        os.fsync(file.fileno())
    os.replace(temporary, path)
    fd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _retry_after(response):
    """Retry-After in seconds (delta or HTTP date), capped so a bad value cannot stall a caller."""
    value = response.headers.get("retry-after")
    if value is None:
        return None
    try:
        seconds = float(value) if value.strip().isdigit() else (parsedate_to_datetime(value) - datetime.now(timezone.utc)).total_seconds()
    except (TypeError, ValueError):
        return None
    return min(max(0.0, seconds), 60.0)


# A 429 (quota, or an agent's queue is full) was refused before anything happened, so any request may be retried after it.
_RATE_LIMIT_ATTEMPTS = 8


async def _http(client, base, path, token, method="GET", body=None, retry=True, headers=None):
    encoded = None if body is None else json.dumps(body, allow_nan=False).encode()
    if encoded and len(encoded) > 1_100_000:
        raise AgentError("Request exceeds transport limit")
    attempt = 0
    while True:
        try:
            response = await client.request(method, base + path, content=encoded, headers={
                "Authorization": f"Bearer {token}", "Content-Type": "application/json", **(headers or {})})
            if not response.is_success:
                try:
                    value = response.json()
                except ValueError:
                    value = {}
                raise AgentError(value.get("error", f"HTTP {response.status_code}"), response.status_code, retry_after=_retry_after(response))
            return response.json()
        except Exception as error:
            limited = isinstance(error, AgentError) and error.status == 429
            if limited:
                if attempt >= _RATE_LIMIT_ATTEMPTS - 1:
                    raise
            elif not retry or attempt >= 3 or (isinstance(error, AgentError) and error.status < 500):
                raise
            # Honour the runtime's Retry-After, with jitter so refused callers do not return together; else back off exponentially.
            backoff = min(10.0, (0.5 if limited else 0.1) * 2 ** attempt)
            hinted = error.retry_after if isinstance(error, AgentError) else None
            await asyncio.sleep(hinted + random.random() * min(1.0, backoff) if hinted is not None else backoff)
            attempt += 1


class AgentRuntime:
    def __init__(self, url=None, api_key=None, state_directory=None):
        self.base = _origin(url or os.environ.get("AGENT_URL", "http://127.0.0.1:8790"))
        self.api_key = api_key or os.environ.get("AGENT_RUNTIME_TOKEN")
        self.state_directory = state_directory
        self.http = httpx.AsyncClient(timeout=10, follow_redirects=False)
        self.agents = []

    async def create_agent(self, *, tools, system_prompt=None, name=None, type=None, model=None, thinking_level=None, mounts=None, idempotency_key=None, on_event=None, on_error=None, ttl_seconds=_DEFAULT, definition=None, subject=None, context=None):
        """Provision an agent. `model` is "provider/model-id", e.g. "anthropic/claude-sonnet-5".
        `definition` makes it from a definition (GET /v1/definitions), which supplies the model, system prompt,
        thinking level and tool sources; `tools` are added as the agent's attached MCP server.
        `ttl_seconds` is the agent's lifetime, or None to keep it until it is deleted (default: one day).
        `mounts` ([{"volumeId", "path", "mode": "ro" | "rw", "subpath"?, "notify"?}]) are the volumes its
        file tools see; by default it gets its own workspace volume at /workspace."""
        if not self.api_key:
            raise AgentError("Set api_key or AGENT_RUNTIME_TOKEN to provision an agent")
        # subject: who the agent acts for; context: claims for its tool servers' identity tokens. Set only here.
        optional = {"definition": definition, "name": name, "type": type, "systemPrompt": system_prompt, "model": model, "thinkingLevel": thinking_level, "mounts": mounts, "subject": subject, "context": context}
        # The tools are served to the agent as an attached MCP server; this is its tools/list.
        body = {"mcp": {"tools": [item.mcp_tool() for item in tools]}, **{key: value for key, value in optional.items() if value is not None}}
        if ttl_seconds is not _DEFAULT:
            body["ttlSeconds"] = ttl_seconds
        session = await _http(self.http, self.base, "/client-sessions", self.api_key, "POST", body,
                              headers={"Idempotency-Key": idempotency_key or str(uuid.uuid4())})
        return await self.connect_agent(session, tools=tools, on_event=on_event, on_error=on_error)

    async def connect_agent(self, session, *, tools, on_event=None, on_error=None):
        agent = AgentClient(self.base, session, tools, self.state_directory, on_event, on_error)
        self.agents.append(agent)
        try:
            await agent.connect()
            return agent
        except BaseException:
            await agent.close()
            raise

    def _operator(self):
        if not self.api_key:
            raise AgentError("Set api_key or AGENT_RUNTIME_TOKEN to manage volumes and mounts")
        return self.api_key

    async def create_volume(self, *, name=None):
        return await _http(self.http, self.base, "/v1/volumes", self._operator(), "POST", {} if name is None else {"name": name}, retry=False)

    async def list_volumes(self):
        return await _http(self.http, self.base, "/v1/volumes", self._operator())

    def volume(self, volume_id):
        """A handle on one volume's files, snapshots and forks."""
        return Volume(self, volume_id)

    async def mounts(self, agent_id):
        return await _http(self.http, self.base, f"/v1/agents/{quote(agent_id)}/mounts", self._operator())

    async def set_mounts(self, agent_id, mounts):
        """Replace an agent's mounts; an idle agent restarts so its tools describe them."""
        return await _http(self.http, self.base, f"/v1/agents/{quote(agent_id)}/mounts", self._operator(), "PUT", {"mounts": mounts}, retry=False)

    async def close(self):
        await asyncio.gather(*(agent.close() for agent in self.agents))
        await self.http.aclose()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        await self.close()


class Volume:
    """Files are versioned: pass `version` to write or remove only if nobody changed the file since (0: must not exist)."""

    def __init__(self, runtime, volume_id):
        if not isinstance(volume_id, str) or not volume_id.startswith("vol_") or len(volume_id) != 28:
            raise AgentError("Invalid volume id")
        self.runtime, self.id = runtime, volume_id

    def _json(self, suffix="", method="GET", body=None):
        runtime = self.runtime
        return _http(runtime.http, runtime.base, f"/v1/volumes/{self.id}{suffix}", runtime._operator(), method, body, retry=method == "GET")

    def _file(self, path):
        return f"{self.runtime.base}/v1/volumes/{self.id}/files/" + "/".join(quote(part, safe="") for part in path.split("/") if part)

    async def _raw(self, method, path, content=None, headers=None):
        response = await self.runtime.http.request(method, self._file(path), content=content, headers={
            "Authorization": f"Bearer {self.runtime._operator()}", **(headers or {})})
        if not response.is_success:
            try:
                error = response.json().get("error")
            except ValueError:
                error = None
            raise AgentError(error or f"HTTP {response.status_code}", response.status_code)
        return response

    async def info(self):
        return await self._json()

    async def delete(self):
        return await self._json(method="DELETE")

    async def snapshot(self, *, name=None):
        return await self._json("/snapshots", "POST", {} if name is None else {"name": name})

    async def snapshots(self):
        return await self._json("/snapshots")

    async def delete_snapshot(self, snapshot_id):
        return await self._json(f"/snapshots/{quote(snapshot_id)}", "DELETE")

    async def fork(self, *, name=None, snapshot=None):
        """A new volume with this one's files (or a snapshot's); only metadata is copied."""
        return await self._json("/fork", "POST", {key: value for key, value in {"name": name, "snapshot": snapshot}.items() if value is not None})

    async def changes(self, since=0):
        return await self._json(f"/changes?since={int(since)}")

    async def list(self, *, prefix=None, glob=None, after=None, limit=None):
        query = urlencode({key: value for key, value in {"prefix": prefix, "glob": glob, "after": after, "limit": limit}.items() if value is not None})
        return await self._json(f"/files{'?' + query if query else ''}")

    async def write(self, path, data, *, version=None):
        headers = {"Content-Type": "application/octet-stream"}
        if version == 0:
            headers["If-None-Match"] = "*"
        elif version is not None:
            headers["If-Match"] = f'"{version}"'
        response = await self._raw("PUT", path, data.encode() if isinstance(data, str) else data, headers)
        return response.json()

    async def read(self, path, *, range=None):
        """Returns (bytes, version); `range` is (start, end) in bytes, end exclusive."""
        headers = {"Range": f"bytes={range[0]}-{'' if len(range) < 2 or range[1] is None else range[1] - 1}"} if range else None
        response = await self._raw("GET", path, headers=headers)
        return response.content, int(response.headers["etag"].strip('"'))

    async def read_text(self, path):
        return (await self.read(path))[0].decode()

    async def remove(self, path, *, version=None):
        return (await self._raw("DELETE", path, headers=None if version is None else {"If-Match": f'"{version}"'})).json()


class AgentClient:
    def __init__(self, base, session, tools, state_directory=None, on_event=None, on_error=None):
        import re
        if not re.fullmatch(r"client_[a-f0-9]{40}", session["id"]):
            raise ValueError("Invalid session id")
        self.base = _origin(base)
        self.session = {key: session[key] for key in ("id", "token", "expiresAt")}
        self.tools = {item.name: item for item in tools}
        self.on_event, self.on_error = on_event, on_error
        self.http = httpx.AsyncClient(timeout=10, follow_redirects=False)
        self.path = f"/clients/{session['id']}"
        self.journal_path = Path(state_directory or os.environ.get("AGENT_CLIENT_STATE_DIR", ".agent-runtime/client-sdk")) / f"{session['id']}.json"
        try:
            self.journal = json.loads(self.journal_path.read_text())
        except FileNotFoundError:
            self.journal = {"version": 1, "cursor": 0}
        if self.journal["version"] != 1:
            raise AgentError("Unsupported client journal")
        # The journal keeps only the event cursor.
        self.journal = {"version": 1, "cursor": self.journal["cursor"]}
        # Tool calls running, by JSON-RPC id, so the runtime can cancel them.
        self.pending, self.active = {}, {}
        # The event stream's connection, named in the MCP messages this client sends back.
        self.connection = None
        self.ready = asyncio.Event()
        self.runner = None
        self.closed = False
        self.fatal = None

    def _save(self):
        _save(self.journal_path, self.journal)

    async def _http(self, suffix, method="GET", body=None, retry=True):
        return await _http(self.http, self.base, self.path + suffix, self.session["token"], method, body, retry)

    async def connect(self):
        if self.closed:
            raise AgentError("Client closed")
        if not self.runner:
            self.runner = asyncio.create_task(self._events())
        await asyncio.wait_for(self.ready.wait(), 10)
        if self.fatal:
            raise self.fatal

    def _report(self, error):
        if self.on_error:
            self.on_error(error)

    async def _events(self):
        backoff = 0.25
        while not self.closed:
            try:
                async with self.http.stream("GET", self.base + self.path + "/events", headers={
                    "Authorization": f"Bearer {self.session['token']}", "Accept": "text/event-stream",
                    "Last-Event-ID": str(self.journal["cursor"])}, timeout=20) as response:
                    if response.status_code == 409:
                        state = await self._sync()
                        self.journal["cursor"] = state["cursor"]
                        self._save()
                        if self.on_event:
                            self.on_event({"type": "replay_gap", "cursor": state["cursor"]})
                        continue
                    if not response.is_success:
                        raise AgentError(f"Event stream HTTP {response.status_code}", response.status_code)
                    if not response.headers.get("content-type", "").startswith("text/event-stream"):
                        raise AgentError("Expected SSE response")
                    buffer = b""
                    async for chunk in response.aiter_bytes():
                        buffer += chunk
                        while b"\n\n" in buffer:
                            frame, buffer = buffer.split(b"\n\n", 1)
                            if len(frame) > 1_100_000:
                                raise AgentError("SSE frame too large")
                            lines = frame.decode().split("\n")
                            data = "\n".join(line[5:].lstrip() for line in lines if line.startswith("data:"))
                            if not data:
                                continue
                            if "event: ready" in lines:
                                self.connection = json.loads(data).get("connection")
                                await self._sync()
                                backoff = 0.25
                                self.ready.set()
                                continue
                            id_line = next((line for line in lines if line.startswith("id:")), None)
                            # The runtime's MCP messages are live only: no id, never replayed, no cursor.
                            if id_line is None:
                                event = json.loads(data)
                                if event.get("type") == "mcp":
                                    self._track(asyncio.create_task(self._mcp(event["message"])))
                                continue
                            cursor = int(id_line[3:])
                            if cursor <= self.journal["cursor"]:
                                continue
                            event = json.loads(data)
                            self._receive(event)
                            self.journal["cursor"] = cursor
                            # Display events replay only from host memory; don't write per token.
                            if event.get("type") != "event":
                                self._save()
                        if len(buffer) > 1_100_000:
                            raise AgentError("SSE frame too large")
            except asyncio.CancelledError:
                raise
            except Exception as error:
                if isinstance(error, AgentError) and error.status in (401, 403, 410):
                    self.fatal = error
                    self.ready.set()
                    for future in self.pending.values():
                        if not future.done():
                            future.set_exception(error)
                    self._report(error)
                    return
                if not self.closed:
                    self._report(error)
            if not self.closed:
                await asyncio.sleep(backoff)
                backoff = min(5, backoff * 2)

    def _receive(self, event):
        if event["type"] == "response":
            self._settle(event["id"], event["outcome"])
        elif event["type"] == "event" and self.on_event:
            self.on_event(event["event"])

    def _settle(self, request_id, value):
        future = self.pending.pop(request_id, None)
        if future and not future.done():
            if "error" in value:
                future.set_exception(AgentError(value["error"], request_id=request_id))
            else:
                future.set_result(value.get("result"))

    async def _sync(self):
        state = await self.outcomes()
        for request in state["requests"]:
            if "outcome" in request:
                self._settle(request["id"], request["outcome"])
        return state

    def _track(self, task):
        def finished(task):
            if not task.cancelled() and task.exception():
                self._report(task.exception())
        task.add_done_callback(finished)

    async def _mcp(self, message):
        """Answer the runtime's JSON-RPC messages as the agent's attached MCP server: initialize, ping,
        tools/list and tools/call, and cancellation. A call whose answer is lost with the connection
        ends for the agent as "outcome unknown"."""
        method, params = message.get("method"), message.get("params") or {}
        if not isinstance(method, str):
            return
        if "id" not in message:
            if method == "notifications/cancelled":
                task = self.active.get(str(params.get("requestId")))
                if task:
                    task.cancel()
            return
        connection = self.connection

        async def reply(answer):
            await _http(self.http, self.base, self.path + "/mcp", self.session["token"], "POST", {"jsonrpc": "2.0", "id": message["id"], **answer},
                        headers={"X-Agent-Connection": connection or ""})

        if method == "initialize":
            return await reply({"result": {"protocolVersion": params.get("protocolVersion"), "capabilities": {"tools": {}}, "serverInfo": {"name": "agent-runtime-sdk-python", "version": "1.0.0"}}})
        if method == "ping":
            return await reply({"result": {}})
        if method == "tools/list":
            return await reply({"result": {"tools": [item.mcp_tool() for item in self.tools.values()]}})
        if method != "tools/call":
            return await reply({"error": {"code": -32601, "message": f"Unknown method {method}"}})
        key, meta = str(message["id"]), params.get("_meta") or {}
        self.active[key] = asyncio.current_task()
        try:
            definition = self.tools.get(params.get("name"))
            if definition is None:
                raise ValueError(f"Unknown tool {params.get('name')}")
            args = dict(params.get("arguments") or {})
            if definition.with_context:
                args["context"] = ToolContext(call_id=meta.get("agent-runtime/callId", key), origin=meta.get("agent-runtime/origin"))
            try:
                answer = _call_tool_result(await definition.function(**args))
            except asyncio.CancelledError:
                raise
            except Exception as error:
                # The tool's own failure is an MCP error result: the model sees it.
                answer = {"content": [{"type": "text", "text": str(error)[:2048]}], "isError": True}
            if len(json.dumps(answer).encode()) > 1024 * 1024:
                raise ValueError("Tool result too large")
            await reply({"result": answer})
        except asyncio.CancelledError:
            pass
        except Exception as error:
            await reply({"error": {"code": -32603, "message": str(error)[:2048]}})
        finally:
            self.active.pop(key, None)

    async def request(self, method, params=None, *, idempotency_key=None, timeout=180):
        if self.closed or self.fatal:
            raise self.fatal or AgentError("Client closed")
        request_id = idempotency_key or str(uuid.uuid4())
        if request_id in self.pending or len(self.pending) >= 8:
            raise AgentError("Request already pending or too many outstanding requests", request_id=request_id)
        future = asyncio.get_running_loop().create_future()
        self.pending[request_id] = future
        try:
            record = await self._http("/requests", "POST", {"id": request_id, "method": method, "params": params or {}})
            if "outcome" in record:
                self._settle(request_id, record["outcome"])
            return await asyncio.wait_for(future, timeout)
        except TimeoutError as error:
            raise AgentError("Request timed out; inspect request_status() or reuse the same idempotency_key", request_id=request_id) from error
        finally:
            self.pending.pop(request_id, None)
            if future.done() and not future.cancelled():
                future.exception()  # An SSE error may arrive while POST fails.
            elif not future.done():
                future.cancel()

    async def prompt(self, text, *, actor=None, from_=None, **options):
        """`from_` ({"id", "name"?, "username"?}) says who sent the message: the model sees it in a block only
        the runtime can write, and its id is the turn's actor. `actor` names someone else acting (`act` in
        identity tokens) without telling the model."""
        return await self.request("prompt", {"text": text, **({"actor": actor} if actor else {}), **({"from": from_} if from_ else {})}, **options)

    async def execute(self, code, *, execution_timeout_ms=None, actor=None, **options):
        params = {"code": code, **({"actor": actor} if actor else {})}
        if execution_timeout_ms is not None:
            params["timeoutMs"] = execution_timeout_ms
        return await self.request("execute", params, **options)

    async def set_metadata(self, *, name, type):
        return await self._http("/metadata", "POST", {"name": name, "type": type})

    async def configure(self, *, model=None, system_prompt=None, thinking_level=None):
        """Change the model ("provider/model-id"), system prompt or thinking level between runs."""
        params = {key: value for key, value in {"model": model, "systemPrompt": system_prompt, "thinkingLevel": thinking_level}.items() if value is not None}
        return await self.request("configure", params)

    async def schedule(self, *, text=None, code=None, at=None, in_seconds=None, every_seconds=None):
        """Wake this agent later with a prompt (text) or sandboxed code; every_seconds (>= 60) repeats it."""
        body = {key: value for key, value in {"text": text, "code": code, "at": at, "inSeconds": in_seconds, "everySeconds": every_seconds}.items() if value is not None}
        return await self._http("/schedules", "POST", body, retry=False)

    async def schedules(self):
        return await self._http("/schedules")

    async def unschedule(self, schedule_id):
        from urllib.parse import quote
        return await self._http(f"/schedules/{quote(schedule_id, safe='')}", "DELETE", None, retry=False)

    async def status(self):
        return await self.request("status")

    async def abort(self):
        return await self.request("abort")

    async def outcomes(self):
        return await self._http("/state")

    async def request_status(self, request_id):
        from urllib.parse import quote
        return await self._http(f"/requests/{quote(request_id, safe='')}")

    async def close(self):
        if self.closed:
            return
        self.closed = True
        if self.runner:
            self.runner.cancel()
            await asyncio.gather(self.runner, return_exceptions=True)
        for request_id, future in self.pending.items():
            if not future.done():
                future.set_exception(AgentError("Client closed; request may still be running", request_id=request_id))
        tasks = list(self.active.values())
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.wait(tasks, timeout=1)
        await self.http.aclose()

    async def destroy(self):
        try:
            await self._http("", "DELETE")
        finally:
            await self.close()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        await self.close()
