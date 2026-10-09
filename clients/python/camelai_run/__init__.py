"""camelRun's Python SDK: keyed agents you upsert and run, with tools in your process.

    async with Agents() as agents:  # CAMELAI_API_KEY
        agent = await agents.upsert("support-triage", model="anthropic/claude-sonnet-5-5", instructions="...")
        run = await agent.run("Summarize ticket 123")
        print(run.text)

AgentRuntime and AgentClient are the lower-level interface it is built on.
"""
import asyncio
import base64
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import inspect
import json
import os
import random
import re
from pathlib import Path
from typing import Any, NotRequired, TypedDict, get_type_hints
from urllib.parse import quote, urlencode, urlparse
import uuid

import httpx

# pyproject.toml's version; tests/python_sdk.py checks they match.
__version__ = "0.13.0"

__all__ = [
    "Agents", "Agent", "Run", "RunInput", "InputDetail", "Mount", "WorkspaceMount", "RunStream", "StreamPart", "Runs", "StatelessRunStream",
    "tool", "Tool", "ToolContext", "InputRequired", "RuntimeIdentity", "identity_from_claims",
    "AgentError", "RunError",
    "AgentRuntime", "AgentClient", "AgentFiles", "Download", "Volume", "Telemetry", "Transcriptions", "DEFAULT_URL",
    "serve_tools", "verify_runtime_token", "verify_file_url", "RuntimeTokenError", "TestRuntime", "verify_webhook", "WebhookVerificationError",
]
# Distinguishes "not given" from None (which means "never expires") in create_agent.
_DEFAULT = object()
# The hosted runtime; `url` points elsewhere (a self-hosted runtime, or http://127.0.0.1:8790 in development).
DEFAULT_URL = "https://run.camelai.com"
# Requests one client may wait on at once, and events waiting for a slow on_event (past it, streamed deltas are dropped).
_MAX_PENDING = 1000
# How long close() waits, by default, for the tool calls running to finish: inside the usual 30 s from SIGTERM to SIGKILL.
_DRAIN_SECONDS = 25
# The attached server says it is shutting down: the runtime sends it no new calls and waits for those it has.
_DRAINING = "notifications/agent-runtime/draining"
_MAX_QUEUED_EVENTS = 10_000


def _env(*names):
    return next((os.environ[name] for name in names if os.environ.get(name)), None)


class AgentError(RuntimeError):
    """`status` is the HTTP status (0 for a run's or the connection's failure); `code` a stable name for the
    failure where the runtime gives one; `uncertain` that nobody can tell whether the work took effect."""

    def __init__(self, message, status=0, request_id=None, retry_after=None, code=None, uncertain=False):
        super().__init__(message)
        self.status, self.request_id = status, request_id
        # Seconds the runtime asked to wait before retrying (its Retry-After), for 429 and 503.
        self.retry_after = retry_after
        self.code, self.uncertain = code, uncertain


class RunError(AgentError):
    """A run that failed (agent.run raises it unless throw_on_error=False): `run` is how it ended, `code` why.
    `status` is always 0: a run's failure is not an HTTP response, so branch on `code`."""

    def __init__(self, run):
        super().__init__(run.error["message"] if run.error else "The run failed", request_id=run.id,
                         code=run.error and run.error["code"], uncertain=bool(run.error and run.error.get("uncertain")))
        self.run = run


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
    # The run (its request id) the call was made in, and the model's tool call it is for, when there are.
    request_id: str | None = None
    tool_call_id: str | None = None
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
                           approval=claims["approval"] if isinstance(claims.get("approval"), dict) else None,
                           request_id=text(claims.get("req")), tool_call_id=text(claims.get("tcid")))


class InputRequired(Exception):
    """Raised by a ToolContext's asks: the call answers MCP's input_required, and runs again once the user answers."""

    def __init__(self, input_requests, request_state=None):
        super().__init__("Waiting for the user's input")
        self.input_requests = input_requests
        # The answers so far, which the runtime hands back on the next call (MCP's requestState).
        self.request_state = request_state


@dataclass
class ToolContext:
    # This attempt's id (a JSON-RPC id): a new one each attempt, so never a key for side effects.
    call_id: str
    # Set by the runtime, e.g. {"channel", "conversationId", "sender"} for a turn a channel message started.
    origin: dict | None = None
    # Who the call is for: always set by serve_tools; set for attached tools by runtimes that send it.
    identity: RuntimeIdentity | None = None
    # The same for every attempt at this call (a retry after a lost connection, a call run again once the user
    # answered): key your side effects by it, so a call that runs twice acts once.
    idempotency_key: str = ""
    # The model's tool call this is (or, from code, the code's call).
    tool_call_id: str | None = None
    # The user's answers to this call's asks, on the call the runtime makes once they answered.
    input_responses: dict = field(default_factory=dict, repr=False)
    _asked: int = field(default=0, repr=False)
    _notify: object = field(default=None, repr=False, compare=False)
    _progress_token: object = field(default=None, repr=False, compare=False)
    _reported: float = field(default=0, repr=False, compare=False)

    def progress(self, message=None, *, progress=None, total=None):
        """Report progress: people watching see it, and each report restarts the tool's timeout, so a long call
        that keeps reporting is not cut off. A message, or how far it is (`progress` of `total`)."""
        if self._progress_token is None or self._notify is None:
            return
        self._reported = max(progress if progress is not None else self._reported + 1, self._reported)
        params = {"progressToken": self._progress_token, "progress": self._reported,
                  **({"total": total} if total is not None else {}), **({"message": message} if message is not None else {})}
        self._notify({"jsonrpc": "2.0", "method": "notifications/progress", "params": params})

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
    # True, or a function of (arguments, context): the user approves each such call before it runs.
    needs_approval: object = None
    # Seconds one call may go without an answer (1 to 1200; default 15); each context.progress() restarts it.
    timeout: float | None = None
    # How the model may call it: "direct" (only as a tool of its own, never from code), "codemode" (only from code in
    # js_exec, as tools.<name>(...)) or "both". Default: both when the agent has up to 10 tools, else codemode, so the
    # model can call it from js_exec unless it says "direct".
    exposure: str | None = None

    def definition(self):
        return {"name": self.name, "description": self.description, "parameters": self.parameters}

    def mcp_tool(self):
        """This tool as an attached MCP server lists it (tools/list)."""
        meta = {**({"agent-runtime/needsApproval": True} if self.needs_approval else {}),
                **({"agent-runtime/timeoutMs": int(self.timeout * 1000)} if self.timeout else {}),
                **({"agent-runtime/exposure": self.exposure} if self.exposure else {})}
        return {"name": self.name, "description": self.description, "inputSchema": self.parameters, **({"_meta": meta} if meta else {})}

    async def __call__(self, **arguments):
        """Run the function (async, or a plain function in a thread, so it never blocks the connection)."""
        if inspect.iscoroutinefunction(self.function):
            return await self.function(**arguments)
        return await asyncio.to_thread(self.function, **arguments)

    async def _run(self, arguments, inline=False):
        """inline: a plain function runs in this thread (a WSGI server's request thread, with its database connection)."""
        if inline and not inspect.iscoroutinefunction(self.function):
            return self.function(**arguments)
        return await self(**arguments)


def _call_tool_result(result):
    """A tool's JSON value as an MCP tools/call result: a text block, plus structured content for objects."""
    text = json.dumps(result, allow_nan=False)
    return {"content": [{"type": "text", "text": text}], **({"structuredContent": result} if isinstance(result, dict) else {})}


def tool(function=None, *, name=None, description=None, needs_approval=None, timeout=None, exposure=None):
    """Expose a function (async, or plain: it runs in a thread) as a tool; its JSON schema comes from the
    annotations and its description from the docstring. Return any JSON value (None is fine); raise to tell
    the model the call failed. `timeout`: seconds one call may take (default 15); context.progress() restarts it.
    With needs_approval (True, or a function of the arguments and context), the user approves each call, shown
    as the runtime sees it, before it runs; such a tool is declared to the model directly.
    `exposure`: "direct" (the model calls it only as a tool of its own, never from code in js_exec), "codemode" (only
    from js_exec) or "both". Default: both for an agent with up to 10 tools, else codemode, so the model can call it
    from js_exec unless it is "direct"."""
    if exposure not in (None, "direct", "codemode", "both"):
        raise ValueError('exposure is "direct", "codemode" or "both"')
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
        return Tool(name or fn.__name__, description or inspect.getdoc(fn) or fn.__name__,
                    {"type": "object", "properties": properties, "required": required, "additionalProperties": False}, fn, with_context, needs_approval, timeout, exposure)
    return decorate(function) if function else decorate


def _tool_context(meta, fallback_id, identity=None, notify=None):
    """A call's context from its _meta, with the identity the runtime sent (or `identity`, from a verified token)."""
    sent = identity_from_claims(meta["agent-runtime/identity"]) if isinstance(meta.get("agent-runtime/identity"), dict) else None
    who = identity or sent
    origin = meta.get("agent-runtime/origin") if isinstance(meta.get("agent-runtime/origin"), dict) else (who.origin if who else None)
    call_id = meta.get("agent-runtime/callId") or fallback_id
    tool_call_id = meta.get("agent-runtime/toolCallId") if isinstance(meta.get("agent-runtime/toolCallId"), str) else None
    inner = meta.get("agent-runtime/innerCallId") if isinstance(meta.get("agent-runtime/innerCallId"), str) else ""
    # The runtime's stable key; from a runtime that sends none, the model's call (and the code's call within it).
    key = meta.get("agent-runtime/idempotencyKey") if isinstance(meta.get("agent-runtime/idempotencyKey"), str) else (
        ":".join([who.agent if who else "", tool_call_id, inner]) if tool_call_id else call_id)
    return ToolContext(call_id=call_id, origin=origin, identity=who, idempotency_key=key, tool_call_id=tool_call_id,
                       _notify=notify, _progress_token=meta.get("progressToken"))


async def _answer_mcp(message, tools, context_for, server_name="agent-runtime-sdk-python", inline=False):
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
            needs = needs(dict(args), context)
            if inspect.isawaitable(needs):
                needs = await needs
        if needs and not (context.identity and context.identity.approval):
            # Not yet approved: the runtime asks the user, showing this call, and calls again once they approve.
            return {"result": {"resultType": "input_required", "inputRequests": {"approval": {"method": "agent-runtime/approval"}}}}
        if definition.with_context:
            args["context"] = context
        try:
            answer = _call_tool_result(await definition._run(args, inline))
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
    if address.scheme != "https" and not (address.scheme == "http" and _private_host(address.hostname or "")):
        raise ValueError("Remote runtimes require https://; http:// only on a private network (localhost, a single-label or .internal name, a private IP)")
    return url.rstrip("/")


def _private_host(hostname):
    """Hosts plain http:// may reach: loopback, and names and addresses only a private network resolves."""
    host = hostname.lower().rstrip(".")
    if host in ("localhost", "::1") or host.endswith((".localhost", ".internal", ".local")):
        return True
    parts = host.split(".")
    if len(parts) == 4 and all(part.isdigit() for part in parts):
        a, b = int(parts[0]), int(parts[1])
        return a in (127, 10) or (a == 172 and 16 <= b <= 31) or (a == 192 and b == 168)
    return "." not in host and ":" not in host


def _code(value):
    """An error body's stable name: its code, or the prefix of its message ("APPLICATION_CONNECTED: ...")."""
    if isinstance(value.get("code"), str):
        return value["code"]
    import re
    match = re.match(r"([A-Z][A-Z0-9_]+):", value.get("error") or "") if isinstance(value.get("error"), str) else None
    return match.group(1) if match else None


def _arity(function):
    """How many positional arguments a callback takes (1 where Python cannot say)."""
    try:
        parameters = inspect.signature(function).parameters.values()
    except (TypeError, ValueError):
        return 1
    if any(parameter.kind == parameter.VAR_POSITIONAL for parameter in parameters):
        return 2
    return sum(1 for parameter in parameters if parameter.kind in (parameter.POSITIONAL_ONLY, parameter.POSITIONAL_OR_KEYWORD))


class _Session(Mapping):
    """An agent's credentials: session["id"], session["token"], session["expiresAt"]. Its repr leaves the token out, and
    it is not JSON-serializable, so it cannot end up in a log whole: store it with credentials(), in secret storage."""

    def __init__(self, values):
        self._values = dict(values)

    def __getitem__(self, key):
        return self._values[key]

    def __iter__(self):
        return iter(self._values)

    def __len__(self):
        return len(self._values)

    def credentials(self):
        """The id, token and expiry as a plain dict, to keep in secret storage and connect with again."""
        return dict(self._values)

    def __repr__(self):
        return repr({key: ("<redacted>" if key == "token" else value) for key, value in self._values.items()})

    __str__ = __repr__


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
# A transcription of long audio takes a while: the runtime gives its provider 5 minutes.
_TRANSCRIPTION_TIMEOUT = 360


def _encoded(body):
    encoded = None if body is None else json.dumps(body, allow_nan=False).encode()
    if encoded and len(encoded) > 1_100_000:
        raise AgentError("Request exceeds transport limit")
    return encoded


def _request_options(token, headers, timeout):
    return {"headers": {"Authorization": f"Bearer {token}", "Content-Type": "application/json", **(headers or {})}, **({"timeout": timeout} if timeout else {})}


def _json_of(response):
    """A JSON answer's value, or the AgentError it is."""
    if not response.is_success:
        try:
            value = response.json()
        except ValueError:
            value = {}
        raise AgentError(value.get("error", f"HTTP {response.status_code}"), response.status_code, retry_after=_retry_after(response), code=_code(value))
    return response.json()


def _retry_delay(error, attempt, retry):
    """Seconds to wait before trying a failed request again, or None to give up (raise)."""
    limited = isinstance(error, AgentError) and error.status == 429
    if limited:
        if attempt >= _RATE_LIMIT_ATTEMPTS - 1:
            return None
    elif not retry or attempt >= 3 or (isinstance(error, AgentError) and error.status < 500):
        return None
    # Honour the runtime's Retry-After, with jitter so refused callers do not return together; else back off exponentially.
    backoff = min(10.0, (0.5 if limited else 0.1) * 2 ** attempt)
    hinted = error.retry_after if isinstance(error, AgentError) else None
    return hinted + random.random() * min(1.0, backoff) if hinted is not None else backoff


async def _http(client, base, path, token, method="GET", body=None, retry=True, headers=None, timeout=None):
    encoded = _encoded(body)
    attempt = 0
    while True:
        try:
            return _json_of(await client.request(method, base + path, content=encoded, **_request_options(token, headers, timeout)))
        except Exception as error:
            delay = _retry_delay(error, attempt, retry)
            if delay is None:
                raise
            await asyncio.sleep(delay)
            attempt += 1


def _http_sync(client, base, path, token, method="GET", body=None, retry=True, headers=None, timeout=None):
    """_http for an httpx.Client: the same retries, waiting in this thread."""
    import time
    encoded = _encoded(body)
    attempt = 0
    while True:
        try:
            return _json_of(client.request(method, base + path, content=encoded, **_request_options(token, headers, timeout)))
        except Exception as error:
            delay = _retry_delay(error, attempt, retry)
            if delay is None:
                raise
            time.sleep(delay)
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


_KEY = r"[A-Za-z0-9_-]{1,80}"


def _check_key(key, what):
    import re
    if not isinstance(key, str) or not re.fullmatch(_KEY, key):
        raise AgentError(f"{what} key is 1 to 80 letters, digits, _ and -: {key!r} is not")


def _path(*parts):
    return "/".join(quote(part, safe="") for part in parts)


