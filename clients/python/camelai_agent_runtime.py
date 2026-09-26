"""Hosted agents over SSE + HTTP, with local tool functions and replay receipts."""
import asyncio
import base64
from dataclasses import dataclass, field
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
class RuntimeIdentity:
    """Who a tool call is for, as the runtime says: from its signed identity token when tools are served
    over HTTP (serve_tools), or from the call itself when they are attached. Authorize as `user`."""
    # Who is acting: the turn's actor (a prompt's actor, or its from id), else the agent's subject.
    user: str
    # Whom the agent acts for (create_agent(subject=...)); the agent's id if none.
    subject: str
    tenant: str
    agent: str
    # Claims the agent's creator attached (create_agent(context=...)).
    context: dict = field(default_factory=dict)
    actor: str | None = None
    definition: str | None = None
    origin: dict | None = None
    # The call was approved by a person: {"input", "by", "at"}.
    approval: dict | None = None
    # A verified token's full claims (serve_tools, verify_runtime_token).
    claims: dict | None = field(default=None, repr=False, compare=False)


def identity_from_claims(claims):
    """A runtime identity from its claims: a verified token's payload, or an attached call's _meta."""
    text = lambda value: value if isinstance(value, str) and value else None
    agent = text(claims.get("agent")) or ""
    subject = text(claims.get("sub")) or agent
    actor = text(claims.get("act"))
    return RuntimeIdentity(user=actor or subject, subject=subject, tenant=text(claims.get("tenant")) or "", agent=agent,
                           context=claims["ctx"] if isinstance(claims.get("ctx"), dict) else {}, actor=actor,
                           definition=text(claims.get("definition")), origin=claims["origin"] if isinstance(claims.get("origin"), dict) else None,
                           approval=claims["approval"] if isinstance(claims.get("approval"), dict) else None)


class InputRequired(Exception):
    """Raised by a ToolContext's asks: the call answers MCP's input_required, and runs again once the user answers."""

    def __init__(self, input_requests, request_state=None):
        super().__init__("Waiting for the user's input")
        self.input_requests = input_requests
        # The answers so far, which the runtime hands back on the next call (MCP's requestState).
        self.request_state = request_state


@dataclass
class ToolContext:
    call_id: str
    # Set by the runtime, e.g. {"channel", "conversationId", "sender"} for a turn a channel message started.
    origin: dict | None = None
    # Who the call is for: always set by serve_tools; set for attached tools by runtimes that send it.
    identity: RuntimeIdentity | None = None
    # The user's answers to this call's asks, on the call the runtime makes once they answered.
    input_responses: dict = field(default_factory=dict, repr=False)
    _asked: int = field(default=0, repr=False)

    # Ask the user and get their answer. The call ends at the first ask and the agent's turn waits, for days if
    # need be; once they answer, the runtime calls the tool again with the same arguments and the ask returns the
    # answer. So everything before an ask runs again on that call: ask first, act after.
    async def confirm(self, message):
        """Whether the user said yes."""
        return (await self._request({"mode": "form", "message": message, "requestedSchema": {"type": "object", "properties": {}}})).get("action") == "accept"

    async def ask(self, message, schema):
        """What the user filled in (`schema` is a flat JSON Schema object), or None if they declined."""
        answer = await self._request({"mode": "form", "message": message, "requestedSchema": schema})
        return answer.get("content") if answer.get("action") == "accept" else None

    async def require_url(self, url, message):
        """Whether the user says they have done what the https page at `url` asks (connect an account, say)."""
        return (await self._request({"mode": "url", "message": message, "url": url, "elicitationId": f"{self.call_id}-{self._asked + 1}"})).get("action") == "accept"

    async def _request(self, params):
        self._asked += 1
        key = f"input_{self._asked}"
        if isinstance(self.input_responses.get(key), dict):
            return self.input_responses[key]
        state = base64.b64encode(json.dumps(self.input_responses).encode()).decode() if self.input_responses else None
        raise InputRequired({key: {"method": "elicitation/create", "params": params}}, state)