class _RuntimeCalls:
    """The operator API's calls that are one request each, shared by the async AgentRuntime and the synchronous one
    (camelai_run.sync): each returns what self._rest returns, an awaitable here and the answer there."""

    def fork_agent(self, agent_id, *, key=None, name=None, at_message=None, ttl_seconds=_DEFAULT, subject=None, context=None, instructions_append=None, model_headers=_DEFAULT):
        """A new agent with this one's configuration, a copy of its history and a fork of its workspace. Returns its
        credentials and where it came from ({"id", "token", "expiresAt", "forkedFrom": {"agentId", "atMessage"}}).
        `at_message` ends its history at a history index (that message, and the tool results answering it) or a request
        id (that request's whole turn); by default, at the last turn that ended. `key` is the fork's own: a retry with it
        returns the same fork (default: one made up, and a day's lifetime, as create_agent's). `subject`, `context` and
        `instructions_append` are the fork's own instead of the source's: who it acts for, its tool servers' context, and
        its text after the instructions ("" removes it); `model_headers` too (None removes them)."""
        if key is not None:
            _check_key(key, "A fork's")
        body = {"key": key or str(uuid.uuid4())}
        if name is not None:
            body["name"] = name
        if at_message is not None:
            body["atMessage"] = at_message
        for field, value in (("subject", subject), ("context", context), ("systemPromptAppend", instructions_append)):
            if value is not None:
                body[field] = value
        if model_headers is not _DEFAULT:
            body["modelHeaders"] = model_headers
        if ttl_seconds is not _DEFAULT:
            body["ttlSeconds"] = ttl_seconds
        elif key is None:
            body["ttlSeconds"] = 86400
        return self._rest("POST", f"/v1/agents/{_path(agent_id)}/fork", body)

    def agent_credentials(self, key_or_id):
        """An existing agent's credentials ({"id", "token", "expiresAt"}), by its id or the key it was made with, its
        configuration untouched. AgentError with status 404 when there is none."""
        return self._rest("GET", f"/v1/agents/{_path(key_or_id)}/credentials")

    def rotate_agent_credentials(self, agent_id):
        """A new token for the agent ({"id", "token", "expiresAt"}): the old one stops working at once, and connections
        made with it close. The process serving the agent connects again with the new one."""
        return self._rest("POST", f"/v1/agents/{_path(agent_id)}/credentials/rotate", {}, retry=False)

    def upsert_agent(self, key, *, tools=(), traceparent=None, **fields):
        """The agent for `key`: made if there is none, set to `fields` (create_agent's) if they differ. Returns its
        credentials ({"id", "token", "expiresAt", "reconfigured"?}); connect with connect_agent. Keyed agents live until deleted.
        `prompt` (the prompt call's body, {"text", "requestId", ...}) is sent once the agent is made: the answer's "prompt" is
        its request, or {"error": {"status", "code", "message"}} when it was refused. A retry with the same requestId sends it once.
        `initial_messages` (Pi messages) is the history it begins with, used only when the agent is made; `import_messages`
        ({"format": "anthropic" | "openai-responses" | "openai-chat", "messages": [...], "model"?}) is one in another API's
        format, which the runtime converts (not both).
        `traceparent` (a W3C trace context) makes that first prompt's run continue the caller's trace."""
        if not self.api_key:
            raise AgentError("No API key: set CAMELAI_API_KEY (or pass api_key). Create one at https://run.camelai.com/console/tokens. Coding agents: read https://run.camelai.com/SKILL.md")
        _check_key(key, "An agent's")
        # The key is the agent's idempotency key: the same key is the same agent, reconfigured when its configuration differs.
        return self._rest("POST", "/v1/agents", _provisioning(tools, **fields), headers={"Idempotency-Key": key, **_trace_header(traceparent)})

    def create_run(self, request, *, idempotency_key=None, wait=None, traceparent=None):
        """Start a stateless run (POST /v1/runs): `request` is its configuration and input ({"input", "systemPrompt"?,
        "model"?, "output"?, ...}). With `wait` (True: up to 60 s, or seconds) it answers once the run ends, else still
        running. Retries are safe: each create has an Idempotency-Key (one of its own unless given)."""
        body = _with_multi_agent(dict(request))
        if wait is not None:
            body["wait"] = wait
        wait_seconds = 60 if wait is True else min(float(wait), 60) if wait else 0
        return self._rest("POST", "/v1/runs", body, timeout=wait_seconds + 15,
                          headers={"Idempotency-Key": idempotency_key or str(uuid.uuid4()), **_trace_header(traceparent)})

    def get_run(self, run_id, *, wait=0):
        """A stateless run: running, or how it ended. `wait` (seconds, at most 25) waits for it to end first."""
        wait = min(wait or 0, 25)
        return self._rest("GET", f"/v1/runs/{_path(run_id)}" + (f"?wait={wait:g}" if wait else ""), timeout=wait + 15)

    def abort_run(self, run_id):
        return self._rest("POST", f"/v1/runs/{_path(run_id)}/abort", {})

    def delete_run(self, run_id):
        """Delete a run now, before its retention ends (a running one stops)."""
        return self._rest("DELETE", f"/v1/runs/{_path(run_id)}")

    def run_messages(self, run_id):
        """A run's messages: its input, the model's turns and tool results."""
        return self._rest("GET", f"/v1/runs/{_path(run_id)}/messages", then=lambda value: value["messages"])

    # Definitions: reusable agent configurations with their tool sources (mcpServers, openApi, builtins).
    # Make agents from one with create_agent(definition=id). Fields use the REST names (systemPrompt, mcpServers, runLimits...)
    # or their Python spelling (system_prompt, mcp_servers, run_limits...).
    def create_definition(self, **fields):
        return self._rest("POST", "/v1/definitions", _with_multi_agent(fields), retry=False)

    def upsert_definition(self, key, **fields):
        """The definition for `key`, set to `fields` whole: made if there is none, else a new revision if they change it.
        The same key is the same definition. With applyOnUpdate=True, a new revision also reaches every live agent made
        from it (`applied`)."""
        _check_key(key, "A definition's")
        return self._rest("POST", "/v1/definitions", _with_multi_agent(fields), headers={"Idempotency-Key": key})

    def update_definition(self, definition_id, **fields):
        """Replace the fields given (None removes one); apply="all" also reconfigures its live agents. Here builtins are
        given whole: list "delegate" in them with its settings."""
        return self._rest("PATCH", f"/v1/definitions/{_path(definition_id)}", _definition_fields(fields), retry=False)

    def definition(self, definition_id):
        return self._rest("GET", f"/v1/definitions/{_path(definition_id)}")

    def definitions(self):
        return self._rest("GET", "/v1/definitions")

    def delete_definition(self, definition_id):
        return self._rest("DELETE", f"/v1/definitions/{_path(definition_id)}", retry=False)

    def set_provider(self, name, *, base_url, models, type="openai-completions", api_key=_DEFAULT, headers=_DEFAULT, auth=None):
        """Add or replace a provider of your own: a public https server that speaks type (openai-completions,
        openai-responses or anthropic-messages), with its models ([{"id", "contextWindow", "maxOutputTokens"?, "input"?,
        "reasoning"?, "pricing"?, "compat"?}]). Agents name them "<name>/<model id>". api_key and headers left out keep
        what is stored; None removes them. auth="bearer" sends an anthropic-messages key as Authorization: Bearer."""
        return self._rest("PUT", f"/v1/providers/{_path(name)}", _provider_body(base_url, models, type, api_key, headers, auth))

    def delete_provider(self, name):
        return self._rest("DELETE", f"/v1/providers/{_path(name)}", retry=False)

    def providers(self):
        """Every provider: the built-in ones with your keys' status, and your own ("custom")."""
        return self._rest("GET", "/v1/providers")

    def list_agents(self):
        """The tenant's agents, each with the key it was made with (None for one made without) and its name."""
        return self._rest("GET", "/v1/agents")

    def create_volume(self, *, name=None, key=None, idempotency_key=None):
        """A new volume. With `key`, the tenant's volume for that key: made the first time, the same one ("existing": True)
        every time after, for as long as it lives. With `idempotency_key`, a retry within a day gets the same answer."""
        body = {k: v for k, v in {"name": name, "key": key}.items() if v is not None}
        return self._rest("POST", "/v1/volumes", body, retry=key is not None or idempotency_key is not None,
                          headers={"Idempotency-Key": idempotency_key} if idempotency_key is not None else None)

    def list_volumes(self):
        return self._rest("GET", "/v1/volumes")

    def volumes(self, ids):
        """Several volumes as they are now (each one's seq, files and bytes), in one request; at most 50."""
        return self._rest("GET", f"/v1/volumes?ids={','.join(quote(id, safe='') for id in ids)}")

    def mounts(self, agent_id):
        return self._rest("GET", f"/v1/agents/{quote(agent_id)}/mounts")

    def set_mounts(self, agent_id, mounts):
        """Replace an agent's mounts: a removed one at once, the rest from its next turn, which is told of them."""
        return self._rest("PUT", f"/v1/agents/{quote(agent_id)}/mounts", {"mounts": mounts}, retry=False)

    def me(self):
        """Who the API key is: {"tenant", "via", "defaultModel", ...}; tenant is your tenant's id, which serve_tools and verify_runtime_token take;
        defaultModel is the model an agent gets when it names none."""
        return self._rest("GET", "/v1/me")

    def browser_token(self, agent_id, *, ttl_seconds=None, scopes=None, events=None, redact=None, subject=None):
        """A token a browser reads one agent with (the TypeScript SDK's watchAgent): mint one per user, after your own
        access checks. It reads only that agent's events, state, history and inputs (or `scopes`), for `ttl_seconds`
        (default 900, 5 to 3600). Returns {"token", "expiresAt", "agentId", "url"}."""
        body = {key: value for key, value in {"ttlSeconds": ttl_seconds, "scopes": scopes, "events": events, "redact": redact, "subject": subject}.items() if value is not None}
        return self._rest("POST", f"/v1/agents/{_path(agent_id)}/browser-tokens", body, retry=False)

    def inbox(self, *, state=None):
        """Inputs waiting on someone across all the tenant's agents (state="pending", say), newest first."""
        return self._rest("GET", "/v1/inputs" + (f"?state={state}" if state else ""))

    def tool_sources(self, agent_id, *, schemas=False, refresh=False):
        """Every source of an agent's tools (its application, file tools, built-ins, MCP servers, OpenAPI
        specs) and what each offers the model. schemas includes input schemas; refresh lists MCP servers now."""
        query = "&".join(name for name, on in (("schemas=true", schemas), ("refresh=true", refresh)) if on)
        return self._rest("GET", f"/v1/agents/{quote(agent_id)}" + (f"?{query}" if query else ""), then=lambda detail: detail["toolSources"])

    # Key scopes: provider keys of a group of your agents (an org of your users, say), which the model calls of the agents
    # made with key_scope=<scope> use before the tenant's own. Keys and header values are stored sealed and never returned.
    def set_scope_key(self, scope, provider, *, api_key=None, base_url=None, headers=None, region=None):
        """Store `provider`'s key for the scope (an existing one is replaced): `api_key`, or a gateway at `base_url` that
        holds it (then no auth header is sent, only `headers`). `region` is amazon-bedrock's. The scope's agents use it from
        their next model call. Returns the scope ({"scope", "providers": [{"provider", "last4"?, "baseUrl"?, ...}]})."""
        body = {key: value for key, value in {"apiKey": api_key, "baseUrl": base_url, "headers": headers, "region": region}.items() if value is not None}
        return self._rest("PUT", f"/v1/key-scopes/{_path(scope, 'providers', provider)}", body)

    def delete_scope_key(self, scope, provider):
        return self._rest("DELETE", f"/v1/key-scopes/{_path(scope, 'providers', provider)}", retry=False)

    def key_scope(self, scope):
        """The providers the scope has keys for ({"scope", "providers"}), never the keys."""
        return self._rest("GET", f"/v1/key-scopes/{_path(scope)}")

    def delete_key_scope(self, scope):
        """Delete every key and provider of the scope."""
        return self._rest("DELETE", f"/v1/key-scopes/{_path(scope)}", retry=False)

    def set_scope_provider(self, scope, name, *, base_url, models, type="openai-completions", api_key=_DEFAULT, headers=_DEFAULT, auth=None):
        """A provider of the scope's own (as set_provider's): only the scope's agents name its models, "<name>/<model id>",
        before the tenant's provider of that name."""
        return self._rest("PUT", f"/v1/key-scopes/{_path(scope, 'model-providers', name)}", _provider_body(base_url, models, type, api_key, headers, auth))

    def delete_scope_provider(self, scope, name):
        return self._rest("DELETE", f"/v1/key-scopes/{_path(scope, 'model-providers', name)}", retry=False)

    def scope_providers(self, scope):
        """The scope's own providers, never their keys or header values."""
        return self._rest("GET", f"/v1/key-scopes/{_path(scope)}/model-providers")

    def usage(self, *, days=None):
        """Token usage and cost per UTC day and model over the last `days` (1 to 365, default 30): {"since", "totals",
        "days": [{"day", "model", "kind", "responses", "input", "output", "cacheRead", "cacheWrite", "cost", ...}]}.
        Per user or per key scope: the usage.recorded webhook."""
        return self._rest("GET", "/v1/usage" + (f"?days={int(days)}" if days is not None else ""))

    # API tokens: the tenant's keys to this API. A token's secret is returned only when it is made.
    def tokens(self):
        """The tenant's API tokens ({"id", "name", "prefix", "createdAt"}), never their secrets."""
        return self._rest("GET", "/v1/tokens")

    def create_token(self, name):
        """A new API token: {"id", "name", "prefix", "createdAt", "token"}, its secret `token` shown only now."""
        return self._rest("POST", "/v1/tokens", {"name": name}, retry=False)

    def revoke_token(self, token_id):
        """Revoke a token at once (not the one making the call). Returns {"revoked", "left"}: the webhooks and trace export
        it set, which keep sending; review them."""
        return self._rest("DELETE", f"/v1/tokens/{_path(token_id)}", retry=False)

    # Webhook endpoints: the runtime POSTs the events they select, signed (verify them with verify_webhook).
    def create_webhook(self, url, events, *, description=None):
        """Send `events` (["run.completed", "run.failed", "input.requested", ...]) to `url`, an https URL. Returns the
        endpoint with its signing `secret` (whsec_...), shown only now."""
        return self._rest("POST", "/v1/webhooks", {"url": url, "events": events, **({"description": description} if description is not None else {})}, retry=False)

    def webhooks(self):
        return self._rest("GET", "/v1/webhooks")

    def webhook(self, webhook_id):
        return self._rest("GET", f"/v1/webhooks/{_path(webhook_id)}")

    def update_webhook(self, webhook_id, *, url=None, events=None, description=None):
        """Change what is given; the rest stays."""
        body = {key: value for key, value in {"url": url, "events": events, "description": description}.items() if value is not None}
        return self._rest("PATCH", f"/v1/webhooks/{_path(webhook_id)}", body, retry=False)

    def delete_webhook(self, webhook_id):
        return self._rest("DELETE", f"/v1/webhooks/{_path(webhook_id)}", retry=False)

    def rotate_webhook_secret(self, webhook_id):
        """A new signing secret ({"secret"}), shown only now; the old one also signs for 24 hours."""
        return self._rest("POST", f"/v1/webhooks/{_path(webhook_id)}/secret", retry=False)

    def _operator(self):
        if not self.api_key:
            raise AgentError("No API key: set CAMELAI_API_KEY (or pass api_key). Create one at https://run.camelai.com/console/tokens")
        return self.api_key


def _provider_body(base_url, models, type, api_key, headers, auth):
    return {"type": type, "baseUrl": base_url, "models": models, **({"auth": auth} if auth else {}),
            **({} if api_key is _DEFAULT else {"apiKey": api_key}), **({} if headers is _DEFAULT else {"headers": headers})}