@dataclass
class Tool:
    name: str
    description: str
    parameters: dict
    function: object
    with_context: bool
    # True, or an async function of (arguments, context): the user approves each such call before it runs.
    needs_approval: object = None

    def definition(self):
        return {"name": self.name, "description": self.description, "parameters": self.parameters}

    def mcp_tool(self):
        """This tool as an attached MCP server lists it (tools/list)."""
        return {"name": self.name, "description": self.description, "inputSchema": self.parameters,
                **({"_meta": {"agent-runtime/needsApproval": True}} if self.needs_approval else {})}


def _call_tool_result(result):
    """A tool's JSON value as an MCP tools/call result: a text block, plus structured content for objects."""
    text = json.dumps(result, allow_nan=False)
    return {"content": [{"type": "text", "text": text}], **({"structuredContent": result} if isinstance(result, dict) else {})}


def tool(function=None, *, name=None, description=None, needs_approval=None):
    """Expose an async function; infer its JSON schema from Python annotations. With needs_approval (True, or
    an async function of the arguments and context), the user approves each call, shown as the runtime sees it,
    before it runs; such a tool is declared to the model directly, as code cannot wait for a person."""
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
                    {"type": "object", "properties": properties, "required": required, "additionalProperties": False}, fn, with_context, needs_approval)
    return decorate(function) if function else decorate


def _tool_context(meta, fallback_id, identity=None):
    """A call's context from its _meta, with the identity the runtime sent (or `identity`, from a verified token)."""
    sent = identity_from_claims(meta["agent-runtime/identity"]) if isinstance(meta.get("agent-runtime/identity"), dict) else None
    who = identity or sent
    origin = meta.get("agent-runtime/origin") if isinstance(meta.get("agent-runtime/origin"), dict) else (who.origin if who else None)
    return ToolContext(call_id=meta.get("agent-runtime/callId") or fallback_id, origin=origin, identity=who)


async def _answer_mcp(message, tools, context_for, server_name="agent-runtime-sdk-python"):
    """Answer one MCP JSON-RPC request as a tool server: initialize, ping, tools/list and tools/call.
    Both an attached agent and serve_tools use it."""
    method, params = message.get("method"), message.get("params") or {}
    if method == "initialize":
        return {"result": {"protocolVersion": params.get("protocolVersion") or "2025-06-18", "capabilities": {"tools": {}}, "serverInfo": {"name": server_name, "version": "1.0.0"}}}
    if method == "ping":
        return {"result": {}}
    if method == "tools/list":
        return {"result": {"tools": [item.mcp_tool() for item in tools.values()]}}
    if method != "tools/call":
        return {"error": {"code": -32601, "message": f"Unknown method {method}"}}
    try:
        definition = tools.get(params.get("name"))
        if definition is None:
            raise ValueError(f"Unknown tool {params.get('name')}")
        args = dict(params.get("arguments") or {})
        context = context_for(params.get("_meta") or {})
        # Each round answers only its own ask: earlier answers come back in the state this call handed out.
        try:
            earlier = json.loads(base64.b64decode(params["requestState"])) if isinstance(params.get("requestState"), str) else {}
        except ValueError:
            earlier = {}
        context.input_responses = {**(earlier if isinstance(earlier, dict) else {}), **(params.get("inputResponses") if isinstance(params.get("inputResponses"), dict) else {})}
        needs = definition.needs_approval
        if callable(needs):
            needs = await needs(dict(args), context)
        if needs and not (context.identity and context.identity.approval):
            # Not yet approved: the runtime asks the user, showing this call, and calls again once they approve.
            return {"result": {"resultType": "input_required", "inputRequests": {"approval": {"method": "agent-runtime/approval"}}}}
        if definition.with_context:
            args["context"] = context
        try:
            answer = _call_tool_result(await definition.function(**args))
        except asyncio.CancelledError:
            raise
        except InputRequired as asked:
            answer = {"resultType": "input_required", "inputRequests": asked.input_requests, **({"requestState": asked.request_state} if asked.request_state else {})}
        except Exception as error:
            # The tool's own failure is an MCP error result: the model sees it.
            answer = {"content": [{"type": "text", "text": str(error)[:2048]}], "isError": True}
        if len(json.dumps(answer).encode()) > 1024 * 1024:
            raise ValueError("Tool result too large")
        return {"result": answer}
    except asyncio.CancelledError:
        raise
    except Exception as error:
        return {"error": {"code": -32603, "message": str(error)[:2048]}}


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
# httpx times each read and write, so a stalled transfer fails; an upload may wait longer while the runtime stores it.
_UPLOAD_TIMEOUT = 60


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


async def _transfer(client, method, url, **options):
    """A file request. A 503 (the agent is moving, a node draining) was refused before anything happened;
    a read may be retried after any server error or a lost connection."""
    for attempt in range(4):
        try:
            response = await client.request(method, url, **options)
            if attempt == 3 or not (response.status_code == 503 or (response.status_code >= 500 and method == "GET")):
                return response
        except httpx.TransportError:
            if attempt == 3 or method != "GET":
                raise
        await asyncio.sleep(0.1 * 2 ** attempt)


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
            raise AgentError("Set api_key or AGENT_RUNTIME_TOKEN to manage definitions, volumes and mounts")
        return self.api_key

    # Definitions: reusable agent configurations with their tool sources (mcpServers, openApi, builtins).
    # Make agents from one with create_agent(definition=id). Fields use the REST names (systemPrompt, mcpServers...).
    async def create_definition(self, **fields):
        return await _http(self.http, self.base, "/v1/definitions", self._operator(), "POST", fields, retry=False)

    async def update_definition(self, definition_id, **fields):
        """Replace the fields given (None removes one); apply="all" also reconfigures its live agents."""
        return await _http(self.http, self.base, f"/v1/definitions/{quote(definition_id, safe='')}", self._operator(), "PATCH", fields, retry=False)

    async def definition(self, definition_id):
        return await _http(self.http, self.base, f"/v1/definitions/{quote(definition_id, safe='')}", self._operator())

    async def definitions(self):
        return await _http(self.http, self.base, "/v1/definitions", self._operator())

    async def delete_definition(self, definition_id):
        return await _http(self.http, self.base, f"/v1/definitions/{quote(definition_id, safe='')}", self._operator(), "DELETE", retry=False)

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

    async def tool_sources(self, agent_id, *, schemas=False, refresh=False):
        """Every source of an agent's tools (its application, file tools, built-ins, MCP servers, OpenAPI
        specs) and what each offers the model. schemas includes input schemas; refresh lists MCP servers now."""
        query = "&".join(name for name, on in (("schemas=true", schemas), ("refresh=true", refresh)) if on)
        detail = await _http(self.http, self.base, f"/v1/agents/{quote(agent_id)}" + (f"?{query}" if query else ""), self._operator())
        return detail["toolSources"]

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
        response = await _transfer(self.runtime.http, method, self._file(path), content=content, headers={
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

    async def write(self, path, data, *, version=None, content_type=None):
        """Without content_type, the runtime sniffs it from the file's first bytes and name."""
        headers = {"Content-Type": content_type or "application/octet-stream"}
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

    async def link(self, path, *, method="GET", expires_in=None, max_bytes=None, content_type=None):
        """A signed URL to download (GET) or upload (PUT) one file without a token: {"url", "expiresAt", ...}.
        expires_in is in seconds (default 900, at most 86400); max_bytes and content_type bound an upload."""
        body = {"path": path, "method": method, **{key: value for key, value in {"expiresIn": expires_in, "maxBytes": max_bytes, "contentType": content_type}.items() if value is not None}}
        return await self._json("/links", "POST", body)

    async def remove(self, path, *, version=None):
        return (await self._raw("DELETE", path, headers=None if version is None else {"If-Match": f'"{version}"'})).json()


async def _chunks(path):
    """A local file's bytes, a MiB at a time, so an upload never holds the whole file."""
    with open(path, "rb") as file:
        while chunk := await asyncio.to_thread(file.read, 1024 * 1024):
            yield chunk


def _error(response):
    try:
        return response.json().get("error") or f"HTTP {response.status_code}"
    except ValueError:
        return f"HTTP {response.status_code}"


class AgentFiles:
    """An agent's files with its own token: what it wrote in a run (an outcome lists `files`), and links to hand them on."""

    def __init__(self, agent):
        self.agent = agent

    def _url(self, path):
        return f"{self.agent.base}{self.agent.path}/files/" + "/".join(quote(part, safe="") for part in path.split("/") if part)

    async def _raw(self, method, path, **options):
        response = await _transfer(self.agent.http, method, self._url(path), headers={"Authorization": f"Bearer {self.agent.session['token']}", **options.pop("headers", {})}, **options)
        if not response.is_success:
            raise AgentError(_error(response), response.status_code)
        return response

    async def list(self, *, path=None, glob=None, after=None, limit=None):
        """Files under path (default: the first mount), in path order, a page at a time: {"files", "next"?}."""
        query = urlencode({key: value for key, value in {"path": path, "glob": glob, "after": after, "limit": limit}.items() if value is not None})
        return await self.agent._http(f"/files{'?' + query if query else ''}")

    async def download(self, path):
        """{"data": bytes, "content_type", "version"}"""
        response = await self._raw("GET", path)
        return {"data": response.content, "content_type": response.headers.get("content-type", "application/octet-stream").split(";")[0].strip(), "version": int(response.headers["etag"].strip('"'))}

    async def upload(self, path, data, *, content_type=None):
        """Write a file into a writable mount; without content_type the runtime sniffs it."""
        body = data.encode() if isinstance(data, str) else data
        return (await self._raw("PUT", path, content=body, headers={"Content-Type": content_type} if content_type else {}, timeout=_UPLOAD_TIMEOUT)).json()

    async def link(self, path, *, method="GET", expires_in=None, max_bytes=None, content_type=None):
        """A signed URL to download (GET) or upload (PUT) one file without a token: {"url", "expiresAt", ...}."""
        body = {"path": path, "method": method, **{key: value for key, value in {"expiresIn": expires_in, "maxBytes": max_bytes, "contentType": content_type}.items() if value is not None}}
        return await self.agent._http("/links", "POST", body, retry=False)


class AgentClient:
    # How often a request still waiting for its result asks for its status, in case the result's event was lost.
    poll_interval = 30

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

    async def _outcome(self, request_id, future):
        """A request's result arrives as an event; a reconnect also settles from /state. As a last resort,
        ask for its status now and then, so an event lost on the way can never strand the caller."""
        while not (await asyncio.wait({future}, timeout=self.poll_interval))[0]:
            try:
                record = await self.request_status(request_id)
            except Exception:
                continue
            if "outcome" in record:
                self._settle(request_id, record["outcome"])
        return future.result()

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

        key = str(message["id"])
        if method == "tools/call":
            self.active[key] = asyncio.current_task()
        try:
            await reply(await _answer_mcp(message, self.tools, lambda meta: _tool_context(meta, key)))
        except asyncio.CancelledError:
            pass
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
            return await asyncio.wait_for(self._outcome(request_id, future), timeout)
        except TimeoutError as error:
            raise AgentError("Request timed out; inspect request_status() or reuse the same idempotency_key", request_id=request_id) from error
        finally:
            self.pending.pop(request_id, None)
            if future.done() and not future.cancelled():
                future.exception()  # An SSE error may arrive while POST fails.
            elif not future.done():
                future.cancel()

    async def prompt(self, text, *, actor=None, from_=None, files=None, idempotency_key=None, **options):
        """`from_` ({"id", "name"?, "username"?}) says who sent the message: the model sees it in a block only
        the runtime can write, and its id is the turn's actor. `actor` names someone else acting (`act` in
        identity tokens) without telling the model. `files` are attached: bytes, a local path (str or Path),
        {"name", "data": bytes, "content_type"?}, or {"path"} for a file already in the agent's mounts. Each is
        uploaded to the agent's workspace (uploads/<request>/<name>) first, then attached by path."""
        request_id = idempotency_key or str(uuid.uuid4())
        attached = await self._attach(request_id, files) if files else None
        return await self.request("prompt", {"text": text, **({"files": attached} if attached else {}), **({"actor": actor} if actor else {}), **({"from": from_} if from_ else {})}, idempotency_key=request_id, **options)

    async def _attach(self, request_id, files):
        names, attached = set(), []
        for index, file in enumerate(files):
            if isinstance(file, dict) and set(file) == {"path"}:
                attached.append({"path": file["path"]})
                continue
            content_type = None
            if isinstance(file, (str, os.PathLike)):
                path = Path(file)
                name, data = path.name, _chunks(path)
            elif isinstance(file, (bytes, bytearray, memoryview)):
                name, data = None, bytes(file)
            elif isinstance(file, dict) and isinstance(file.get("data"), (bytes, bytearray)):
                name, data, content_type = file.get("name"), bytes(file["data"]), file.get("content_type")
            else:
                raise AgentError("A file is bytes, a local path, {\"name\", \"data\", \"content_type\"?} or {\"path\"} in the agent's mounts")
            # Each file in a request needs its own name: they share uploads/<request>/.
            base = name or f"attachment-{index + 1}"
            unique, n = base, 2
            while unique in names:
                stem, dot, extension = base.rpartition(".")
                unique = f"{stem}-{n}.{extension}" if dot and stem else f"{base}-{n}"
                n += 1
            names.add(unique)
            response = await self.http.put(f"{self.base}{self.path}/uploads/{quote(request_id, safe='')}/{quote(unique, safe='')}", content=data, headers={
                "Authorization": f"Bearer {self.session['token']}", **({"Content-Type": content_type} if content_type else {})}, timeout=_UPLOAD_TIMEOUT)
            if not response.is_success:
                raise AgentError(_error(response), response.status_code)
            attached.append({"path": response.json()["path"]})
        return attached

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

    @property
    def files(self):
        """The agent's files, at the paths it sees them (/workspace/...): list, download, upload and link."""
        return AgentFiles(self)

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


# Serving tools to agents from your own server ------------------------------------------------------
# The runtime calls a tool source with auth {"type": "runtime"} with a token it signs for each request.
# verify_runtime_token checks it; serve_tools is an ASGI app that serves tools to the runtime and hands
# each call the verified identity. They need the `cryptography` package (pip install cryptography).


class RuntimeTokenError(Exception):
    """A token that is missing, malformed, unsigned by the runtime, for another server, or expired."""


def _b64decode(text):
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _b64encode(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _part(text):
    try:
        return json.loads(_b64decode(text))
    except Exception:
        raise RuntimeTokenError("Malformed token") from None


# The runtime's public keys, per HTTP client and JWKS URL: kept five minutes, and fetched again for a
# key id not seen (a rotated key), at most every 10 seconds.
_key_sets = {}


async def _public_key(url, kid, http):
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    import time
    cache = _key_sets.setdefault((id(http), url), {"keys": {}, "fetched": 0.0, "http": http})
    age = time.monotonic() - cache["fetched"]
    if age > 300 or (kid not in cache["keys"] and age > 10):
        client = http or httpx.AsyncClient(timeout=10)
        try:
            response = await client.get(url, headers={"Accept": "application/json"})
        finally:
            if http is None:
                await client.aclose()
        if response.status_code != 200:
            raise RuntimeTokenError(f"Could not read the runtime's keys ({url}: HTTP {response.status_code})")
        keys = {}
        for jwk in response.json().get("keys", []):
            if jwk.get("kty") == "OKP" and jwk.get("crv") == "Ed25519" and isinstance(jwk.get("kid"), str):
                keys[jwk["kid"]] = Ed25519PublicKey.from_public_bytes(_b64decode(jwk["x"]))
        cache.update(keys=keys, fetched=time.monotonic())
    key = cache["keys"].get(kid)
    if key is None:
        raise RuntimeTokenError("Token signed with a key the runtime does not publish")
    return key


async def verify_runtime_token(token, *, runtime, audience, issuer=None, http=None, clock_tolerance=30):
    """Verify an identity token and return who the call is for (a RuntimeIdentity, with the token's
    claims): the signature against the runtime's published Ed25519 keys (EdDSA only), the issuer,
    that the audience is yours (a string or a list), and the times."""
    import time
    from cryptography.exceptions import InvalidSignature
    pieces = token.split(".")
    if len(pieces) != 3:
        raise RuntimeTokenError("Malformed token")
    header = _part(pieces[0])
    if header.get("alg") != "EdDSA" or not isinstance(header.get("kid"), str):
        raise RuntimeTokenError("Token is not an EdDSA token with a key id")
    runtime = runtime.rstrip("/")
    key = await _public_key(f"{runtime}/.well-known/jwks.json", header["kid"], http)
    try:
        key.verify(_b64decode(pieces[2]), f"{pieces[0]}.{pieces[1]}".encode())
    except (InvalidSignature, ValueError):
        raise RuntimeTokenError("Token signature does not verify") from None
    claims = _part(pieces[1])
    now = time.time()
    if claims.get("iss") != (issuer or runtime).rstrip("/"):
        raise RuntimeTokenError("Token is from another issuer")
    wanted = {value.rstrip("/") for value in ([audience] if isinstance(audience, str) else audience)}
    given = claims.get("aud")
    if not any(isinstance(value, str) and value.rstrip("/") in wanted for value in (given if isinstance(given, list) else [given])):
        raise RuntimeTokenError("Token is for another server")
    if not isinstance(claims.get("exp"), (int, float)) or claims["exp"] + clock_tolerance < now:
        raise RuntimeTokenError("Token has expired")
    if isinstance(claims.get("nbf"), (int, float)) and claims["nbf"] - clock_tolerance > now:
        raise RuntimeTokenError("Token is not valid yet")
    if isinstance(claims.get("iat"), (int, float)) and claims["iat"] - clock_tolerance > now:
        raise RuntimeTokenError("Token is issued in the future")
    identity = identity_from_claims(claims)
    identity.claims = claims
    return identity


def serve_tools(tools, *, runtime, audience=None, issuer=None, metadata=True, http=None, server_name="agent-runtime-tools"):
    """Serve tools (@tool functions, a list or a dict) as a stateless MCP server over Streamable HTTP for
    the runtime to call with its identity tokens: an ASGI app (mount it in FastAPI or Starlette, or run it
    with uvicorn). Every call's ToolContext carries the verified identity; requests without a valid token
    get a 401. `audience` is your server's URL as the runtime calls it; by default the request's URL."""
    table = tools if isinstance(tools, dict) else {item.name: item for item in tools}
    issuer = (issuer or runtime).rstrip("/")
    well_known = "/.well-known/oauth-protected-resource"

    async def app(scope, receive, send):
        if scope["type"] == "lifespan":
            while True:
                event = await receive()
                if event["type"] == "lifespan.startup":
                    await send({"type": "lifespan.startup.complete"})
                elif event["type"] == "lifespan.shutdown":
                    await send({"type": "lifespan.shutdown.complete"})
                    return
        if scope["type"] != "http":
            return
        headers = {name.decode().lower(): value.decode() for name, value in scope.get("headers", [])}
        host = headers.get("host", "localhost")
        path = scope.get("root_path", "") + scope["path"]
        origin = f"{scope.get('scheme', 'http')}://{host}"

        async def respond(status, body=None, extra=()):
            data = b"" if body is None else json.dumps(body).encode()
            response_headers = [(b"content-type", b"application/json")] if body is not None else []
            await send({"type": "http.response.start", "status": status, "headers": response_headers + [(name.encode(), value.encode()) for name, value in extra]})
            await send({"type": "http.response.body", "body": data})

        if metadata and scope["method"] == "GET" and scope["path"].startswith(well_known):
            resource = origin + (scope["path"][len(well_known):] or "/")
            return await respond(200, {"resource": resource, "authorization_servers": [issuer], "bearer_methods_supported": ["header"], "resource_name": server_name})
        if scope["method"] != "POST":
            return await respond(405, {"error": "Use POST: this MCP server is stateless and has no event stream"}, [("allow", "POST")])
        body = b""
        while True:
            event = await receive()
            body += event.get("body", b"")
            if not event.get("more_body"):
                break
        try:
            match = headers.get("authorization", "").split(" ", 1)
            if len(match) != 2 or match[0].lower() != "bearer" or not match[1].strip():
                raise RuntimeTokenError("No bearer token")
            identity = await verify_runtime_token(match[1].strip(), runtime=runtime, audience=audience or f"{origin}{path}", issuer=issuer, http=http)
        except RuntimeTokenError as error:
            challenge = 'Bearer error="invalid_token"' + (f', resource_metadata="{origin}{well_known}{"" if path == "/" else path}"' if metadata else "")
            return await respond(401, {"error": str(error)}, [("www-authenticate", challenge)])
        try:
            payload = json.loads(body)
        except ValueError:
            return await respond(400, {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}})
        messages = payload if isinstance(payload, list) else [payload]
        replies = []
        for message in messages:
            if not isinstance(message, dict) or not isinstance(message.get("method"), str):
                if isinstance(message, dict) and "id" in message:
                    replies.append({"jsonrpc": "2.0", "id": message.get("id"), "error": {"code": -32600, "message": "Invalid request"}})
                continue
            if "id" not in message:
                continue
            key = str(message["id"])
            answer = await _answer_mcp(message, table, lambda meta, key=key: _tool_context(meta, key, identity), server_name)
            replies.append({"jsonrpc": "2.0", "id": message["id"], **answer})
        if not replies:
            return await respond(202)
        return await respond(200, replies if isinstance(payload, list) else replies[0])

    return app


class TestRuntime:
    """Test a tool server's authorization without a runtime: signs identity tokens with a key of its
    own, and serves that key to serve_tools / verify_runtime_token through `http`.

        runtime = TestRuntime()
        app = serve_tools(tools, **runtime.options)
        result = await runtime.call_tool(app, "https://app.test/mcp", "list_todos", {}, subject="alice")
    """
    __test__ = False  # Not a test case, whatever collects tests.

    def __init__(self, url="https://runtime.test"):
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
        from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
        self.url = url.rstrip("/")
        self.kid = str(uuid.uuid4())
        self.key = Ed25519PrivateKey.generate()
        public = self.key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
        self.jwk = {"kty": "OKP", "crv": "Ed25519", "x": _b64encode(public), "kid": self.kid, "alg": "EdDSA", "use": "sig"}
        jwks = f"{self.url}/.well-known/jwks.json"
        self.http = httpx.AsyncClient(transport=httpx.MockTransport(
            lambda request: httpx.Response(200, json={"keys": [self.jwk]}) if str(request.url) == jwks else httpx.Response(404)))
        self.options = {"runtime": self.url, "http": self.http}

    def token(self, audience, *, subject=None, actor=None, tenant="test", agent="client_test", definition=None, context=None, origin=None,
              expires_in=120, claims=None, header=None):
        """A token for `audience` as the runtime would sign it; `claims` and `header` override, to test rejections."""
        import time
        now = int(time.time())
        payload = {"iss": self.url, "aud": audience, "sub": subject or agent, "tenant": tenant, "agent": agent, "iat": now, "exp": now + expires_in, "jti": str(uuid.uuid4())}
        payload.update({key: value for key, value in (("definition", definition), ("ctx", context), ("act", actor), ("origin", origin)) if value is not None})
        payload.update(claims or {})
        signed = f"{_b64encode(json.dumps({'alg': 'EdDSA', 'kid': self.kid, 'typ': 'JWT', **(header or {})}).encode())}.{_b64encode(json.dumps(payload).encode())}"
        return f"{signed}.{_b64encode(self.key.sign(signed.encode()))}"

    async def post(self, app, url, message, token=None, **identity):
        """POST a JSON-RPC message to an ASGI app at `url`, with a token for `identity` (or `token`; "" for none)."""
        token = self.token(url, **identity) if token is None else token
        headers = {"Content-Type": "application/json", **({"Authorization": f"Bearer {token}"} if token else {})}
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app)) as client:
            return await client.post(url, json=message, headers=headers)

    async def call_tool(self, app, url, name, arguments, **identity):
        """Call one tool through an ASGI app as `identity`: its CallToolResult, or the error raised."""
        response = await self.post(app, url, {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": arguments}}, **identity)
        body = response.json()
        if response.status_code != 200:
            raise RuntimeError(f"HTTP {response.status_code}: {body.get('error')}")
        if "error" in body:
            raise RuntimeError(body["error"]["message"])
        return body["result"]