class AgentRuntime(_RuntimeCalls):
    """The lower-level client: provision agents, definitions, volumes and mounts. `url` defaults to CAMELAI_BASE_URL,
    else https://run.camelai.com; `api_key` to CAMELAI_API_KEY."""

    def __init__(self, url=None, api_key=None):
        self.base = _origin(url or _env("CAMELAI_BASE_URL", "AGENT_URL") or DEFAULT_URL)
        self.api_key = api_key or _env("CAMELAI_API_KEY", "AGENT_RUNTIME_TOKEN")
        self.http = httpx.AsyncClient(timeout=10, follow_redirects=False)
        self.agents = []
        # The tenant's OpenTelemetry trace export: get, set, clear, test.
        self.telemetry = Telemetry(self)
        # Speech to text on its own: create.
        self.transcriptions = Transcriptions(self)

    async def _form(self, path, fields, file):
        """A multipart POST with the API key (a transcription's audio), not retried: its answer."""
        response = await self.http.post(self.base + path, data=fields, files=[file], headers={"Authorization": f"Bearer {self._operator()}"}, timeout=_TRANSCRIPTION_TIMEOUT)
        if not response.is_success:
            raise AgentError(_error(response), response.status_code)
        return response.json()

    async def _rest(self, method, path, body=None, *, retry=True, headers=None, timeout=None, then=None, missing=_DEFAULT):
        """One request with the API key: its answer (`then` of it), or `missing` for a 404 when given."""
        try:
            value = await _http(self.http, self.base, path, self._operator(), method, body, retry, headers, timeout)
        except AgentError as error:
            if missing is not _DEFAULT and error.status == 404:
                return missing
            raise
        return then(value) if then else value

    async def create_agent(self, *, tools, system_prompt=None, name=None, type=None, model=None, thinking_level=None, mounts=None, idempotency_key=None, on_event=None, on_error=None, ttl_seconds=_DEFAULT, definition=None, subject=None, context=None, key_scope=None, spend_limit=None, run_limits=None, model_headers=None, on_input=None, builtins=None, delegate=None, subagents=False, prompt=None, traceparent=None, initial_messages=None, import_messages=None, max_output_tokens=None, temperature=None, mcp_servers=None, idle_ttl_seconds=None):
        """Provision an agent. `model` is "provider/model-id", e.g. "anthropic/claude-sonnet-5-5".
        `definition` makes it from a definition (GET /v1/definitions), which supplies the model, system prompt,
        thinking level and tool sources; `tools` are added as the agent's attached MCP server.
        `ttl_seconds` is the agent's lifetime, or None to keep it until it is deleted (default: until deleted with an
        idempotency_key of yours, else one day). `idle_ttl_seconds`, instead, makes it live that long from its latest
        run, so one in use is kept and one left idle expires.
        `mounts` (Mount and WorkspaceMount dicts) are the volumes its file tools see, beside its own workspace volume
        at /workspace unless they leave it out ({"workspace": False}) or place it ({"workspace": True, "path"?}). `key_scope` names a key scope
        (PUT /v1/key-scopes/:scope/providers/:provider) whose keys its model calls use first; `spend_limit` ({"usd": n}) the most it may spend on model calls from now on; `run_limits`
        ({"maxResponses": n, "maxSeconds": n}) the most one run may take, within the runtime's maximums (1,000 responses and
        2 hours by default), past which a run stops with stopped "turn_limit"; `model_headers` non-secret headers for each model call.
        `prompt` (the prompt call's body) is sent once the agent is made; `traceparent` (a W3C trace context) makes its run continue that trace.
        `initial_messages` is the history it begins with: Pi user, assistant, toolResult and compactionSummary messages (dicts),
        a conversation from elsewhere (see the multi-user guide).
        `mcp_servers` ([{"name", "url", "auth"?: {"type": "runtime"}, ...}]) are remote MCP servers of its own, without a
        definition: no credentials, only the runtime's identity tokens or none (a server that needs a token or headers goes in a definition)."""
        if not self.api_key:
            raise AgentError("No API key: set CAMELAI_API_KEY (or pass api_key). Create one at https://run.camelai.com/console/tokens")
        # subject: who the agent acts for; context: claims for its tool servers' identity tokens. Set only here.
        body = _provisioning(tools, definition=definition, name=name, type=type, system_prompt=system_prompt, model=model, thinking_level=thinking_level,
                             mounts=mounts, subject=subject, context=context, key_scope=key_scope, spend_limit=spend_limit, run_limits=run_limits, model_headers=model_headers, builtins=builtins,
                             delegate=delegate, prompt=prompt, initial_messages=initial_messages, import_messages=import_messages, max_output_tokens=max_output_tokens, temperature=temperature, mcp_servers=mcp_servers)
        # A key of the caller's makes the agent durable (it lives until deleted); one the SDK makes up, only so a retried
        # create finds the same agent, keeps a scratch agent's day, said explicitly since any key would make it durable.
        if idle_ttl_seconds is not None:
            body["idleTtlSeconds"] = idle_ttl_seconds
        if ttl_seconds is not _DEFAULT:
            body["ttlSeconds"] = ttl_seconds
        elif idempotency_key is None and idle_ttl_seconds is None:
            body["ttlSeconds"] = 86400
        session = await _http(self.http, self.base, "/v1/agents", self.api_key, "POST", body,
                              headers={"Idempotency-Key": idempotency_key or str(uuid.uuid4()), **_trace_header(traceparent)})
        return await self.connect_agent(session, tools=tools, on_event=on_event, on_error=on_error, on_input=on_input, subagents=subagents)

    async def connect_agent(self, session, *, tools, on_event=None, on_error=None, on_input=None, attach=True, takeover=False, sync_tools=True, subagents=False, connection="eager"):
        """`on_event(event, request_id)` hears every event, for display (a run's result is the truth): a plain or async
        function, called in order apart from the connection, so a slow one never holds up tool calls; what it raises goes
        to on_error. `on_input(input)` hears each question, approval or setup step the agent's turn now waits on: return an
        answer ({"action", "content"?, "from"?, "actor"?}) to give it at once, or None to answer later with answer().
        `attach=False` follows the agent and runs it without answering its tool calls, as any number of processes may; one
        process at a time answers them, and another fails with APPLICATION_CONNECTED unless `takeover=True` replaces it.
        `subagents=True` also delivers the agent's sub-agents' progress: subagent_start, subagent_event and subagent_end.
        `connection` says when the client holds the agent's event stream: "eager" (the default here), from connect until
        close; "lazy", only while something listens (Agent.stream), so an idle client holds no connection, and requests
        settle by asking for their outcome (a long poll of up to 25 s at a time). A client that serves tools (attach), or
        has on_event or on_input, needs the stream throughout, so it is eager whatever this says."""
        agent = AgentClient(self.base, session, tools, on_event, on_error, on_input, attach=attach, takeover=takeover, sync_tools=sync_tools, subagents=subagents,
                            connection=connection)
        self.agents.append(agent)
        try:
            await agent.connect()
            return agent
        except BaseException:
            await agent.close()
            raise

    async def wait_for_run(self, run_id):
        """A stateless run once it ends, however long it takes (cancel the task to stop waiting; abort_run stops the run)."""
        while True:
            run = await self.get_run(run_id, wait=25)
            if run["status"] != "running":
                return run

    async def run_events(self, run_id, *, last_event_id=None):
        """A run's event stream, to its end (its "response" frame), as {"id", "data"}: reconnecting with Last-Event-ID
        where the connection drops, so no event is missed or repeated where the stream still has them."""
        cursor, failures = last_event_id or 0, 0
        while True:
            headers = {"Authorization": f"Bearer {self._operator()}", "Accept": "text/event-stream", **({"Last-Event-ID": str(cursor)} if cursor else {})}
            try:
                async with self.http.stream("GET", f"{self.base}/v1/runs/{quote(run_id, safe='')}/events", headers=headers, timeout=httpx.Timeout(10, read=60)) as response:
                    if not response.is_success:
                        await response.aread()
                        error = AgentError(_error(response), response.status_code, retry_after=_retry_after(response))
                        if response.status_code not in (502, 503) or failures >= 5:
                            raise error
                        failures += 1
                        await asyncio.sleep(error.retry_after or 0.25 * 2 ** failures)
                        continue
                    failures, buffer = 0, ""
                    async for chunk in response.aiter_text():
                        frames, buffer = _sse_frames(buffer + chunk)
                        for lines, text in frames:
                            frame = _run_frame(lines, text)
                            if frame is None:
                                continue
                            cursor = frame["id"]
                            yield frame
                            if frame["data"].get("type") == "response":
                                return
            except httpx.TransportError:
                failures += 1
                if failures > 5:
                    raise
                await asyncio.sleep(0.25 * 2 ** failures)

    def volume(self, volume_id):
        """A handle on one volume's files, snapshots and forks."""
        return Volume(self, volume_id)

    async def close(self, *, drain=None):
        """Close every agent's connection, each finishing its tool calls first (AgentClient.close)."""
        await asyncio.gather(*(agent.close(drain=drain) for agent in self.agents))
        await self.http.aclose()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        await self.close()


def _sse_frames(buffer):
    """The whole SSE frames at the start of `buffer`, each as (its lines, its data), and the text after them."""
    frames = []
    while "\n\n" in buffer:
        raw, buffer = buffer.split("\n\n", 1)
        lines = raw.split("\n")
        frames.append((lines, "\n".join(line[5:].lstrip() for line in lines if line.startswith("data:"))))
    return frames, buffer


def _run_frame(lines, text):
    """A stateless run's event frame, {"id", "data"}; None for the stream's own frames (ready, reconnect hints)."""
    ids = [line[3:].strip() for line in lines if line.startswith("id:")]
    if not text or "event: ready" in lines or not ids or not ids[0].isdigit():
        return None
    return {"id": int(ids[0]), "data": json.loads(text)}


def _steer_receipt(record):
    """A steered message as the runtime took it: taken (steeredInto names the turn), accepted, or queued as a turn of its own."""
    if record.get("steeredInto"):
        return {"id": record["id"], "status": "taken", "steeredInto": record["steeredInto"]}
    # A runtime from before steer receipts answers with the queued request alone: the running turn may still take it.
    return {"id": record["id"], "status": record.get("steer") or "accepted"}


def _trace_header(traceparent):
    """The W3C `traceparent` header, when there is one to send."""
    return {"traceparent": traceparent} if traceparent else {}


def _transcription_form(language=None, prompt=None, key_scope=None, subject=None, context=None, actor=None):
    """A transcription's fields, as the request names them, the ones given."""
    fields = {"language": language, "prompt": prompt, "keyScope": key_scope, "subject": subject, "context": context, "actor": actor}
    return {key: value for key, value in fields.items() if value is not None}


class Transcriptions:
    """Speech to text on its own (runtime.transcriptions, agents.transcriptions): audio in, its transcript out, nothing
    kept. Audio attached to a message needs none of this: it is transcribed for the model as it is attached. Its calls
    are awaited from AgentRuntime, and plain from the synchronous one."""

    def __init__(self, runtime):
        self._runtime = runtime

    def create(self, file=None, *, url=None, name=None, content_type=None, language=None, prompt=None, key_scope=None,
               subject=None, context=None, actor=None):
        """Transcribe audio: `file` (bytes, or a local path as str or Path) or `url` for the runtime to fetch (public
        addresses only). Ogg (Opus, Vorbis), WebM, MP3, M4A/MP4, WAV or FLAC; at most 25 MB and 30 minutes. `language`:
        ISO 639-1 ("en") or a locale ("pt-BR"), detected when left out; `prompt`: names or jargon to expect;
        `key_scope`: whose OpenAI key goes first;
        `subject`, `context` and `actor` are carried to its usage.recorded event. Returns {"text", "language",
        "durationSeconds", "model", "costUsd"}. Not retried: each attempt is billed."""
        fields = _transcription_form(language, prompt, key_scope, subject, context, actor)
        if (file is None) == (url is None):
            raise AgentError("Give the audio as file (bytes or a path) or url, one of them")
        if url is not None:
            return self._runtime._rest("POST", "/v1/transcriptions", {"url": url, **fields}, retry=False, timeout=_TRANSCRIPTION_TIMEOUT)
        if isinstance(file, (str, os.PathLike)):
            name, data = name or Path(file).name, Path(file).read_bytes()
        elif isinstance(file, (bytes, bytearray, memoryview)):
            data = bytes(file)
        else:
            raise AgentError("file is bytes or a local path")
        form = {key: json.dumps(value) if isinstance(value, dict) else str(value).lower() if isinstance(value, bool) else str(value) for key, value in fields.items()}
        return self._runtime._form("/v1/transcriptions", form, ("file", (name or "audio", data, content_type or "application/octet-stream")))


class Telemetry:
    """The tenant's OpenTelemetry trace export (runtime.telemetry): each run is a trace, with spans for its model and tool
    calls, POSTed to an OTLP/HTTP endpoint. Header values are stored encrypted and never returned: reads list their names.
    Its calls are awaited from AgentRuntime, and plain from the synchronous one."""

    def __init__(self, runtime):
        self._runtime = runtime

    def _call(self, method, path="/v1/telemetry", body=None, retry=True, missing=_DEFAULT):
        return self._runtime._rest(method, path, body, retry=retry, missing=missing)

    def get(self):
        """The settings ({"endpoint", "protocol", "sampleRate", "include", "headers": [names], "createdAt", "updatedAt",
        "status": {"lastExportAt", "lastError", "lastErrorAt"}}), or None when none are set."""
        return self._call("GET", missing=None)

    def set(self, endpoint=None, *, headers=None, protocol=None, sample_rate=None, include_content=None):
        """Export the tenant's runs to `endpoint` (the OTLP/HTTP traces URL; a collector's base URL gets /v1/traces). What is
        left out keeps its current value (its default the first time, when `endpoint` is needed).
        `headers` are sent with each export (a backend's API key); left out, the stored ones stay while the endpoint keeps
        its origin, and {} removes them. `protocol` is "http/protobuf" (default) or "http/json"; `sample_rate` the share of
        runs traced, 0 to 1 (default 1); `include_content=True` exports prompts, replies, tool arguments and results."""
        body = {**({"endpoint": endpoint} if endpoint is not None else {}), **({"headers": headers} if headers is not None else {}), **({"protocol": protocol} if protocol else {}),
                **({"sampleRate": sample_rate} if sample_rate is not None else {}), **({"include": {"content": include_content}} if include_content is not None else {})}
        return self._call("PUT", body=body)

    def clear(self):
        """Stop exporting: {"deleted": True}, or {"deleted": False} when nothing was set."""
        return self._call("DELETE", retry=False, missing={"deleted": False})

    def test(self):
        """Send one test span now: {"ok", "status"?, "error"?, "traceId", "spanId"}; look the traceId up in your backend."""
        return self._call("POST", "/v1/telemetry/test", retry=False)


def _provisioning(tools, *, definition=None, name=None, type=None, system_prompt=None, model=None, thinking_level=None, mounts=None, remount=None,
                  subject=None, context=None, key_scope=None, spend_limit=None, run_limits=None, model_headers=None, system_prompt_append=None, file_tools=None, builtins=None,
                  delegate=None, prompt=None, code_mode=None, initial_messages=None, import_messages=None, max_output_tokens=None, temperature=None, mcp_servers=None):
    """A create request's body: the tools as the attached MCP server's tools/list, and the fields given."""
    optional = {"definition": definition, "name": name, "type": type, "systemPrompt": system_prompt, "model": model, "thinkingLevel": thinking_level,
                "mounts": mounts, "remount": remount, "subject": subject, "context": context, "keyScope": key_scope, "spendLimit": spend_limit, "runLimits": run_limits, "modelHeaders": model_headers,
                "systemPromptAppend": system_prompt_append, "fileTools": file_tools, "codeMode": code_mode, "builtins": builtins, "delegate": delegate, "mcpServers": mcp_servers, "prompt": prompt,
                "initialMessages": initial_messages, "importMessages": import_messages, "maxOutputTokens": max_output_tokens, "temperature": temperature}
    return _with_multi_agent({"mcp": {"tools": [item.mcp_tool() for item in tools]}, **{key: value for key, value in optional.items() if value is not None}})


def _definition_fields(fields):
    """A definition's fields by their REST names, or the Python spelling of them (run_limits=, system_prompt=...)."""
    return {re.sub(r"_([a-z])", lambda match: match.group(1).upper(), key): value for key, value in fields.items()}


def _with_multi_agent(fields):
    """`delegate` settings bring their builtin: given the settings, the builtin is added."""
    fields = _definition_fields(fields)
    builtins = fields.get("builtins") or []
    return {**fields, "builtins": [*builtins, "delegate"]} if fields.get("delegate") and "delegate" not in builtins else fields


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

    async def _raw(self, method, path, content=None, headers=None, query=None):
        response = await _transfer(self.runtime.http, method, self._file(path) + (f"?{urlencode(query)}" if query else ""), content=content, headers={
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

    async def snapshot(self, *, name=None, pinned=None, labels=None, files=None):
        """A snapshot of the volume, or with `files` (path to str or bytes) a snapshot of those files instead, the volume
        untouched (at most 1,000 files and 16 MiB). `pinned` keeps it until unpinned; `labels` are your own."""
        body = {key: value for key, value in {"name": name, "pinned": pinned, "labels": labels}.items() if value is not None}
        if files is not None:
            body["files"] = {path: content if isinstance(content, str) else {"data": base64.b64encode(bytes(content)).decode()} for path, content in files.items()}
        return await self._json("/snapshots", "POST", body)

    async def snapshots(self, *, labels=None):
        """Oldest first; with `labels`, only those that have every one."""
        query = urlencode([("label", f"{key}:{value}") for key, value in (labels or {}).items()])
        return await self._json(f"/snapshots{'?' + query if query else ''}")

    async def update_snapshot(self, snapshot_id, *, pinned=None, labels=None):
        """Pin or unpin a snapshot, or replace its labels."""
        return await self._json(f"/snapshots/{quote(snapshot_id)}", "PATCH", {key: value for key, value in {"pinned": pinned, "labels": labels}.items() if value is not None})

    async def delete_snapshot(self, snapshot_id, *, force=False):
        """A pinned snapshot is kept (409) unless `force`."""
        return await self._json(f"/snapshots/{quote(snapshot_id)}{'?force=true' if force else ''}", "DELETE")

    async def archive(self, *, snapshot=None, path=None, glob=None):
        """The files as tar.gz bytes: as the volume is (or as `snapshot` has them), under `path` (names relative to it)
        and matching `glob`. At most 10,000 files and 1 GiB."""
        query = {key: value for key, value in {"snapshot": snapshot, "path": path, "glob": glob}.items() if value is not None}
        response = await _transfer(self.runtime.http, "GET", f"{self.runtime.base}/v1/volumes/{self.id}/archive" + (f"?{urlencode(query)}" if query else ""),
                                   headers={"Authorization": f"Bearer {self.runtime._operator()}"})
        if not response.is_success:
            raise AgentError(_error(response), response.status_code)
        return response.content

    async def restore(self, snapshot):
        """Make this volume as a snapshot of it was, in place: files the snapshot lacks are removed and files that differ
        are written back, each a change agents mounting it see. {"snapshot", "seq", "written", "removed"}."""
        return await self._json("/restore", "POST", {"snapshot": snapshot})

    async def fork(self, *, name=None, snapshot=None):
        """A new volume with this one's files (or a snapshot's); only metadata is copied."""
        return await self._json("/fork", "POST", {key: value for key, value in {"name": name, "snapshot": snapshot}.items() if value is not None})

    async def changes(self, since=0, *, prefix=None):
        """Changes after `since` (a seq), oldest first; `prefix` keeps those at or under a path."""
        return await self._json(f"/changes?since={int(since)}" + (f"&{urlencode({'prefix': prefix})}" if prefix else ""))

    async def list(self, *, prefix=None, glob=None, after=None, limit=None, snapshot=None):
        """Files under `prefix`, a page at a time; `snapshot` lists a snapshot instead."""
        query = urlencode({key: value for key, value in {"prefix": prefix, "glob": glob, "after": after, "limit": limit, "snapshot": snapshot}.items() if value is not None})
        return await self._json(f"/files{'?' + query if query else ''}")

    async def read_all(self, *, prefix=None, glob=None, snapshot=None):
        """Every file under `prefix` (and `glob`) with its contents, in one request, as the volume was at one seq (or as
        `snapshot` has them): {"seq", "snapshot"?, "files": [{"path", "size", "version", "contentType", "sha256", "text" | "data"}]},
        text as "text", other bytes base64 as "data". At most 1,000 files and 16 MiB (else a 413)."""
        query = urlencode({key: value for key, value in {"content": "true", "prefix": prefix, "glob": glob, "snapshot": snapshot}.items() if value is not None})
        return await self._json(f"/files?{query}")

    async def write(self, path, data, *, version=None, content_type=None):
        """Without content_type, the runtime sniffs it from the file's first bytes and name."""
        headers = {"Content-Type": content_type or "application/octet-stream"}
        if version == 0:
            headers["If-None-Match"] = "*"
        elif version is not None:
            headers["If-Match"] = f'"{version}"'
        response = await self._raw("PUT", path, data.encode() if isinstance(data, str) else data, headers)
        return response.json()

    async def read(self, path, *, range=None, snapshot=None):
        """Returns (bytes, version); `range` is (start, end) in bytes, end exclusive; `snapshot` reads it as a snapshot has it."""
        headers = {"Range": f"bytes={range[0]}-{'' if len(range) < 2 or range[1] is None else range[1] - 1}"} if range else None
        response = await self._raw("GET", path, headers=headers, **({"query": {"snapshot": snapshot}} if snapshot else {}))
        return response.content, int(response.headers["x-file-version"])

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


@dataclass
class Download:
    """A downloaded file: its bytes, content type and version."""
    data: bytes
    content_type: str
    version: int


def _download(response):
    return Download(response.content, response.headers.get("content-type", "application/octet-stream").split(";")[0].strip(), int(response.headers["x-file-version"]))


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

    def list(self, *, path=None, glob=None, after=None, limit=None):
        """Files under path (default: the first mount), in path order, a page at a time: {"files", "next"?}."""
        query = urlencode({key: value for key, value in {"path": path, "glob": glob, "after": after, "limit": limit}.items() if value is not None})
        return self.agent._http(f"/files{'?' + query if query else ''}")

    async def download(self, path):
        """The file: .data (bytes), .content_type and .version."""
        return _download(await self._raw("GET", path))

    async def upload(self, path, data, *, content_type=None):
        """Write a file into a writable mount; without content_type the runtime sniffs it."""
        body = data.encode() if isinstance(data, str) else data
        return (await self._raw("PUT", path, content=body, headers={"Content-Type": content_type} if content_type else {}, timeout=_UPLOAD_TIMEOUT)).json()

    def link(self, path, *, method="GET", expires_in=None, max_bytes=None, content_type=None):
        """A signed URL to download (GET) or upload (PUT) one file without a token: {"url", "expiresAt", ...}."""
        body = {"path": path, "method": method, **{key: value for key, value in {"expiresIn": expires_in, "maxBytes": max_bytes, "contentType": content_type}.items() if value is not None}}
        return self.agent._http("/links", "POST", body, retry=False)


def _message_params(text, attached, extra, from_, metadata):
    """A message request's params: its text, attached files, `extra` (a prompt's options), sender and metadata."""
    return {"text": text, **({"files": attached} if attached else {}), **(extra or {}), **({"from": from_} if from_ else {}), **({"metadata": metadata} if metadata else {})}


def _prompt_extra(actor=None, while_running=None, allow_disconnected=False, spend_limit=None, output=None, history=None, run_limits=None):
    return {**({"actor": actor} if actor else {}), **({"whileRunning": "steer"} if while_running == "steer" else {}),
            **({"allowDisconnected": True} if allow_disconnected else {}), **({"spendLimit": spend_limit} if spend_limit is not None else {}),
            **({"runLimits": run_limits} if run_limits is not None else {}),
            **({"output": output} if output is not None else {}), **({"history": "none"} if history == "none" else {})}


def _check_request_id(request_id):
    import re
    if not re.fullmatch(_KEY, request_id):
        raise AgentError(f"An idempotency key is 1 to 80 letters, digits, _ and -: {request_id!r} is not", 400)


def _attachment(index, file):
    """A file to attach as (name, data, content_type, extra), or as the message sends it: {"path"} for one in the agent's
    mounts, {"url"} for the runtime to fetch. `extra` is its "transcribe" choice, if it makes one."""
    extra = {"transcribe": file["transcribe"]} if isinstance(file, dict) and isinstance(file.get("transcribe"), bool) else {}
    if isinstance(file, dict) and set(file) - {"transcribe"} == {"path"}:
        return {"path": file["path"], **extra}
    if isinstance(file, dict) and isinstance(file.get("url"), str) and set(file) <= {"url", "name", "content_type", "transcribe"}:
        return {"url": file["url"], **({"name": file["name"]} if file.get("name") else {}), **({"contentType": file["content_type"]} if file.get("content_type") else {}), **extra}
    if isinstance(file, (str, os.PathLike)):
        return Path(file).name, Path(file), None, extra
    if isinstance(file, (bytes, bytearray, memoryview)):
        return None, bytes(file), None, extra
    if isinstance(file, dict) and isinstance(file.get("data"), (bytes, bytearray)):
        return file.get("name"), bytes(file["data"]), file.get("content_type"), extra
    raise AgentError("A file is bytes, a local path, {\"name\", \"data\", \"content_type\"?}, {\"path\"} in the agent's mounts or {\"url\"}, each with \"transcribe\"?")


def _unique_name(names, name, index):
    """Each file in a request needs its own name: they share uploads/<request>/."""
    base = name or f"attachment-{index + 1}"
    unique, n = base, 2
    while unique in names:
        stem, dot, extension = base.rpartition(".")
        unique = f"{stem}-{n}.{extension}" if dot and stem else f"{base}-{n}"
        n += 1
    names.add(unique)
    return unique


class _AgentCalls:
    """An agent's calls that are one request each, with its own token, shared by the async AgentClient and the
    synchronous one (camelai_run.sync): each returns what self._http (or self.request) returns."""

    def history(self):
        """The agent's whole history: {"messages"}. history_page reads a page at a time."""
        return self._http("/history")

    def history_page(self, *, before=None, limit=50):
        """The page of whole turns ending before `before` (default: the newest message), with at least `limit`
        messages where there are that many: {"entries": [{"index", "message"}], "next", "total"}."""
        return self._http("/history?" + urlencode({"limit": limit, **({"before": before} if before is not None else {})}))

    def execute(self, code, *, execution_timeout_ms=None, actor=None, allow_disconnected=False, **options):
        params = {"code": code, **({"actor": actor} if actor else {}), **({"allowDisconnected": True} if allow_disconnected else {})}
        if execution_timeout_ms is not None:
            params["timeoutMs"] = execution_timeout_ms
        return self.request("execute", params, **options)

    def set_metadata(self, *, name, type):
        return self._http("/metadata", "POST", {"name": name, "type": type})

    def schedule(self, *, text=None, code=None, at=None, in_seconds=None, every_seconds=None):
        """Wake this agent later with a prompt (text) or sandboxed code; every_seconds (>= 60) repeats it."""
        body = {key: value for key, value in {"text": text, "code": code, "at": at, "inSeconds": in_seconds, "everySeconds": every_seconds}.items() if value is not None}
        return self._http("/schedules", "POST", body, retry=False)

    def schedules(self):
        return self._http("/schedules")

    def unschedule(self, schedule_id):
        return self._http(f"/schedules/{quote(schedule_id, safe='')}", "DELETE", None, retry=False)

    def status(self):
        """The agent's process (when loaded) and whether it is busy: busy, activeRun, queuedRuns, as GET /v1/agents/{id} and its state say too."""
        return self.request("status")

    def abort(self, *, queued=None):
        """Stop the agent: its running turn ends (code "aborted"), and the runs queued behind it are cancelled (code
        "cancelled"), so nothing runs after the stop; queued="keep" stops the running turn only. Returns
        {"aborted", "cancelled": [ids]}."""
        return self.request("abort", {"queued": queued} if queued else {})

    def outcomes(self):
        return self._http("/state")

    def answer(self, input_id, *, action, content=None, actor=None, **sender):
        """Answer an input the agent waits on: action is accept, decline or cancel. `content`: for a question,
        {"answers": {"<question>": "<label>" | ["<label>"] | "<own words>"}}; for a form, its fields. `from` (as
        from_) or `actor` names who answers, checked against who may. Returns {input, request}: request is the
        run resuming the turn once its last input is answered."""
        who = sender.get("from_") or sender.get("from")
        body = {"action": action, **({"content": content} if content is not None else {}), **({"actor": actor} if actor else {}), **({"from": who} if who else {})}
        return self._http(f"/inputs/{quote(input_id, safe='')}", "POST", body)

    def inputs(self, *, state=None):
        """The agent's inputs, newest first: state="pending", say."""
        return self._http("/inputs" + (f"?state={state}" if state else ""))

    def request_status(self, request_id, *, wait=None):
        """A request's record. wait (seconds, at most 25): while it runs, answer once it settles, or when the wait
        ends with it still running: one call that waits, with no stream connected."""
        path = f"/requests/{quote(request_id, safe='')}"
        if not wait:
            return self._http(path)
        return self._http(f"{path}?wait={wait}", timeout=min(wait, 25) + 10)


class AgentClient(_AgentCalls):
    # How often a request still waiting for its result asks for its status, in case the result's event was lost.
    poll_interval = 30

    def __init__(self, base, session, tools, on_event=None, on_error=None, on_input=None, attach=True, takeover=False, sync_tools=True, subagents=False, connection="eager"):
        import re
        if not re.fullmatch(r"client_[a-f0-9]{40}", session["id"]):
            raise ValueError("Invalid session id")
        self.base = _origin(base)
        # The agent's id (client_...): safe to log and to store.
        self.id = session["id"]
        # Its id and token: keep the token secret (it is left out of repr).
        self.session = _Session({key: session.get(key) for key in ("id", "token", "expiresAt")})
        self.tools = {item.name: item for item in tools}
        self.on_event, self.on_error, self.on_input = on_event, on_error, on_input
        # Whether this client answers the agent's tool calls: one process at a time. False follows it only.
        self.attach = attach
        # Replace the process that serves the agent's tools now, instead of failing with APPLICATION_CONNECTED.
        self.takeover = takeover
        # Declare this client's tools as it connects when they differ from the agent's (a process restarted with changed tools).
        self.sync_tools = sync_tools
        # Also receive the agent's sub-agents' events (subagent_start, subagent_event, subagent_end).
        self.subagents = subagents
        self.http = httpx.AsyncClient(timeout=10, follow_redirects=False)
        self.path = f"/clients/{session['id']}"
        # The last event taken from the stream: a reconnect resumes after it (a new client starts from a snapshot).
        self.cursor = 0
        # Tool calls running, by JSON-RPC id, so the runtime can cancel them.
        self.pending, self.active = {}, {}
        # How many calls wait on each pending request's future: the same key sent again joins the first.
        self.waiting = {}
        # The event stream's connection, named in the MCP messages this client sends back.
        self.connection = None
        self.ready = asyncio.Event()
        self.runner = None
        self.closed = False
        # close() in progress: it answers the tool calls it has, then disconnects.
        self.closing = None
        self.fatal = None
        # on_event's queue, and its dispatcher: events wait here, in order, so the stream never waits on the application.
        self.events = None
        self.dispatcher = None
        self.dropped = 0
        self.listeners = set()
        # Holds the event stream only while something listens (connection="lazy"); serving tools, on_event and on_input need it throughout.
        self.lazy = connection == "lazy" and not attach and not on_event and not on_input

    def __repr__(self):
        return f"AgentClient(id={self.id!r})"

    async def _http(self, suffix, method="GET", body=None, retry=True, timeout=None):
        return await _http(self.http, self.base, self.path + suffix, self.session["token"], method, body, retry, timeout=timeout)

    async def connect(self):
        if self.closed:
            raise AgentError("Client closed")
        if self.fatal:
            raise self.fatal
        # A lazy client connects only while something listens.
        if self.lazy and not self.listeners:
            return
        self._start()
        await asyncio.wait_for(self.ready.wait(), 10)
        if self.fatal:
            raise self.fatal

    def _start(self):
        """Start the event stream's loop, unless it runs."""
        if self.events is None:
            self.events = asyncio.Queue()
            self.dispatcher = asyncio.create_task(self._dispatch())
        if not self.runner or self.runner.done():
            self.runner = asyncio.create_task(self._events())

    def listen(self, listener):
        """Hear every event as it arrives (before on_event); returns the function that stops it. A lazy client connects
        for its first listener, and lets the stream go with its last."""
        self.listeners.add(listener)
        if self.lazy and not self.closed and not self.fatal:
            self._start()

        def unlisten():
            if listener not in self.listeners:
                return
            self.listeners.discard(listener)
            if self.lazy and not self.listeners and self.runner and not self.runner.done():
                self.runner.cancel()
                self.runner = None
                # The next connect starts afresh, from a snapshot, as a new client would.
                self.ready, self.connection, self.cursor = asyncio.Event(), None, 0
        return unlisten

    async def _sync_tools(self, declared):
        """Declare this client's tools when they differ from what the agent has (its toolsHash, over the JSON the runtime keeps)."""
        tools = [item.mcp_tool() for item in self.tools.values()]
        import hashlib
        if hashlib.sha256(json.dumps(tools, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest() != declared:
            await self.request("configure", {"mcp": {"tools": tools}})

    def _report(self, error):
        if self.on_error:
            try:
                self.on_error(error)
            except Exception:
                pass

    def _emit(self, event, request_id=None):
        """Hand an event to the listeners, and queue it for on_event: the stream goes on without waiting for either."""
        for listener in list(self.listeners):
            try:
                listener(event, request_id)
            except Exception as error:
                self._report(error)
        if not self.on_event or self.events is None or self.closed:
            return
        if self.events.qsize() >= _MAX_QUEUED_EVENTS and event.get("type") == "message_update":
            if self.dropped == 0:
                self._report(AgentError(f"on_event is falling behind: over {_MAX_QUEUED_EVENTS} events wait, so streamed deltas are dropped until it catches up"))
            self.dropped += 1
            return
        self.events.put_nowait((event, request_id))

    async def _dispatch(self):
        """Call on_event for each queued event, in order: a plain or an async function; what it raises goes to on_error."""
        while True:
            event, request_id = await self.events.get()
            try:
                # A closed client calls on_event no more: events still queued are dropped.
                if self.closed:
                    continue
                answer = self.on_event(event, request_id) if _arity(self.on_event) > 1 else self.on_event(event)
                if inspect.isawaitable(answer):
                    await answer
            except asyncio.CancelledError:
                raise
            except Exception as error:
                self._report(error)
            finally:
                self.events.task_done()
                if self.events.empty():
                    self.dropped = 0

    async def _events(self):
        backoff = 0.25
        while not self.closed and (not self.lazy or self.listeners):
            # The runtime closed the stream on purpose (its node is leaving, or the agent moved): reconnect at once.
            hinted = False
            try:
                # One application serves an agent's tools at a time: a reconnect names the connection it held; takeover replaces another's, once.
                mode = ("&watch=1" if not self.attach else "&takeover=true" if self.takeover and not self.connection else "") + ("&subagents=1" if self.subagents else "")
                async with self.http.stream("GET", self.base + self.path + "/events?snapshot=1" + mode, headers={
                    "Authorization": f"Bearer {self.session['token']}", "Accept": "text/event-stream", "Last-Event-ID": str(self.cursor),
                    **({"X-Agent-Connection": self.connection} if self.attach and self.connection else {})}, timeout=20) as response:
                    if response.status_code == 409:
                        try:
                            refusal = json.loads(await response.aread())
                        except ValueError:
                            refusal = {}
                        if _code(refusal if isinstance(refusal, dict) else {}) == "APPLICATION_CONNECTED":
                            raise AgentError("Another process serves this agent's tools. One process at a time answers an agent's tool calls: close that one, "
                                             "pass takeover=True to replace it, or attach=False to run the agent without serving its tools", 409, code="APPLICATION_CONNECTED")
                        state = await self._sync()
                        self.cursor = state["cursor"]
                        self._emit({"type": "replay_gap", "cursor": state["cursor"]})
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
                            # Another process took over this agent's tools: this one stops, rather than take them back.
                            if "event: closed" in lines:
                                raise AgentError("Another process took over this agent's tools (takeover): this client no longer serves them, and follows the agent without them",
                                                 409, code="APPLICATION_REPLACED")
                            if "event: ready" in lines:
                                ready = json.loads(data)
                                self.connection = ready.get("connection")
                                # Tools that differ from those the agent was last given: declare these, between its turns.
                                if self.attach and self.sync_tools and ready.get("toolsHash"):
                                    self._track(asyncio.ensure_future(self._sync_tools(ready["toolsHash"])))
                                await self._sync()
                                backoff = 0.25
                                self.ready.set()
                                continue
                            if "event: reconnect" in lines:
                                hinted = True
                                continue
                            id_line = next((line for line in lines if line.startswith("id:")), None)
                            # The runtime's MCP messages are live only: no id, never replayed, no cursor.
                            if id_line is None:
                                event = json.loads(data)
                                if event.get("type") == "mcp":
                                    self._track(asyncio.create_task(self._mcp(event["message"])))
                                continue
                            cursor = int(id_line[3:])
                            event = json.loads(data)
                            # A snapshot of the running turn restarts the stream at its cursor, even one below
                            # the last (a restarted host).
                            if event.get("type") == "snapshot":
                                self.cursor = cursor
                                self._emit(event)
                                continue
                            if cursor <= self.cursor:
                                continue
                            self._receive(event)
                            self.cursor = cursor
                        if len(buffer) > 1_100_000:
                            raise AgentError("SSE frame too large")
            except asyncio.CancelledError:
                raise
            except Exception as error:
                # Another process serves the tools now (it took over, or took them while this one was away): this one goes on
                # following the agent, and running it, without serving them, so its requests still settle.
                if isinstance(error, AgentError) and (error.code == "APPLICATION_REPLACED" or (error.code == "APPLICATION_CONNECTED" and self.connection)):
                    self.attach = False
                    self._report(error)
                elif isinstance(error, AgentError) and (error.status in (401, 403, 410) or error.code == "APPLICATION_CONNECTED"):
                    self.fatal = error
                    self.ready.set()
                    for future in self.pending.values():
                        if not future.done():
                            future.set_exception(error)
                    self._report(error)
                    return
                elif not self.closed:
                    self._report(error)
            if not self.closed:
                await asyncio.sleep(0 if hinted else backoff)
                if not hinted:
                    backoff = min(5, backoff * 2)

    def _receive(self, event):
        if event["type"] == "response":
            self._settle(event["id"], event["outcome"])
        elif event["type"] == "event":
            self._emit(event["event"], event.get("requestId"))
            if self.on_input and event["event"].get("type") == "input_required":
                self._track(asyncio.ensure_future(self._input(event["event"]["input"])))

    async def _input(self, input):
        answer = self.on_input(input)
        if inspect.isawaitable(answer):
            answer = await answer
        if answer:
            await self.answer(input["id"], **answer)

    def _settle(self, request_id, value):
        future = self.pending.pop(request_id, None)
        if future and not future.done():
            if "error" in value:
                future.set_exception(AgentError(value["error"], request_id=request_id, code=value.get("code") if isinstance(value.get("code"), str) else None,
                                                uncertain=bool(value.get("uncertain"))))
            else:
                future.set_result(value.get("result"))

    async def _outcome(self, request_id, future):
        """A request's result arrives as an event; a reconnect also settles from /state. As a last resort,
        ask for its status now and then, so an event lost on the way can never strand the caller."""
        if self.lazy:
            return await self._polled(request_id, future)
        while not (await asyncio.wait({future}, timeout=self.poll_interval))[0]:
            try:
                record = await self.request_status(request_id)
            except Exception:
                continue
            if "outcome" in record:
                self._settle(request_id, record["outcome"])
        return future.result()

    async def _polled(self, request_id, future):
        """A lazy client's way to a request's outcome: ask for it, waiting up to 25 s each time, until it settles. While
        something listens, the outcome comes as an event after the run's others (asking could settle it before its last
        events arrive), so then it asks only every poll_interval, as an eager client does. A refusal for good (the token
        revoked, the agent gone) fails the request."""
        backoff = 0.25
        while not future.done():
            streaming = self.runner is not None and not self.runner.done()
            if streaming and (await asyncio.wait({future}, timeout=self.poll_interval))[0]:
                break
            poll = asyncio.ensure_future(self.request_status(request_id, wait=None if streaming else 25))
            try:
                await asyncio.wait({future, poll}, return_when=asyncio.FIRST_COMPLETED)
            finally:
                if not poll.done():
                    poll.cancel()
                    await asyncio.gather(poll, return_exceptions=True)
            if future.done():
                break
            try:
                record = poll.result()
            except AgentError as error:
                if error.status in (401, 403, 404, 410):
                    raise
                await asyncio.sleep(backoff)
                backoff = min(5, backoff * 2)
                continue
            except Exception:
                await asyncio.sleep(backoff)
                backoff = min(5, backoff * 2)
                continue
            backoff = 0.25
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

        loop = asyncio.get_running_loop()

        def notify(notification):
            # A plain function tool reports from its thread: the send is made on the connection's loop.
            send = lambda: self._track(asyncio.ensure_future(_http(self.http, self.base, self.path + "/mcp", self.session["token"], "POST", notification,
                                                                   retry=False, headers={"X-Agent-Connection": connection or ""})))
            try:
                here = asyncio.get_running_loop()
            except RuntimeError:
                here = None
            if here is loop:
                send()
            else:
                loop.call_soon_threadsafe(send)

        key = str(message["id"])
        if method == "tools/call":
            self.active[key] = asyncio.current_task()
        try:
            await reply(await _answer_mcp(message, self.tools, lambda meta: _tool_context(meta, key, notify=notify)))
        except asyncio.CancelledError:
            pass
        finally:
            self.active.pop(key, None)

    async def request(self, method, params=None, *, idempotency_key=None, timeout=None, traceparent=None):
        """Send a request and wait for its outcome, however long the run takes: `timeout` (seconds) only stops the
        wait, as cancelling the task does; the request goes on. `traceparent` (a W3C trace context, sent as the
        traceparent header) makes the run continue the caller's trace when the tenant exports telemetry."""
        if self.closed or self.closing or self.fatal:
            raise self.fatal or AgentError("Client closed")
        request_id = idempotency_key or str(uuid.uuid4())
        _check_request_id(request_id)
        # A lazy client that something listens to (Agent.stream) connects first, so the listener sees the run from its start.
        if self.lazy and self.listeners:
            await self.connect()
        future = self._waiter(request_id)
        try:
            record = await _http(self.http, self.base, self.path + "/requests", self.session["token"], "POST",
                                 {"id": request_id, "method": method, "params": params or {}}, headers=_trace_header(traceparent))
            if "outcome" in record:
                self._settle(request_id, record["outcome"])
            return await asyncio.wait_for(self._outcome(request_id, future), timeout)
        except TimeoutError as error:
            raise AgentError("Stopped waiting; the request may still be running: request_status() or wait_for_request() observe it", request_id=request_id) from error
        finally:
            self._release(request_id, future)

    def _waiter(self, request_id):
        """The future of request_id's outcome, shared by every call waiting on it; each stops waiting on its own."""
        future = self.pending.get(request_id)
        if future is None:
            if len(self.pending) >= _MAX_PENDING:
                raise AgentError("Too many outstanding requests", request_id=request_id)
            future = self.pending[request_id] = asyncio.get_running_loop().create_future()
        self.waiting[future] = self.waiting.get(future, 0) + 1
        return future

    def _release(self, request_id, future):
        self.waiting[future] -= 1
        if self.waiting[future]:
            return
        del self.waiting[future]
        if self.pending.get(request_id) is future:
            self.pending.pop(request_id, None)
        if future.done() and not future.cancelled():
            future.exception()  # An SSE error may arrive while POST fails.
        elif not future.done():
            future.cancel()

    async def wait_for_request(self, request_id, *, timeout=None):
        """Wait for a request already sent (by this process or another) to settle. This never submits or re-executes work."""
        if self.closed or self.fatal:
            raise self.fatal or AgentError("Client closed")
        future = self._waiter(request_id)
        try:
            record = await self.request_status(request_id)
            if "outcome" in record:
                self._settle(request_id, record["outcome"])
            return await asyncio.wait_for(self._outcome(request_id, future), timeout)
        except TimeoutError as error:
            raise AgentError("Stopped waiting; the request may still be running", request_id=request_id) from error
        finally:
            self._release(request_id, future)

    async def steer(self, text, *, from_=None, files=None, metadata=None):
        """The legacy steer request: a message held for the running turn. New code: prompt(text, while_running="steer")."""
        return await self._message("steer", text, from_=from_, files=files, metadata=metadata)

    async def _message(self, method, text, *, from_=None, files=None, metadata=None, idempotency_key=None, extra=None, **options):
        request_id = idempotency_key or str(uuid.uuid4())
        attached = await self._attach(request_id, files) if files else None
        return await self.request(method, _message_params(text, attached, extra, from_, metadata), idempotency_key=request_id, **options)

    async def prompt(self, text, *, actor=None, from_=None, files=None, metadata=None, while_running=None, idempotency_key=None, allow_disconnected=False,
                     spend_limit=None, output=None, history=None, run_limits=None, **options):
        """`from_` ({"id", "name"?, "username"?}) says who sent the message: the model sees it in a block only
        the runtime can write, and its id is the turn's actor. `actor` names someone else acting (`act` in
        identity tokens) without telling the model. `files` are attached: bytes, a local path (str or Path),
        {"name", "data": bytes, "content_type"?}, or {"path"} for a file already in the agent's mounts. Each is
        uploaded to the agent's workspace (uploads/<request>/<name>) first, then attached by path. `metadata` is the
        application's own key-value data about the message (a dict of at most 16 strings): the stored message and
        its request carry it, with the request's id, in history, events and webhooks; the model never sees it. `while_running="steer"` hands
        the message to a running turn, and returns with that turn's outcome (steer_message returns as soon as the turn has it). `spend_limit` ({"usd": n}) is this run's own budget:
        it ends before its next model request once it has spent that; the agent's spend limit is unchanged. `output`
        ({"schema": a JSON Schema for an object}) asks for structured output: the run ends with an answer that fits it, as "output".
        history="none" shows the model only the instructions (and tools) and this message, not the agent's history before it.
        `run_limits` ({"maxResponses"?, "maxSeconds"?}) are this run's own limits, lowering the agent's.
        `traceparent` (a W3C trace context) makes the run continue the caller's trace when the tenant exports telemetry."""
        result = await self._message("prompt", text, from_=from_, files=files, metadata=metadata, idempotency_key=idempotency_key,
                                     extra=_prompt_extra(actor, while_running, allow_disconnected, spend_limit, output, history, run_limits),
                                     **options)
        # A steered message's request completes as the running turn takes it, naming the turn: its outcome is the turn's.
        if while_running == "steer" and isinstance(result, dict) and isinstance(result.get("steeredInto"), str) and "reply" not in result:
            return await self.wait_for_request(result["steeredInto"], timeout=options.get("timeout"))
        return result

    async def steer_message(self, text, *, actor=None, from_=None, files=None, metadata=None, idempotency_key=None, allow_disconnected=False, traceparent=None):
        """Hand a message to the running turn (while_running="steer") and return as soon as the runtime has it, without
        waiting for the turn: {"id", "status", "steeredInto"?}. status "accepted": the running turn reads it after its current
        step; "taken": it has read it already (steeredInto names the turn, whose request has the turn's outcome); "queued": no
        turn was running, so it starts one. A steer_taken event on the agent's stream says when the model has it. A taken
        steer no longer counts against the agent's open requests, however long its turn goes on."""
        if self.closed or self.closing or self.fatal:
            raise self.fatal or AgentError("Client closed")
        request_id = idempotency_key or str(uuid.uuid4())
        _check_request_id(request_id)
        attached = await self._attach(request_id, files) if files else None
        params = _message_params(text, attached, _prompt_extra(actor, "steer", allow_disconnected), from_, metadata)
        record = await _http(self.http, self.base, self.path + "/requests", self.session["token"], "POST",
                             {"id": request_id, "method": "prompt", "params": params}, headers=_trace_header(traceparent))
        if "outcome" in record:
            self._settle(request_id, record["outcome"])
        return _steer_receipt(record)

    async def submit(self, text, *, actor=None, from_=None, files=None, metadata=None, idempotency_key=None, allow_disconnected=False,
                     spend_limit=None, output=None, history=None, traceparent=None, run_limits=None):
        """Send a message and return as soon as the runtime has it (202), without waiting for its run: {"id", "state"},
        the request's id and whether it runs or is queued. Follow it with wait_for_request(id), the stream or a webhook."""
        if self.closed or self.closing or self.fatal:
            raise self.fatal or AgentError("Client closed")
        request_id = idempotency_key or str(uuid.uuid4())
        _check_request_id(request_id)
        attached = await self._attach(request_id, files) if files else None
        params = _message_params(text, attached, _prompt_extra(actor, None, allow_disconnected, spend_limit, output, history, run_limits), from_, metadata)
        record = await _http(self.http, self.base, self.path + "/requests", self.session["token"], "POST",
                             {"id": request_id, "method": "prompt", "params": params}, headers=_trace_header(traceparent))
        if "outcome" in record:
            self._settle(request_id, record["outcome"])
        return {"id": record["id"], "state": record["state"]}

    async def _attach(self, request_id, files):
        names, attached = set(), []
        for index, file in enumerate(files):
            entry = _attachment(index, file)
            if isinstance(entry, dict):
                attached.append(entry)
                continue
            name, data, content_type, extra = entry
            unique = _unique_name(names, name, index)
            response = await self.http.put(f"{self.base}{self.path}/uploads/{quote(request_id, safe='')}/{quote(unique, safe='')}", content=_chunks(data) if isinstance(data, Path) else data, headers={
                "Authorization": f"Bearer {self.session['token']}", **({"Content-Type": content_type} if content_type else {})}, timeout=_UPLOAD_TIMEOUT)
            if not response.is_success:
                raise AgentError(_error(response), response.status_code)
            attached.append({"path": response.json()["path"], **extra})
        return attached

    async def configure(self, *, model=None, system_prompt=None, thinking_level=None, tools=None, max_output_tokens=_DEFAULT, temperature=_DEFAULT):
        """Change the model ("provider/model-id"), system prompt, thinking level, tools, max_output_tokens or temperature
        between runs (None removes either of the last two)."""
        params = {key: value for key, value in {"model": model, "systemPrompt": system_prompt, "thinkingLevel": thinking_level}.items() if value is not None}
        params.update({key: value for key, value in {"maxOutputTokens": max_output_tokens, "temperature": temperature}.items() if value is not _DEFAULT})
        if tools is not None:
            params["mcp"] = {"tools": [item.mcp_tool() for item in tools]}
        result = await self.request("configure", params)
        if tools is not None:
            self.tools = {item.name: item for item in tools}
            # Tools that run here now: answer the agent's calls, as its application.
            if tools and not self.attach:
                self.attach = True
                # Serving tools needs the stream throughout.
                self.lazy = False
                self.ready.clear()
                if self.runner:
                    self.runner.cancel()
                    await asyncio.gather(self.runner, return_exceptions=True)
                self.runner = None
                await self.connect()
        return result

    @property
    def files(self):
        """The agent's files, at the paths it sees them (/workspace/...): list, download, upload and link."""
        return AgentFiles(self)

    async def close(self, *, drain=None):
        """Close the connection; runs go on in the runtime. A client serving the agent's tools first tells the runtime it
        is shutting down, so new calls go to another process (one that took over, or the next to connect), and finishes
        the calls it has, for up to `drain` seconds (default 25; 0 cuts them off): call it on SIGTERM (in an ASGI app's
        lifespan shutdown, say), and a deploy loses no call."""
        if self.closed:
            return
        if self.closing is None:
            self.closing = asyncio.ensure_future(self._shutdown(_DRAIN_SECONDS if drain is None else drain))
        await asyncio.shield(self.closing)

    async def _drain(self, seconds):
        """Tell the runtime this connection takes no new calls, and wait up to `seconds` for those running to be answered.
        Only calls that can still be answered count: not one the runtime cancelled, nor any once the connection is gone (a
        reconnect is another connection). With none, close() costs nothing more than it did."""
        connection = self.connection
        running = lambda: self.connection == connection and any(not task.done() and not task.cancelling() for task in self.active.values())
        if self.fatal or not self.attach or not connection or seconds <= 0 or not running():
            return
        loop = asyncio.get_running_loop()
        until = loop.time() + seconds
        try:
            await _http(self.http, self.base, self.path + "/mcp", self.session["token"], "POST", {"jsonrpc": "2.0", "method": _DRAINING},
                        retry=False, headers={"X-Agent-Connection": connection})
        except Exception:
            pass
        while running() and loop.time() < until:
            await asyncio.sleep(0.025)

    async def _shutdown(self, drain):
        await self._drain(drain)
        self.closed = True
        if self.runner:
            self.runner.cancel()
            await asyncio.gather(self.runner, return_exceptions=True)
        if self.dispatcher:
            # on_event is called no more; the call in progress may finish, but one that never returns cannot hang shutdown.
            try:
                await asyncio.wait_for(self.events.join(), 2)
            except TimeoutError:
                pass
            self.dispatcher.cancel()
            await asyncio.gather(self.dispatcher, return_exceptions=True)
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
            await self.close(drain=0)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        await self.close()


# The simple interface: keyed agents you upsert and run ----------------------------------------------


@dataclass
class Run:
    """A run of the agent: one message and everything the agent did about it. status: "completed" (it answered: text),
    "input_required" (it waits on people: inputs; answer them to resume it) or "failed" (error: {"code", "message",
    "uncertain"?}; agent.run raises RunError unless throw_on_error=False)."""
    id: str
    status: str
    # The final reply's text; "" when it said nothing (or failed first).
    text: str = ""
    # A run with `output`: the answer, which fits its schema (an instance of it, for a pydantic model); else None.
    output: Any = None
    inputs: list = field(default_factory=list)
    error: dict | None = None
    # What its model calls used, where the runtime reports it.
    usage: dict | None = None
    # Files it wrote (download them with agent.files).
    files: list = field(default_factory=list)
    # Tool calls that did not complete (the model was told, and carried on): {"tool", "code", "message", "outcomeUnknown"?}.
    # code "not_connected": no process served the agent's tools, so the call did not run.
    tool_errors: list = field(default_factory=list)
    # The tool calls it made (the first 100), those from js_exec's code included: {"tool", "toolCallId"?, "innerCallId"?,
    # "ok", "code"?, "agentId"?}. code: a tool error's, "tool_error", "input_required" or "aborted"; agentId: a delegate
    # call's child agent. Arguments and results are in history.
    tool_calls: list = field(default_factory=list)
    # Tool sources (MCP servers, OpenAPI specs) that could not be reached: {"kind", "source", "message"}.
    source_errors: list = field(default_factory=list)
    # The runtime's result as sent.
    raw: dict | None = field(default=None, repr=False)


class Mount(TypedDict):
    """A volume an agent's file tools see at `path`: read-only or read-write, only its `subpath` directory, and with
    `notify` the agent is prompted when others change files under it."""
    volumeId: str
    path: str
    mode: str
    subpath: NotRequired[str]
    notify: NotRequired[bool]


class WorkspaceMount(TypedDict):
    """The agent's own workspace among its mounts: {"workspace": True} places it (at /workspace, or at `path`, e.g.
    "/scratch" beside a project volume at /workspace; attachments and tool outputs go there), {"workspace": False}
    leaves it out."""
    workspace: bool
    path: NotRequired[str]


class InputDetail(TypedDict):
    """What an input asks (its "detail"), by its kind. question: questions. approval: tool, source, reason, and the
    call's arguments as a dict (past 4,000 characters of JSON, argumentsPreview, their start, instead). form:
    requestedSchema. url: url, origin."""
    questions: NotRequired[list[dict]]
    tool: NotRequired[str]
    source: NotRequired[str]
    reason: NotRequired[str]
    arguments: NotRequired[dict]
    argumentsPreview: NotRequired[str]
    argumentsHash: NotRequired[str]
    requestedSchema: NotRequired[dict]
    url: NotRequired[str]
    origin: NotRequired[str]


def _run_of(request_id, result, output, make_input):
    """A run from an agent's prompt result: its status, text, output (parsed by a pydantic model) and inputs (make_input of each)."""
    result = result or {}
    error = ({"code": result.get("code") or "model_error", "message": result["error"]} if result.get("error")
             else {"code": "spend_limit", "message": "The agent reached its spend limit; raise it (spend_limit) to go on"} if result.get("stopped") == "spend_limit"
             else {"code": "turn_limit", "message": "The run reached its limit of model responses or time; send another message to continue"} if result.get("stopped") == "turn_limit" else None)
    # The runtime checked the output against the JSON Schema; a pydantic model parses it too (validators, types).
    value = result.get("output")
    if value is not None and not error:
        try:
            value = _parsed_output(output, value)
        except ValueError as invalid:
            error = {"code": "output_invalid", "message": f"The output does not fit its schema: {invalid}"}
    # A runtime from before structured output ignores the schema and answers in text.
    if output is not None and value is None and not error and not result.get("stopped") and result:
        error = {"code": "output_missing", "message": "The run ended without an output: this runtime may not support structured output (output); upgrade it"}
    status = "failed" if error else "input_required" if result.get("stopped") == "input_required" else "completed"
    return Run(request_id, status, text=result.get("reply") or "", output=value, inputs=[make_input(input) for input in result.get("inputs") or []], error=error,
               usage=result.get("usage"), files=result.get("files") or [], tool_errors=result.get("toolErrors") or [],
               tool_calls=result.get("toolCalls") or [],
               source_errors=result.get("sourceErrors") or [], raw=result)


class RunInput(dict):
    """Human input a run waits on (a dict: id, kind, message, detail (an InputDetail)...), with the means to answer it.
    answer() and decline() return the resumed run."""

    def __init__(self, agent, value, output=None):
        super().__init__(value)
        # The run's output schema: the resumed run's output is parsed by it too.
        self._agent, self._output = agent, output

    async def answer(self, value, *, from_=None, throw_on_error=True, timeout=None):
        """approval or url: True (yes, done) or False; question: the label chosen (or labels, or your own words), or a
        dict of question to answer; form: its fields (a confirmation, a form without fields: True or False). `from_`: who answers (your user id, or {"id", "name"?})."""
        return await self._agent._respond(self, _answer_for(self, value), from_, throw_on_error, timeout)

    async def decline(self, *, from_=None, throw_on_error=True, timeout=None):
        return await self._agent._respond(self, {"action": "decline"}, from_, throw_on_error, timeout)


def _output_request(output):
    """What the runtime is sent for an output schema: a pydantic model's JSON Schema (model_json_schema), or a JSON Schema as given."""
    if output is None:
        return None
    if isinstance(output, dict):
        return {"schema": output}
    if hasattr(output, "model_json_schema"):
        return {"schema": output.model_json_schema()}
    raise AgentError("output is a pydantic model class or a JSON Schema (a dict) for an object")


def _parsed_output(output, value):
    """The run's output as its schema gives it: an instance of a pydantic model (model_validate), else the value."""
    return output.model_validate(value) if output is not None and not isinstance(output, dict) else value


def _answer_for(input, value):
    kind = input["kind"]
    if kind in ("approval", "url"):
        if not isinstance(value, bool):
            raise AgentError(f"Answer {'an approval' if kind == 'approval' else 'a url step'} with True or False")
        return {"action": "accept" if value else "decline"}
    if kind == "question":
        questions = input["detail"].get("questions") or []
        if isinstance(value, (str, list)):
            if len(questions) != 1:
                raise AgentError(f"This input asks {len(questions)} questions: answer with {{question: answer}} for each")
            return {"action": "accept", "content": {"answers": {questions[0]["question"]: value}}}
        if not isinstance(value, dict):
            raise AgentError("Answer a question with the label chosen, or a dict of question to answer")
        return {"action": "accept", "content": {"answers": value}}
    if isinstance(value, bool):
        # A confirmation (context.confirm) is a form without fields: True or False answers it.
        if value and ((input["detail"].get("requestedSchema") or {}).get("properties") or {}):
            raise AgentError("This form has fields: answer with them, as a dict")
        return {"action": "accept", "content": {}} if value else {"action": "decline"}
    if not isinstance(value, dict):
        raise AgentError("Answer a form with its fields, as a dict")
    return {"action": "accept", "content": value}


@dataclass
class StreamPart:
    """What agent.stream() yields. type: "text" (text), "tool_call" (id, name, arguments), "tool_result" (id, name, output,
    is_error), "input_required" (input), with subagents=True
    "subagent_start" and "subagent_end" (id: the delegate call's, agent_id: its child's; status at the end), or, last,
    "done" (run). raw: the event it came from. `tool` and `tool_call_id` are `name` and `id` as run.tool_calls names them."""
    type: str
    text: str | None = None
    id: str | None = None
    name: str | None = None
    arguments: object = None
    output: str | None = None
    is_error: bool | None = None
    input: RunInput | None = None
    run: Run | None = None
    agent_id: str | None = None
    status: str | None = None
    raw: dict | None = field(default=None, repr=False)

    @property
    def tool(self):
        return self.name

    @property
    def tool_call_id(self):
        return self.id


def _text_of(value):
    content = value.get("content") if isinstance(value, dict) else None
    if not isinstance(content, list):
        return value if isinstance(value, str) else json.dumps(value)
    return "\n".join(part["text"] for part in content if isinstance(part, dict) and isinstance(part.get("text"), str))


def _sender(user):
    return {"id": user} if isinstance(user, str) else user


class _PartReader:
    """Reads a run's events into stream parts, in order: text as it is written (a blank line between the model's
    messages), tool calls and results and, for an agent's run (make_input), inputs and sub-agents."""

    def __init__(self, make_input=None):
        self.make_input, self.spoke, self.fresh = make_input, False, False

    def read(self, event):
        kind = event.get("type")
        if kind == "message_start" and (event.get("message") or {}).get("role") == "assistant":
            self.fresh = True
        elif kind == "message_update":
            delta = event.get("assistantMessageEvent") or {}
            if delta.get("type") == "text_delta" and delta.get("delta"):
                part = StreamPart("text", text=("\n\n" if self.fresh and self.spoke else "") + delta["delta"], raw=event)
                self.spoke, self.fresh = True, False
                return [part]
        elif kind == "tool_execution_start":
            return [StreamPart("tool_call", id=event.get("toolCallId"), name=event.get("toolName"), arguments=event.get("args"), raw=event)]
        elif kind == "tool_execution_end":
            return [StreamPart("tool_result", id=event.get("toolCallId"), name=event.get("toolName"), output=_text_of(event.get("result")),
                               is_error=bool(event.get("isError")), raw=event)]
        elif self.make_input and kind == "input_required":
            return [StreamPart("input_required", input=self.make_input(event["input"]), raw=event)]
        elif self.make_input and kind in ("subagent_start", "subagent_end"):
            return [StreamPart(kind, id=event.get("toolCallId"), agent_id=event.get("agentId"), name=event.get("name"), status=event.get("status"), raw=event)]
        return []


def _outcome_run(request_id, outcome, output, make_input):
    """A run from a request's outcome: its result, or the runtime's error ({"error", "code"?, "uncertain"?})."""
    if "error" in outcome:
        code = outcome.get("code") if isinstance(outcome.get("code"), str) else None
        return Run(request_id, "failed", error={"code": code or "runtime_error", "message": outcome["error"], **({"uncertain": True} if outcome.get("uncertain") else {})})
    return _run_of(request_id, outcome.get("result"), output, make_input)


class RunStream:
    """async for part in agent.stream(text); `id` is the run's; await result() for the run as `done` has it.
    Breaking off stops the reading, not the run."""

    def __init__(self, agent, text, options):
        self.id = options.pop("idempotency_key", None) or str(uuid.uuid4())
        self._agent, self._throw = agent, options.pop("throw_on_error", True)
        output = options.get("output")
        self._parts = asyncio.Queue()
        reader = _PartReader(lambda input: RunInput(agent, input, output))

        def listen(event, request_id):
            if request_id != self.id:
                return
            for part in reader.read(event):
                self._parts.put_nowait(part)

        self._unlisten = agent.client.listen(listen)
        self._task = asyncio.ensure_future(agent._run(text, self.id, throw_on_error=False, **options))
        self._task.add_done_callback(lambda task: (self._unlisten(), self._parts.put_nowait(None)))

    async def result(self):
        run = await self._task
        if run.error and self._throw:
            raise RunError(run)
        return run

    async def __aiter__(self):
        try:
            while True:
                part = await self._parts.get()
                if part is None:
                    break
                yield part
            run = await self._task
            yield StreamPart("done", run=run)
            if run.error and self._throw:
                raise RunError(run)
        finally:
            self._unlisten()


class Agent:
    """A keyed agent (from Agents.upsert). `id` is safe to log; `client` is the lower-level AgentClient."""

    def __init__(self, client, closed=None, agents=None):
        self.client, self.id, self._closed, self._agents = client, client.id, closed, agents
        # For an agent fork() made: {"agentId", "atMessage"}, the agent and message it was forked from.
        self.forked_from = None
        # From upsert and get: a hash of the agent's configuration (from upsert, the one it asked for). Equal hashes are equal
        # configurations; runtime.list_agents() has every agent's "configHash", to compare without keeping a manifest.
        self.config_hash = None

    def __repr__(self):
        return f"Agent(id={self.id!r})"

    @property
    def session(self):
        """Its id and token (keep the token secret; repr leaves it out)."""
        return self.client.session

    @property
    def files(self):
        """The agent's files: list, download, upload and link."""
        return self.client.files

    async def run(self, text, *, user=None, files=None, metadata=None, idempotency_key=None, timeout=None, throw_on_error=True, while_running=None,
                  allow_disconnected=False, spend_limit=None, output=None, traceparent=None, history=None, run_limits=None):
        """Send a message and wait for the run it starts: its reply, or the input it waits on. There is no timeout
        unless `timeout` (seconds) says so, and that only stops the wait. `user` (your user id, or {"id", "name"?}) is
        who sent it: the model sees who, and tools get it as identity.user. A failed run raises RunError (with the run)
        unless throw_on_error=False. The same idempotency_key returns the same run, never a second one. An agent with application
        tools and no process serving them refuses the run (AgentError, code APPLICATION_NOT_CONNECTED) unless allow_disconnected.
        `spend_limit` ({"usd": n}) is this run's own budget; the agent's spend limit is unchanged. `output` (a pydantic model class, or a
        JSON Schema dict for an object) asks for structured output: the agent ends the run with an answer that fits it, as run.output (an
        instance of the model); a run that ends without one fails (code "output_missing"). Not with while_running="steer".
        `traceparent` (a W3C trace context, "00-<trace-id>-<span-id>-<flags>") makes the run's spans continue that trace
        when the tenant exports telemetry (runtime.telemetry.set); it is not part of the run's idempotency.
        history="none" shows the model only the instructions (and tools) and this message, as a new conversation would, without
        making an agent: for many independent questions to one agent. The run is still recorded in the history, and later runs
        without it see it. Not with while_running="steer". `run_limits` ({"maxResponses"?, "maxSeconds"?}) are this run's own
        limits, lowering the agent's: at one, it ends with stopped "turn_limit"."""
        return await self._run(text, idempotency_key or str(uuid.uuid4()), user=user, files=files, metadata=metadata, timeout=timeout,
                               throw_on_error=throw_on_error, while_running=while_running, allow_disconnected=allow_disconnected, spend_limit=spend_limit,
                               output=output, traceparent=traceparent, history=history, run_limits=run_limits)

    def stream(self, text, *, user=None, files=None, metadata=None, idempotency_key=None, timeout=None, throw_on_error=True, while_running=None,
               allow_disconnected=False, spend_limit=None, output=None, traceparent=None, history=None):
        """Send a message and read the run as it happens: text as it is written, tool calls and results, the input it
        waits on and, last, "done" with the run."""
        return RunStream(self, text, {"user": user, "files": files, "metadata": metadata, "idempotency_key": idempotency_key, "timeout": timeout,
                                      "throw_on_error": throw_on_error, "while_running": while_running, "allow_disconnected": allow_disconnected,
                                      "spend_limit": spend_limit, "output": output, "traceparent": traceparent, "history": history})

    async def _run(self, text, request_id, *, user=None, files=None, metadata=None, timeout=None, throw_on_error=True, while_running=None,
                   allow_disconnected=False, spend_limit=None, output=None, traceparent=None, history=None, run_limits=None):
        pending = self.client.prompt(text, from_=_sender(user) if user else None, files=files, metadata=metadata, idempotency_key=request_id,
                                     timeout=timeout, while_running=while_running, allow_disconnected=allow_disconnected, spend_limit=spend_limit,
                                     output=_output_request(output), traceparent=traceparent, history=history, run_limits=run_limits)
        return await self._settle(request_id, pending, throw_on_error, output)

    async def _settle(self, request_id, pending, throw_on_error, output=None):
        try:
            run = self._to_run(request_id, await pending, output)
        except AgentError as error:
            # A run that ended in an error settles with it; anything else (a refused request, a closed client) is not a run.
            if error.status != 0 or error.request_id != request_id or str(error).startswith(("Client closed", "Stopped waiting")):
                raise
            run = Run(request_id, "failed", error={"code": error.code or "runtime_error", "message": str(error), **({"uncertain": True} if error.uncertain else {})})
        if run.error and throw_on_error:
            raise RunError(run)
        return run

    def _to_run(self, request_id, result, output=None):
        return _run_of(request_id, result, output, lambda input: RunInput(self, input, output))

    async def _respond(self, input, answer, from_, throw_on_error, timeout):
        audience = (input.get("responders") or {}).get("audience")
        if audience and not from_:
            raise AgentError(f"Say who answers (from_): only {', '.join(audience)} may answer this")
        answered = await self.client.answer(input["id"], **answer, **({"from_": _sender(from_)} if from_ else {}))
        request = answered.get("request")
        if request:
            return await self._settle(request["id"], self.client.wait_for_request(request["id"], timeout=timeout), throw_on_error, input._output)
        # Other inputs of the run still wait: it resumes once they are answered too.
        pending = [RunInput(self, other, input._output) for other in await self.client.inputs(state="pending") if other["requestId"] == input["requestId"]]
        return Run(input["requestId"], "input_required", inputs=pending)

    async def send(self, text, *, user=None, files=None, metadata=None, idempotency_key=None, allow_disconnected=False, spend_limit=None,
                   output=None, traceparent=None, history=None, run_limits=None):
        """Send a message and return as soon as the runtime has it, without waiting for the run: {"id", "state"} (running
        or queued). Get its outcome later with wait(id), the agent's events, or a run.completed webhook."""
        return await self.client.submit(text, from_=_sender(user) if user else None, files=files, metadata=metadata, idempotency_key=idempotency_key,
                                        allow_disconnected=allow_disconnected, spend_limit=spend_limit, output=_output_request(output),
                                        traceparent=traceparent, history=history, run_limits=run_limits)

    async def wait(self, request_id, *, timeout=None, throw_on_error=True):
        """A run sent with send, once it ends: as run answers (RunError if it failed, unless throw_on_error=False)."""
        return await self._settle(request_id, self.client.wait_for_request(request_id, timeout=timeout), throw_on_error)

    async def pending_inputs(self):
        """Inputs waiting on people, across the agent's runs."""
        return [RunInput(self, input) for input in await self.client.inputs(state="pending")]

    async def history(self):
        """Its whole history: every message, oldest first (history_page reads a page at a time)."""
        return (await self.client.history())["messages"]

    async def history_page(self, *, before=None, limit=50):
        return await self.client.history_page(before=before, limit=limit)

    async def steer(self, text, *, wait=False, **options):
        """A message for the running turn, which reads it after its current step; with no turn running, it starts one.
        Returns as soon as the runtime has it, with a receipt {"id", "status", "steeredInto"?}: "accepted" (the turn reads it
        next), "taken" (it has, in the turn steeredInto) or "queued" (it runs as a turn of its own, id). A turn that never
        ends takes any number of steers. wait=True waits for the run that took it instead: run(text, while_running="steer")."""
        if wait:
            return await self.run(text, **options, while_running="steer")
        user = options.pop("user", None)
        unknown = set(options) - {"files", "metadata", "idempotency_key", "allow_disconnected", "traceparent"}
        if unknown:
            raise TypeError(f"steer() takes {', '.join(sorted(unknown))} only with wait=True")
        return await self.client.steer_message(text, from_=_sender(user) if user else None, **options)

    async def configure(self, *, model=None, instructions=None, thinking_level=None, tools=None, max_output_tokens=_DEFAULT, temperature=_DEFAULT):
        """Change its model, instructions, thinking level or tools between runs."""
        return await self.client.configure(model=model, system_prompt=instructions, thinking_level=thinking_level, tools=tools, max_output_tokens=max_output_tokens, temperature=temperature)

    async def abort(self, *, queued=None):
        """Stop the agent: its running turn, and the runs queued behind it (each fails with code "cancelled"), so nothing
        runs after the stop. queued="keep" stops the running turn only."""
        return await self.client.abort(queued=queued)

    async def fork(self, *, key=None, name=None, at_message=None, ttl_seconds=_DEFAULT, subject=None, context=None, instructions_append=None,
                   model_headers=_DEFAULT, tools=None, on_event=None, on_input=None, on_error=None, attach=None, takeover=False):
        """A new agent with this one's configuration, a copy of its history and a fork of its workspace, each its own from
        then on: try another direction without losing this one. By default the history ends with the last turn that ended
        (never mid-turn); `at_message` ends it at a history index or a request's turn. The same `key` returns the same fork."""
        if self._agents is None:
            raise AgentError("fork needs the Agents this agent came from (agents.upsert, get or agent)")
        return await self._agents.fork(self.id, key=key, name=name, at_message=at_message, ttl_seconds=ttl_seconds, subject=subject, context=context,
                                       instructions_append=instructions_append, model_headers=model_headers, tools=tools,
                                       on_event=on_event, on_input=on_input, on_error=on_error, attach=attach, takeover=takeover)

    async def schedule(self, *, text=None, code=None, at=None, in_seconds=None, every_seconds=None):
        """Wake the agent later with a message (text), or run code; every_seconds (at least 60) repeats it."""
        return await self.client.schedule(text=text, code=code, at=at, in_seconds=in_seconds, every_seconds=every_seconds)

    async def schedules(self):
        return await self.client.schedules()

    async def unschedule(self, schedule_id):
        return await self.client.unschedule(schedule_id)

    async def delete(self):
        """Delete the agent, its history and its files, for good."""
        try:
            await self.client.destroy()
        finally:
            self._forget()

    async def close(self, *, drain=None):
        """Close this process's connection to it (its runs go on in the runtime), finishing its tool calls first (see Agents.close)."""
        try:
            await self.client.close(drain=drain)
        finally:
            self._forget()

    def _forget(self):
        if self._closed:
            self._closed(self)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        await self.close()


def _stateless_run(view, output=None, throw_on_error=True):
    """A stateless run's view as a Run: its output parsed by a pydantic model, and its failure raised unless throw_on_error is False."""
    error, value = view.get("error"), view.get("output")
    if value is not None and not error:
        try:
            value = _parsed_output(output, value)
        except ValueError as invalid:
            error = {"code": "output_invalid", "message": f"The output does not fit its schema: {invalid}"}
    run = Run(view["id"], "failed" if error else view["status"], text=view.get("text") or "", output=value, error=error, usage=view.get("usage"),
              files=view.get("files") or [], tool_errors=view.get("toolErrors") or [], tool_calls=view.get("toolCalls") or [],
              source_errors=view.get("sourceErrors") or [], raw=view)
    if run.error and throw_on_error:
        raise RunError(run)
    return run


class StatelessRunStream:
    """async for part in await agents.runs.stream(input, ...): the run's text as it is written, tool calls and results,
    and last "done" with the run. `id` is the run's; await result() for the run. Breaking off stops the reading, not the run."""

    def __init__(self, runtime, run_id, output, throw_on_error):
        self.id, self._runtime, self._output, self._throw = run_id, runtime, output, throw_on_error

    async def result(self):
        return _stateless_run(await self._runtime.wait_for_run(self.id), self._output, self._throw)

    async def __aiter__(self):
        reader = _PartReader()
        async for frame in self._runtime.run_events(self.id):
            data = frame["data"]
            if data.get("type") == "response":
                break
            for part in reader.read(data.get("event") or {} if data.get("type") == "event" else {}):
                yield part
        run = _stateless_run(await self._runtime.wait_for_run(self.id), self._output, False)
        yield StreamPart("done", run=run)
        if run.error and self._throw:
            raise RunError(run)


class Runs:
    """Stateless runs (POST /v1/runs): a configuration and an input in, a result out, nothing carried over. See Agents.run."""

    def __init__(self, runtime):
        self.runtime = runtime

    @staticmethod
    def _request(input, *, instructions=None, instructions_append=None, model=None, definition=None, thinking_level=None, output=None, builtins=None, delegate=None,
                 file_tools=None, mounts=None, files=None, user=None, metadata=None, subject=None, context=None, key_scope=None, spend_limit=None, run_limits=None,
                 model_headers=None, name=None, retention_seconds=None, code_mode=None, max_output_tokens=None, temperature=None, mcp_servers=None):
        parts = [{"type": "text", "text": input}] if input else []
        for file in files or []:
            entry = file if isinstance(file, dict) else {"data": file}
            extra = {"transcribe": entry["transcribe"]} if isinstance(entry.get("transcribe"), bool) else {}
            named = {key: entry[key] for key in ("name", "contentType") if entry.get(key)}
            if entry.get("content_type"):
                named["contentType"] = entry["content_type"]
            if isinstance(entry.get("url"), str):
                parts.append({"type": "file", "url": entry["url"], **named, **extra})
                continue
            data = entry["data"]
            parts.append({"type": "file", "data": base64.b64encode(bytes(data)).decode(), **named, **extra})
        fields = {"input": input if len(parts) == 1 and parts[0]["type"] == "text" else parts, "systemPrompt": instructions, "systemPromptAppend": instructions_append, "model": model, "definition": definition,
                  "thinkingLevel": thinking_level, "output": _output_request(output), "builtins": builtins, "delegate": delegate, "mcpServers": mcp_servers, "fileTools": file_tools, "mounts": mounts,
                  "from": _sender(user) if user else None, "metadata": metadata, "subject": subject, "context": context, "keyScope": key_scope, "spendLimit": spend_limit,
                  "runLimits": run_limits, "modelHeaders": model_headers, "name": name, "retentionSeconds": retention_seconds, "codeMode": code_mode,
                  "maxOutputTokens": max_output_tokens, "temperature": temperature}
        return {key: value for key, value in fields.items() if value is not None}

    async def create(self, input, *, idempotency_key=None, wait=None, traceparent=None, **config):
        """Start a run and return at once, still running (or, with `wait`, once it ends within it): its view as a dict."""
        return await self.runtime.create_run(self._request(input, **config), idempotency_key=idempotency_key, wait=wait, traceparent=traceparent)

    async def get(self, run_id, *, wait=0):
        """A run by its id, as a dict: running, or how it ended. `wait` (seconds, at most 25) waits for it to end first."""
        return await self.runtime.get_run(run_id, wait=wait)

    async def abort(self, run_id):
        """Stop a running run: it ends failed, code "aborted"."""
        return await self.runtime.abort_run(run_id)

    async def delete(self, run_id):
        """Delete a run's result, events and messages now, before its retention ends."""
        return await self.runtime.delete_run(run_id)

    async def messages(self, run_id):
        return await self.runtime.run_messages(run_id)

    def events(self, run_id, *, last_event_id=None):
        """A run's raw event stream, to its end; see stream for one read into text, tool calls and the result."""
        return self.runtime.run_events(run_id, last_event_id=last_event_id)

    async def run(self, input, *, idempotency_key=None, throw_on_error=True, traceparent=None, **config):
        """Run and wait for its result: see Agents.run."""
        view = await self.create(input, idempotency_key=idempotency_key, wait=True, traceparent=traceparent, **config)
        if view["status"] == "running":
            view = await self.runtime.wait_for_run(view["id"])
        return _stateless_run(view, config.get("output"), throw_on_error)

    async def stream(self, input=None, *, run_id=None, idempotency_key=None, throw_on_error=True, traceparent=None, **config):
        """Run, reading it as it happens (or, given run_id, follow that run). Returns a StatelessRunStream."""
        if run_id is None:
            run_id = (await self.create(input, idempotency_key=idempotency_key, traceparent=traceparent, **config))["id"]
        return StatelessRunStream(self.runtime, run_id, config.get("output"), throw_on_error)


class Agents:
    """Keyed agents you upsert and run.

        async with Agents() as agents:
            agent = await agents.upsert("support-triage", model="anthropic/claude-sonnet-5-5", instructions="...")
            print((await agent.run("Hello")).text)

    api_key defaults to CAMELAI_API_KEY; url to CAMELAI_BASE_URL, else https://run.camelai.com. `connection` is when agent
    handles hold their event stream: "lazy" (the default) only while agent.stream() reads a run, so a server holding many
    agents holds no idle connections; "eager" from the start until close. A handle that serves tools, or has on_event or
    on_input, needs the stream throughout, so it holds it from the start either way. Each call may say otherwise."""

    def __init__(self, api_key=None, *, url=None, connection="lazy"):
        self.runtime = AgentRuntime(url=url, api_key=api_key)
        # Stateless runs: create, get, stream, abort, delete, messages; Agents.run is the one-call form.
        self.runs = Runs(self.runtime)
        # Speech to text on its own: create(file or url=...). Audio attached to a message is transcribed without it.
        self.transcriptions = self.runtime.transcriptions
        self._open = set()
        self.connection = connection

    async def run(self, input, **options):
        """A stateless run: a configuration and `input` in, its result (a Run) out, nothing carried over and no agent kept.
        It is as durable as an agent's run (a node lost mid-run, or a deploy, goes on from its last step), and counts toward
        busy agents and runs per minute as one does. Options: instructions, model, output (a pydantic model or JSON Schema),
        definition, builtins ("web_fetch", "web_search", "delegate"), mcp_servers (no credentials: auth {"type": "runtime"} or none),
        thinking_level, files (bytes, inline), user, metadata,
        idempotency_key, spend_limit, run_limits, retention_seconds, throw_on_error. A failed run raises RunError unless
        throw_on_error=False. For a conversation that carries over, upsert an agent instead.

            run = await agents.run("Ship on Friday?", instructions="Vote yes or no.", output=Vote)
        """
        return await self.runs.run(input, **options)

    async def upsert(self, key, *, model=None, instructions=None, tools=None, definition=None, thinking_level=None, subject=None, context=None,
                     key_scope=None, spend_limit=None, run_limits=None, model_headers=None, mounts=None, remount=None, name=None, instructions_append=None, file_tools=None,
                     builtins=None, delegate=None, subagents=False, on_event=None, on_input=None, on_error=None, attach=None, takeover=False, connection=None,
                     code_mode=None, initial_messages=None, import_messages=None, max_output_tokens=None, temperature=None, mcp_servers=None):
        """The agent for `key` (your name for it: "support-triage", or "user-123"), made now if there is none, and set
        to this configuration if it differs. The same key is the same agent, with its history and files, until
        agent.delete(); any number of processes may upsert it. `tools` (@tool functions) run in this process, which
        then answers the agent's tool calls, one process at a time: serverless or several processes, serve tools over
        HTTP (serve_tools) and name them in a definition instead. `builtins` are tools the runtime answers itself
        ("web_fetch", "web_search", "schedule", "ask_user"), without a definition. `delegate` ({"agents": [...]}) lets it hand
        tasks to sub-agents (its builtin comes with it; see the multi-agent guide); subagents=True delivers its sub-agents'
        progress as events. `mcp_servers` ([{"name", "url", "auth"?: {"type": "runtime"}, ...}]) are remote MCP servers of its
        own, without a definition and without credentials: the runtime's identity tokens or none (a token or headers go in a definition).
        attach=False declares the tools without serving them (another process does); takeover=True replaces the process serving them now.
        code_mode=False gives the agent no js_exec: the model calls every tool directly, and with file_tools=False and no tools its
        prompt is little more than your instructions (for a tool-less agent). An upsert of the configuration the agent has
        already is not counted as an agent create; agent.config_hash says which configuration it asked for.
        `initial_messages` (Pi messages: user, assistant, toolResult, compactionSummary) is the history the agent begins
        with, a conversation from elsewhere: used only when the agent is made (see the multi-user guide). `import_messages`
        ({"format": "anthropic" | "openai-responses" | "openai-chat", "messages": [...], "model"?}) is one in another API's
        format (Anthropic Messages, OpenAI Responses or Chat Completions), which the runtime converts (not both).
        `max_output_tokens` caps each model response (within the model's maximum); `temperature` (0 to 2) sets sampling, for a
        model and thinking level that take one (a 400 otherwise)."""
        tools = list(tools or [])
        session = await self.runtime.upsert_agent(key, tools=tools, definition=definition, system_prompt=instructions, model=model, thinking_level=thinking_level,
                                                  subject=subject, context=context, key_scope=key_scope, spend_limit=spend_limit, run_limits=run_limits,
                                                  model_headers=model_headers, mounts=mounts, remount=remount, name=name, system_prompt_append=instructions_append, file_tools=file_tools, builtins=builtins,
                                                  delegate=delegate, code_mode=code_mode, initial_messages=initial_messages, import_messages=import_messages,
                                                  max_output_tokens=max_output_tokens, temperature=temperature, mcp_servers=mcp_servers)
        # The upsert declared these tools already (between the agent's turns, if it runs).
        agent = await self.agent(session, tools=tools, on_event=on_event, on_input=on_input, on_error=on_error, attach=attach, takeover=takeover, subagents=subagents,
                                 connection=connection, _sync=False)
        agent.config_hash = session.get("configHash")
        return agent

    async def get(self, key_or_id, *, tools=None, on_event=None, on_input=None, on_error=None, attach=None, takeover=False, connection=None):
        """The existing agent with this key (or id), without changing it: upsert sets an agent to what it is given, get
        takes it as it is. AgentError with status 404 when there is none. Pass `tools` to serve them too."""
        session = await self.runtime.agent_credentials(key_or_id)
        agent = await self.agent(session, tools=tools, on_event=on_event, on_input=on_input, on_error=on_error, attach=attach, takeover=takeover, connection=connection)
        agent.config_hash = session.get("configHash")
        return agent

    async def fork(self, agent_id, *, key=None, name=None, at_message=None, ttl_seconds=_DEFAULT, subject=None, context=None, instructions_append=None,
                   model_headers=_DEFAULT, tools=None, on_event=None, on_input=None, on_error=None, attach=None, takeover=False, connection=None):
        """A new agent forked from `agent_id` (see Agent.fork). Pass `tools` to serve them, as for get."""
        answer = await self.runtime.fork_agent(agent_id, key=key, name=name, at_message=at_message, ttl_seconds=ttl_seconds, subject=subject,
                                               context=context, instructions_append=instructions_append, model_headers=model_headers)
        agent = await self.agent(answer, tools=tools, on_event=on_event, on_input=on_input, on_error=on_error, attach=attach, takeover=takeover, connection=connection)
        agent.forked_from = answer.get("forkedFrom")
        return agent

    async def agent(self, session, *, tools=None, on_event=None, on_input=None, on_error=None, attach=None, takeover=False, subagents=False, connection=None, _sync=True):
        """An agent you hold the credentials of ({"id", "token"}, from another process say). Tools that differ from those
        the agent has are declared as it connects."""
        tools = list(tools or [])
        client = await self.runtime.connect_agent(session, tools=tools, on_event=on_event, on_input=on_input, on_error=on_error,
                                                  attach=bool(tools) if attach is None else attach, takeover=takeover, sync_tools=_sync, subagents=subagents,
                                                  connection=connection or self.connection)
        agent = Agent(client, self._open.discard, self)
        self._open.add(agent)
        return agent

    async def close(self, *, drain=None):
        """Close every agent's connection (their runs go on in the runtime). Tool calls running finish first, for up to
        `drain` seconds (default 25), and new ones go elsewhere: call it on SIGTERM so a deploy loses no call."""
        await asyncio.gather(*(agent.close(drain=drain) for agent in list(self._open)))
        await self.runtime.close(drain=drain)

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


def _key_cache(url, kid, http):
    """The cached keys for (http, url), and whether to fetch them again first."""
    import time
    cache = _key_sets.setdefault((id(http), url), {"keys": {}, "fetched": 0.0, "http": http})
    age = time.monotonic() - cache["fetched"]
    return cache, age > 300 or (kid not in cache["keys"] and age > 10)


def _cached_key(cache, kid, url, response):
    """The key `kid` from the cache, refreshed from `response` (the JWKS document) when one was fetched."""
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    import time
    if response is not None:
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


async def _public_key(url, kid, http):
    cache, stale = _key_cache(url, kid, http)
    response = None
    if stale:
        client = http or httpx.AsyncClient(timeout=10)
        try:
            response = await client.get(url, headers={"Accept": "application/json"})
        finally:
            if http is None:
                await client.aclose()
    return _cached_key(cache, kid, url, response)


def _public_key_sync(url, kid, http):
    cache, stale = _key_cache(url, kid, http)
    response = None
    if stale:
        client = http or httpx.Client(timeout=10)
        try:
            response = client.get(url, headers={"Accept": "application/json"})
        finally:
            if http is None:
                client.close()
    return _cached_key(cache, kid, url, response)


def _require_tenant(tenant):
    """Refuse to check tokens without the tenant they must come from."""
    valid = lambda value: isinstance(value, str) and value
    if not (valid(tenant) or (isinstance(tenant, (list, tuple, set)) and tenant and all(valid(value) for value in tenant))):
        raise TypeError("Pass tenant=: your tenant's id (GET /v1/me answers it, or await AgentRuntime().me()), or a list of those you accept. "
                        "Without it, another tenant's agents could act as your users")
    return {tenant} if isinstance(tenant, str) else set(tenant)


# camelRun's hosted runtime answers at both names, and signs as the first it had, which tool servers already check.
_HOSTED = ("https://run.camelai.com", "https://agents.camelai.dev")
_HOSTED_ISSUER = "https://agents.camelai.dev"


def _issuer_of(runtime, issuer):
    if issuer:
        return issuer.rstrip("/")
    runtime = runtime.rstrip("/")
    return _HOSTED_ISSUER if runtime in _HOSTED else runtime


def _token_header(token):
    """A token's pieces and header, before its key is known."""
    pieces = token.split(".")
    if len(pieces) != 3:
        raise RuntimeTokenError("Malformed token")
    header = _part(pieces[0])
    if header.get("alg") != "EdDSA" or not isinstance(header.get("kid"), str):
        raise RuntimeTokenError("Token is not an EdDSA token with a key id")
    return pieces, header


def _signed_claims(pieces, key, *, runtime, issuer, clock_tolerance):
    """A token's claims, once its signature, issuer and times check out."""
    import time
    from cryptography.exceptions import InvalidSignature
    try:
        key.verify(_b64decode(pieces[2]), f"{pieces[0]}.{pieces[1]}".encode())
    except (InvalidSignature, ValueError):
        raise RuntimeTokenError("Token signature does not verify") from None
    claims = _part(pieces[1])
    now = time.time()
    if claims.get("iss") != _issuer_of(runtime, issuer):
        raise RuntimeTokenError("Token is from another issuer")
    if not isinstance(claims.get("exp"), (int, float)) or claims["exp"] + clock_tolerance < now:
        raise RuntimeTokenError("Token has expired")
    if isinstance(claims.get("nbf"), (int, float)) and claims["nbf"] - clock_tolerance > now:
        raise RuntimeTokenError("Token is not valid yet")
    if isinstance(claims.get("iat"), (int, float)) and claims["iat"] - clock_tolerance > now:
        raise RuntimeTokenError("Token is issued in the future")
    return claims


def _verified(pieces, key, *, runtime, audience, tenants, issuer, clock_tolerance):
    """The identity a token carries, once its signature, issuer, tenant, audience and times check out."""
    claims = _signed_claims(pieces, key, runtime=runtime, issuer=issuer, clock_tolerance=clock_tolerance)
    if claims.get("tenant") not in tenants:
        raise RuntimeTokenError("Token is for another tenant's agent")
    if not _audience_matches(claims.get("aud"), audience):
        raise RuntimeTokenError("Token is for another server")
    identity = identity_from_claims(claims)
    identity.claims = claims
    return identity


def _file_token(url, runtime):
    """A file URL's token, once the URL is at the runtime (either hosted name for camelRun's)."""
    from urllib.parse import unquote
    parsed = urlparse(url)
    runtime = runtime.rstrip("/")
    allowed = _HOSTED if runtime in _HOSTED else (runtime,)
    if not any(urlparse(origin)[:2] == parsed[:2] for origin in allowed):
        raise RuntimeTokenError("The URL is not at the runtime")
    parts = parsed.path.split("/")
    if len(parts) != 5 or parts[:3] != ["", "v1", "files"] or not parts[3]:
        raise RuntimeTokenError("Not a file URL")
    return unquote(parts[3])


def _file_claims(pieces, key, *, runtime, tenant, agent, issuer, clock_tolerance):
    """What a file URL's token grants, once it checks out and is for `tenant` and `agent` (each a string or a list) when given."""
    claims = _signed_claims(pieces, key, runtime=runtime, issuer=issuer, clock_tolerance=clock_tolerance)
    if claims.get("aud") != "camelrun:file":
        raise RuntimeTokenError("Token is not for a file")
    if tenant is not None and claims.get("tenant") not in ({tenant} if isinstance(tenant, str) else set(tenant)):
        raise RuntimeTokenError("Token is for another tenant's agent")
    if agent is not None and claims.get("agent") not in ({agent} if isinstance(agent, str) else set(agent)):
        raise RuntimeTokenError("Token is for another agent")
    return claims


async def verify_file_url(url, *, runtime, tenant=None, agent=None, issuer=None, http=None, clock_tolerance=30):
    """Check that a file URL a tool was sent ({"$file": path} in a call's arguments) came from the runtime, for the
    tenant and agent you expect (each a string or a list; optional), and has not expired: the URL is at `runtime`, and
    its token is signed by the runtime's keys for files. Returns what it grants: tenant, agent, call, tool, volume, path
    (in the volume), agentPath (as the agent names it), kind (file, manifest or archive), version or snapshot, and exp.
    The runtime checks it again when the URL is fetched. camelai_run.sync.verify_file_url is the same, synchronous."""
    runtime = runtime.rstrip("/")
    pieces, header = _token_header(_file_token(url, runtime))
    key = await _public_key(f"{runtime}/.well-known/jwks.json", header["kid"], http)
    return _file_claims(pieces, key, runtime=runtime, tenant=tenant, agent=agent, issuer=issuer, clock_tolerance=clock_tolerance)


def _audience_matches(given, audience):
    """Whether a token's aud (a string or a list) names one of the audiences accepted (a string or a list)."""
    wanted = {value.rstrip("/") for value in ([audience] if isinstance(audience, str) else audience)}
    return any(isinstance(value, str) and value.rstrip("/") in wanted for value in (given if isinstance(given, list) else [given]))


async def verify_runtime_token(token, *, runtime, audience, tenant=None, issuer=None, http=None, clock_tolerance=30):
    """Verify an identity token and return who the call is for (a RuntimeIdentity, with the token's
    claims): the signature against the runtime's published Ed25519 keys (EdDSA only), the issuer,
    that it was made for an agent of `tenant` (your tenant's id, or a list: required, since another
    tenant can point its agents at your server), that the audience is yours (a string or a list), and the times.
    camelai_run.sync.verify_runtime_token is the same, synchronous (for Django or Flask)."""
    tenants = _require_tenant(tenant)
    pieces, header = _token_header(token)
    runtime = runtime.rstrip("/")
    key = await _public_key(f"{runtime}/.well-known/jwks.json", header["kid"], http)
    return _verified(pieces, key, runtime=runtime, audience=audience, tenants=tenants, issuer=issuer, clock_tolerance=clock_tolerance)


_WELL_KNOWN = "/.well-known/oauth-protected-resource"


def _bearer(authorization):
    match = (authorization or "").split(" ", 1)
    if len(match) != 2 or match[0].lower() != "bearer" or not match[1].strip():
        raise RuntimeTokenError("No bearer token")
    return match[1].strip()


def _tool_server_response(method, path, origin, metadata, issuer, server_name):
    """What a tool server answers before reading the request's token: its protected resource metadata (GET), 405 for
    anything but POST; None for a POST. Responses here are (status, body, extra headers)."""
    if metadata and method == "GET" and path.startswith(_WELL_KNOWN):
        resource = origin + (path[len(_WELL_KNOWN):] or "/")
        return 200, {"resource": resource, "authorization_servers": [issuer], "bearer_methods_supported": ["header"], "resource_name": server_name}, ()
    if method != "POST":
        return 405, {"error": "Use POST: this MCP server is stateless and has no event stream"}, (("allow", "POST"),)
    return None


def _unauthorized(error, origin, path, metadata):
    challenge = 'Bearer error="invalid_token"' + (f', resource_metadata="{origin}{_WELL_KNOWN}{"" if path == "/" else path}"' if metadata else "")
    return 401, {"error": str(error)}, (("www-authenticate", challenge),)


def _tool_table(tools):
    """serve_tools' tools as a table by name, or a function of the caller's identity that returns them, kept as it is."""
    if callable(tools) and not isinstance(tools, Tool):
        return tools
    return tools if isinstance(tools, dict) else {item.name: item for item in tools}


async def _tools_for(table, identity):
    """The tools for this caller: the table, or what a function of its identity returns (a list or a dict of tools)."""
    if not callable(table) or isinstance(table, (dict, Tool)):
        return table
    tools = table(identity)
    if inspect.isawaitable(tools):
        tools = await tools
    return tools if isinstance(tools, dict) else {item.name: item for item in tools}


async def _tool_server_answer(body, table, identity, server_name, inline=False):
    """A tool server's answer to a verified POST: each JSON-RPC message answered (a batch, in turn)."""
    table = await _tools_for(table, identity)
    try:
        payload = json.loads(body)
    except ValueError:
        return 400, {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}}, ()
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
        answer = await _answer_mcp(message, table, lambda meta, key=key: _tool_context(meta, key, identity), server_name, inline)
        replies.append({"jsonrpc": "2.0", "id": message["id"], **answer})
    if not replies:
        return 202, None, ()
    return 200, replies if isinstance(payload, list) else replies[0], ()


def serve_tools(tools, *, runtime, tenant=None, audience=None, issuer=None, metadata=True, http=None, server_name="agent-runtime-tools"):
    """Serve tools (@tool functions, a list or a dict) as a stateless MCP server over Streamable HTTP for
    the runtime to call with its identity tokens: an ASGI app (mount it in FastAPI or Starlette, or run it
    with uvicorn). Every call's ToolContext carries the verified identity; requests without a valid token
    get a 401. `audience` is your server's URL as the runtime calls it (or a list of those); by default the
    request's URL. For WSGI (Django, Flask), camelai_run.sync.serve_tools. `tools` may also be a function of the caller's
    identity (a RuntimeIdentity) returning them, sync or async, to offer each agent or user its own tools."""
    _require_tenant(tenant)
    table = _tool_table(tools)
    issuer = _issuer_of(runtime, issuer)

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
        path = scope.get("root_path", "") + scope["path"]
        origin = f"{scope.get('scheme', 'http')}://{headers.get('host', 'localhost')}"

        async def respond(status, body=None, extra=()):
            data = b"" if body is None else json.dumps(body).encode()
            response_headers = [(b"content-type", b"application/json")] if body is not None else []
            await send({"type": "http.response.start", "status": status, "headers": response_headers + [(name.encode(), value.encode()) for name, value in extra]})
            await send({"type": "http.response.body", "body": data})

        early = _tool_server_response(scope["method"], scope["path"], origin, metadata, issuer, server_name)
        if early:
            return await respond(*early)
        body = b""
        while True:
            event = await receive()
            body += event.get("body", b"")
            if not event.get("more_body"):
                break
        try:
            identity = await verify_runtime_token(_bearer(headers.get("authorization")), runtime=runtime, tenant=tenant, audience=audience or f"{origin}{path}", issuer=issuer, http=http)
        except RuntimeTokenError as error:
            return await respond(*_unauthorized(error, origin, path, metadata))
        return await respond(*await _tool_server_answer(body, table, identity, server_name))

    return app


# Webhooks ------------------------------------------------------------------------------------------
# The runtime signs each webhook request per Standard Webhooks (see the webhooks guide): webhook-id,
# webhook-timestamp and webhook-signature, "v1,<base64 HMAC-SHA256 of "<id>.<timestamp>.<body>">".


class WebhookVerificationError(Exception):
    """A webhook request that is not the runtime's: unsigned, signed with another secret, or sent too long ago."""


def verify_webhook(body, headers, secret, *, tolerance=300, now=None):
    """Verify a webhook request from the runtime and return its event ({"id", "type", "created", "data"}).
    `body` is the request's raw body (bytes or str) as it arrived: verify it before parsing it. `headers` are its
    headers (any mapping, in any case: Flask's or Django's request.headers, a dict). `secret` is the endpoint's signing
    secret (whsec_...), or a list of secrets while you move to a new one. The signature is compared in constant time, and
    webhook-timestamp must be within `tolerance` seconds (default 300) of now, so an old request cannot be replayed.
    A retried event keeps its id: dedupe by it. Raises WebhookVerificationError."""
    import hashlib
    import hmac
    import time
    given = {str(name).lower(): value for name, value in headers.items()}
    webhook_id, timestamp, signatures = given.get("webhook-id"), given.get("webhook-timestamp"), given.get("webhook-signature")
    if not webhook_id or not timestamp or not signatures:
        raise WebhookVerificationError("Missing webhook-id, webhook-timestamp or webhook-signature")
    try:
        sent = int(timestamp)
    except ValueError:
        raise WebhookVerificationError("Invalid webhook-timestamp") from None
    if abs((time.time() if now is None else now) - sent) > tolerance:
        raise WebhookVerificationError("webhook-timestamp is too far from now")
    data = body.encode() if isinstance(body, str) else bytes(body)
    signed = f"{webhook_id}.{timestamp}.".encode() + data
    offered = [value for version, _, value in (part.partition(",") for part in signatures.split(" ")) if version == "v1" and value]
    for each in [secret] if isinstance(secret, str) else secret:
        encoded = each[len("whsec_"):] if each.startswith("whsec_") else each
        try:
            key = base64.b64decode(encoded + "=" * (-len(encoded) % 4), validate=True)
        except ValueError:
            raise WebhookVerificationError("The secret is not a whsec_ signing secret") from None
        expected = base64.b64encode(hmac.new(key, signed, hashlib.sha256).digest()).decode()
        if any(hmac.compare_digest(value.encode(), expected.encode()) for value in offered):
            try:
                return json.loads(data)
            except ValueError:
                raise WebhookVerificationError("The body is not JSON") from None
    raise WebhookVerificationError("No signature verifies with the secret")


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
        # Its tokens name tenant "test" unless told otherwise.
        self.options = {"runtime": self.url, "http": self.http, "tenant": "test"}

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

    def file_url(self, *, expires_in=300, header=None, **claims):
        """A file URL as the runtime would send a tool, for verify_file_url to check; `claims` set what it grants.
        Only checking works: nothing serves it."""
        grant = {"tenant": "test", "agent": "client_test", "call": "call_test", "tool": "app__tool", "volume": "vol_test",
                 "path": "/report.pdf", "agentPath": "/workspace/report.pdf", "kind": "file", "version": 1, **claims}
        token = self.token("camelrun:file", tenant=grant["tenant"], agent=grant["agent"], expires_in=expires_in, claims=grant,
                           header={"typ": "file+jwt", **(header or {})})
        return f"{self.url}/v1/files/{token}/{quote(grant['path'].rsplit('/', 1)[-1] or 'file')}"

    async def post(self, app, url, message, token=None, **identity):
        """POST a JSON-RPC message to an ASGI app at `url`, with a token for `identity` (or `token`; "" for none)."""
        token = self.token(url, **identity) if token is None else token
        headers = {"Content-Type": "application/json", **({"Authorization": f"Bearer {token}"} if token else {})}
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app)) as client:
            return await client.post(url, json=message, headers=headers)

    async def call_tool(self, app, url, name, arguments, idempotency_key=None, **identity):
        """Call one tool through an ASGI app as `identity`: its CallToolResult, or the error raised. Each call carries its
        own idempotency key, as each of the runtime's calls does; pass `idempotency_key` to send one again."""
        meta = {"agent-runtime/idempotencyKey": idempotency_key or str(uuid.uuid4())}
        response = await self.post(app, url, {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": arguments, "_meta": meta}}, **identity)
        body = response.json()
        if response.status_code != 200:
            raise RuntimeError(f"HTTP {response.status_code}: {body.get('error')}")
        if "error" in body:
            raise RuntimeError(body["error"]["message"])
        return body["result"]
