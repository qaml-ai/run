"""camelRun's Python SDK for synchronous code (a script, a Django or Flask view, a Celery task): camelai_run's names,
with plain calls instead of awaited ones.

    from camelai_run.sync import Agents

    with Agents() as agents:  # CAMELAI_API_KEY
        agent = agents.upsert("support-triage", model="anthropic/claude-sonnet-5-5", instructions="...")
        print(agent.run("Summarize ticket 123").text)

It runs agents and stateless runs and streams them, and manages the tenant (definitions, providers, key scopes, API
tokens, usage, webhooks, telemetry). Tools that run in a process need it to hold the agent's connection, which only the
async SDK does: here serve tools over HTTP (serve_tools, a WSGI app) and name them in a definition, or let a process
with the async SDK serve the tools an upsert declares. One Agents is for one thread at a time.
"""
import asyncio
from http import HTTPStatus
import json
import math
import time
import uuid
from urllib.parse import quote

import httpx

from . import (
    DEFAULT_URL, AgentError, Download, InputDetail, InputRequired, Mount, WorkspaceMount, Run, RunError, RuntimeIdentity, RuntimeTokenError, StreamPart,
    Telemetry, Tool, ToolContext, Transcriptions, Images, WebhookVerificationError, identity_from_claims, tool, verify_webhook,
    _AgentCalls, _DEFAULT, _PartReader, _RuntimeCalls, _Session, _TRANSCRIPTION_TIMEOUT, _UPLOAD_TIMEOUT, _answer_for, _attachment, _bearer,
    _check_request_id, _env, _error, _file_claims, _file_token, _http_sync, _issuer_of, _message_params, _origin, _outcome_run, _output_request,
    _prompt_extra, _public_key_sync, _require_tenant, _retry_after, _run_frame, _sender, _sse_frames,
    _stateless_run, _steer_receipt, _token_header, _tool_server_answer, _tool_table, _tool_server_response, _trace_header, _unauthorized,
    _unique_name, _verified,
)
from . import AgentFiles as _AsyncFiles, RunInput as _AsyncInput, Runs as _AsyncRuns, TestRuntime as _AsyncTestRuntime

__all__ = [
    "Agents", "Agent", "Run", "RunInput", "InputDetail", "Mount", "WorkspaceMount", "RunStream", "StreamPart", "Runs", "StatelessRunStream",
    "tool", "Tool", "ToolContext", "InputRequired", "RuntimeIdentity", "identity_from_claims",
    "AgentError", "RunError", "AgentRuntime", "AgentClient", "AgentFiles", "Download", "Telemetry", "Transcriptions", "Images", "DEFAULT_URL",
    "serve_tools", "verify_runtime_token", "verify_file_url", "RuntimeTokenError", "TestRuntime", "verify_webhook", "WebhookVerificationError",
]


def _transfer(client, method, url, **options):
    """camelai_run's _transfer, waiting in this thread: a 503, and for a read any server error or lost connection, is retried."""
    for attempt in range(4):
        try:
            response = client.request(method, url, **options)
            if attempt == 3 or not (response.status_code == 503 or (response.status_code >= 500 and method == "GET")):
                return response
        except httpx.TransportError:
            if attempt == 3 or method != "GET":
                raise
        time.sleep(0.1 * 2 ** attempt)


def _file_chunks(path):
    with open(path, "rb") as file:
        while chunk := file.read(1024 * 1024):
            yield chunk


class AgentRuntime(_RuntimeCalls):
    """The lower-level client, synchronous: provision agents and runs, and manage definitions, providers, key scopes, API
    tokens, usage, webhooks and telemetry, as camelai_run.AgentRuntime does. `url` defaults to CAMELAI_BASE_URL, else
    https://run.camelai.com; `api_key` to CAMELAI_API_KEY."""

    def __init__(self, url=None, api_key=None):
        self.base = _origin(url or _env("CAMELAI_BASE_URL", "AGENT_URL") or DEFAULT_URL)
        self.api_key = api_key or _env("CAMELAI_API_KEY", "AGENT_RUNTIME_TOKEN")
        self.http = httpx.Client(timeout=10, follow_redirects=False)
        # The tenant's OpenTelemetry trace export: get, set, clear, test.
        self.telemetry = Telemetry(self)
        # Speech to text on its own: create.
        self.transcriptions = Transcriptions(self)
        self.images = Images(self)

    def _form(self, path, fields, file):
        """A multipart POST with the API key (a transcription's audio), not retried: its answer."""
        response = self.http.post(self.base + path, data=fields, files=[file], headers={"Authorization": f"Bearer {self._operator()}"}, timeout=_TRANSCRIPTION_TIMEOUT)
        if not response.is_success:
            raise AgentError(_error(response), response.status_code)
        return response.json()

    def _rest(self, method, path, body=None, *, retry=True, headers=None, timeout=None, then=None, missing=_DEFAULT):
        """One request with the API key: its answer (`then` of it), or `missing` for a 404 when given."""
        try:
            value = _http_sync(self.http, self.base, path, self._operator(), method, body, retry, headers, timeout)
        except AgentError as error:
            if missing is not _DEFAULT and error.status == 404:
                return missing
            raise
        return then(value) if then else value

    def connect_agent(self, session, *, tools=()):
        """A client for an agent you hold the credentials of ({"id", "token"}). It holds no connection: each call is a
        request, and a run's outcome is waited for by asking for it. `tools` are what configure declares; it never serves them."""
        return AgentClient(self.base, session, tools)

    def wait_for_run(self, run_id, *, timeout=None):
        """A stateless run once it ends, however long it takes; `timeout` (seconds) stops the wait, not the run."""
        deadline = None if timeout is None else time.monotonic() + timeout
        while True:
            remaining = None if deadline is None else deadline - time.monotonic()
            if remaining is not None and remaining <= 0:
                raise AgentError("Stopped waiting; the run may still be running", request_id=run_id)
            run = self.get_run(run_id, wait=25 if remaining is None else min(25, max(1, math.ceil(remaining))))
            if run["status"] != "running":
                return run

    def run_events(self, run_id, *, last_event_id=None):
        """A run's event stream, to its end (its "response" frame), as {"id", "data"}: reconnecting with Last-Event-ID
        where the connection drops, so no event is missed or repeated where the stream still has them."""
        cursor, failures = last_event_id or 0, 0
        while True:
            headers = {"Authorization": f"Bearer {self._operator()}", "Accept": "text/event-stream", **({"Last-Event-ID": str(cursor)} if cursor else {})}
            try:
                with self.http.stream("GET", f"{self.base}/v1/runs/{quote(run_id, safe='')}/events", headers=headers, timeout=httpx.Timeout(10, read=60)) as response:
                    if not response.is_success:
                        response.read()
                        error = AgentError(_error(response), response.status_code, retry_after=_retry_after(response))
                        if response.status_code not in (502, 503) or failures >= 5:
                            raise error
                        failures += 1
                        time.sleep(error.retry_after or 0.25 * 2 ** failures)
                        continue
                    failures, buffer = 0, ""
                    for chunk in response.iter_text():
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
                time.sleep(0.25 * 2 ** failures)

    def close(self):
        self.http.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


def _result(request_id, outcome):
    """A request's result, or the AgentError its outcome is."""
    if "error" in outcome:
        raise AgentError(outcome["error"], request_id=request_id, code=outcome.get("code") if isinstance(outcome.get("code"), str) else None,
                         uncertain=bool(outcome.get("uncertain")))
    return outcome.get("result")


class AgentClient(_AgentCalls):
    """One agent, with its own token, synchronous: requests, and their outcomes, asked for (a long poll of up to 25 s at a
    time). It holds a connection only while a stream reads a run, and never serves tools."""

    def __init__(self, base, session, tools=()):
        import re
        if not re.fullmatch(r"client_[a-f0-9]{40}", session["id"]):
            raise ValueError("Invalid session id")
        self.base = _origin(base)
        # The agent's id (client_...): safe to log and to store.
        self.id = session["id"]
        # Its id and token: keep the token secret (it is left out of repr).
        self.session = _Session({key: session.get(key) for key in ("id", "token", "expiresAt")})
        self.tools = {item.name: item for item in tools}
        self.http = httpx.Client(timeout=10, follow_redirects=False)
        self.path = f"/clients/{session['id']}"

    def __repr__(self):
        return f"AgentClient(id={self.id!r})"

    def _http(self, suffix, method="GET", body=None, retry=True, timeout=None):
        return _http_sync(self.http, self.base, self.path + suffix, self.session["token"], method, body, retry, timeout=timeout)

    def _submit(self, method, params, request_id, traceparent=None):
        """Send a request (the same id again joins the first): its record."""
        _check_request_id(request_id)
        return _http_sync(self.http, self.base, self.path + "/requests", self.session["token"], "POST",
                          {"id": request_id, "method": method, "params": params or {}}, headers=_trace_header(traceparent))

    def _outcome(self, request_id, record=None, timeout=None):
        """A request's outcome ({"result"} or {"error", "code"?}): from its record, or asked for until it settles."""
        if record is not None and "outcome" in record:
            return record["outcome"]
        deadline = None if timeout is None else time.monotonic() + timeout
        backoff = 0.25
        while True:
            remaining = None if deadline is None else deadline - time.monotonic()
            if remaining is not None and remaining <= 0:
                raise AgentError("Stopped waiting; the request may still be running: request_status() or wait_for_request() observe it", request_id=request_id)
            try:
                record = self.request_status(request_id, wait=25 if remaining is None else min(25, max(1, math.ceil(remaining))))
            except AgentError as error:
                # A refusal for good (the token revoked, the agent gone) fails the wait; anything else is asked again.
                if error.status in (401, 403, 404, 410):
                    raise
                time.sleep(backoff)
                backoff = min(5, backoff * 2)
                continue
            except httpx.TransportError:
                time.sleep(backoff)
                backoff = min(5, backoff * 2)
                continue
            backoff = 0.25
            if "outcome" in record:
                return record["outcome"]

    def request(self, method, params=None, *, idempotency_key=None, timeout=None, traceparent=None):
        """Send a request and wait for its result, however long the run takes: `timeout` (seconds) only stops the wait;
        the request goes on. A runtime error raises AgentError. `traceparent` (a W3C trace context) makes the run
        continue the caller's trace when the tenant exports telemetry."""
        request_id = idempotency_key or str(uuid.uuid4())
        return _result(request_id, self._outcome(request_id, self._submit(method, params, request_id, traceparent), timeout))

    def wait_for_request(self, request_id, *, timeout=None):
        """Wait for a request already sent (by this process or another) to settle. This never submits or re-executes work."""
        return _result(request_id, self._outcome(request_id, timeout=timeout))

    def _attach(self, request_id, files):
        names, attached = set(), []
        for index, file in enumerate(files):
            entry = _attachment(index, file)
            if isinstance(entry, dict):
                attached.append(entry)
                continue
            name, data, content_type, extra = entry
            unique = _unique_name(names, name, index)
            response = self.http.put(f"{self.base}{self.path}/uploads/{quote(request_id, safe='')}/{quote(unique, safe='')}",
                                     content=data if isinstance(data, bytes) else _file_chunks(data),
                                     headers={"Authorization": f"Bearer {self.session['token']}", **({"Content-Type": content_type} if content_type else {})}, timeout=_UPLOAD_TIMEOUT)
            if not response.is_success:
                raise AgentError(_error(response), response.status_code)
            attached.append({"path": response.json()["path"], **extra})
        return attached

    def _prompt_params(self, request_id, text, *, actor=None, from_=None, files=None, metadata=None, while_running=None, allow_disconnected=False,
                       spend_limit=None, output=None, history=None, run_limits=None):
        attached = self._attach(request_id, files) if files else None
        return _message_params(text, attached, _prompt_extra(actor, while_running, allow_disconnected, spend_limit, output, history, run_limits), from_, metadata)

    def prompt(self, text, *, actor=None, from_=None, files=None, metadata=None, while_running=None, idempotency_key=None, allow_disconnected=False,
               spend_limit=None, output=None, history=None, timeout=None, traceparent=None):
        """Send a message and wait for the run's raw result ({"reply", "output", "error", "stopped", "inputs", ...}), as
        camelai_run.AgentClient.prompt. `files`: bytes, a local path, {"name", "data", "content_type"?} or {"path"}."""
        request_id = idempotency_key or str(uuid.uuid4())
        params = self._prompt_params(request_id, text, actor=actor, from_=from_, files=files, metadata=metadata, while_running=while_running,
                                     allow_disconnected=allow_disconnected, spend_limit=spend_limit, output=output, history=history)
        result = self.request("prompt", params, idempotency_key=request_id, timeout=timeout, traceparent=traceparent)
        # A steered message's request completes as the running turn takes it, naming the turn: its outcome is the turn's.
        if while_running == "steer" and isinstance(result, dict) and isinstance(result.get("steeredInto"), str) and "reply" not in result:
            return self.wait_for_request(result["steeredInto"], timeout=timeout)
        return result

    def steer_message(self, text, *, actor=None, from_=None, files=None, metadata=None, idempotency_key=None, allow_disconnected=False, traceparent=None):
        """Hand a message to the running turn and return as soon as the runtime has it: {"id", "status", "steeredInto"?},
        as camelai_run.AgentClient.steer_message."""
        request_id = idempotency_key or str(uuid.uuid4())
        params = self._prompt_params(request_id, text, actor=actor, from_=from_, files=files, metadata=metadata, while_running="steer", allow_disconnected=allow_disconnected)
        return _steer_receipt(self._submit("prompt", params, request_id, traceparent))

    def configure(self, *, model=None, system_prompt=None, thinking_level=None, tools=None, max_output_tokens=_DEFAULT, temperature=_DEFAULT):
        """Change the model, system prompt, thinking level, declared tools, max_output_tokens or temperature between runs (None
        removes either of the last two; this client never serves tools)."""
        params = {key: value for key, value in {"model": model, "systemPrompt": system_prompt, "thinkingLevel": thinking_level}.items() if value is not None}
        params.update({key: value for key, value in {"maxOutputTokens": max_output_tokens, "temperature": temperature}.items() if value is not _DEFAULT})
        if tools is not None:
            params["mcp"] = {"tools": [item.mcp_tool() for item in tools]}
            self.tools = {item.name: item for item in tools}
        return self.request("configure", params)

    def _follow(self, request_id, send):
        """Read the agent's events for `request_id`, sending it (send(): its record) once the stream is open, so nothing
        of it is missed: yields its events, and returns its outcome. A dropped stream is resumed with Last-Event-ID."""
        cursor, record, failures, hinted = 0, None, 0, False
        while True:
            try:
                with self.http.stream("GET", f"{self.base}{self.path}/events?snapshot=1&watch=1", timeout=20, headers={
                        "Authorization": f"Bearer {self.session['token']}", "Accept": "text/event-stream", "Last-Event-ID": str(cursor)}) as response:
                    if not response.is_success:
                        response.read()
                        raise AgentError(_error(response), response.status_code, retry_after=_retry_after(response))
                    failures, buffer, resumed = 0, "", record is not None
                    for chunk in response.iter_text():
                        frames, buffer = _sse_frames(buffer + chunk)
                        for lines, data in frames:
                            if "event: reconnect" in lines:
                                hinted = True
                                continue
                            id_line = next((line for line in lines if line.startswith("id:")), None)
                            if not data or "event: ready" in lines or id_line is None:
                                continue
                            event, at = json.loads(data), int(id_line[3:])
                            # A snapshot restarts the stream at its cursor: after a gap, the outcome may be in what was missed.
                            if event.get("type") == "snapshot":
                                cursor = at
                                if resumed:
                                    status = self.request_status(request_id)
                                    if "outcome" in status:
                                        return status["outcome"]
                                continue
                            if at <= cursor:
                                continue
                            cursor = at
                            if event.get("type") == "response" and event.get("id") == request_id:
                                return event["outcome"]
                            if event.get("type") == "event" and event.get("requestId") == request_id:
                                yield event["event"]
                        # The stream is open (its ready and snapshot read): send the request now.
                        if record is None:
                            record = send()
                            if "outcome" in record:
                                return record["outcome"]
            except httpx.TransportError:
                failures += 1
                if failures > 5:
                    raise
            except AgentError as error:
                failures += 1
                if error.status not in (502, 503) or failures > 5:
                    raise
            if record is not None and failures > 2:
                # A stream that keeps failing: ask for the outcome instead.
                return self._outcome(request_id)
            if not hinted:
                time.sleep(0.25 * 2 ** failures)
            hinted = False

    @property
    def files(self):
        """The agent's files, at the paths it sees them (/workspace/...): list, download, upload and link."""
        return AgentFiles(self)

    def destroy(self):
        try:
            self._http("", "DELETE")
        finally:
            self.close()

    def close(self):
        self.http.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


class AgentFiles(_AsyncFiles):
    """An agent's files with its own token: list, download, upload and link."""

    def _raw(self, method, path, **options):
        response = _transfer(self.agent.http, method, self._url(path), headers={"Authorization": f"Bearer {self.agent.session['token']}", **options.pop("headers", {})}, **options)
        if not response.is_success:
            raise AgentError(_error(response), response.status_code)
        return response

    def download(self, path):
        """The file: .data (bytes), .content_type and .version."""
        from . import _download
        return _download(self._raw("GET", path))

    def upload(self, path, data, *, content_type=None):
        """Write a file into a writable mount; without content_type the runtime sniffs it."""
        body = data.encode() if isinstance(data, str) else data
        return self._raw("PUT", path, content=body, headers={"Content-Type": content_type} if content_type else {}, timeout=_UPLOAD_TIMEOUT).json()


class RunInput(_AsyncInput):
    """Human input a run waits on (a dict: id, kind, message, detail...), with the means to answer it. answer() and
    decline() return the resumed run."""

    def answer(self, value, *, from_=None, throw_on_error=True, timeout=None):
        """approval or url: True or False; question: the label chosen (or labels, or your own words), or a dict of question
        to answer; form: its fields. `from_`: who answers (your user id, or {"id", "name"?})."""
        return self._agent._respond(self, _answer_for(self, value), from_, throw_on_error, timeout)

    def decline(self, *, from_=None, throw_on_error=True, timeout=None):
        return self._agent._respond(self, {"action": "decline"}, from_, throw_on_error, timeout)


class RunStream:
    """for part in agent.stream(text); `id` is the run's; result() is the run as `done` has it (reading the rest of the
    stream first). The message is sent when the loop starts. Breaking off stops the reading, not the run."""

    def __init__(self, agent, text, options):
        self.id = options.pop("idempotency_key", None) or str(uuid.uuid4())
        self._agent, self._text, self._throw, self._options = agent, text, options.pop("throw_on_error", True), options
        self._run, self._started = None, False

    def __iter__(self):
        if self._started:
            raise AgentError("A run's stream is read once: result() has the run")
        self._started = True
        agent, options = self._agent, dict(self._options)
        output, timeout, traceparent = options.pop("output", None), options.pop("timeout", None), options.pop("traceparent", None)
        user = options.pop("user", None)
        params = agent.client._prompt_params(self.id, self._text, from_=_sender(user) if user else None, output=_output_request(output), **options)
        make_input = lambda input: RunInput(agent, input, output)
        reader = _PartReader(make_input)
        deadline = None if timeout is None else time.monotonic() + timeout
        follow = agent.client._follow(self.id, lambda: agent.client._submit("prompt", params, self.id, traceparent))
        try:
            while True:
                try:
                    event = next(follow)
                except StopIteration as done:
                    outcome = done.value
                    break
                yield from reader.read(event)
                if deadline is not None and time.monotonic() > deadline:
                    raise AgentError("Stopped waiting; the request may still be running", request_id=self.id)
        finally:
            follow.close()
        self._run = agent._settled(self.id, outcome, output, False)
        yield StreamPart("done", run=self._run)
        if self._run.error and self._throw:
            raise RunError(self._run)

    def result(self):
        if self._run is None:
            for _ in self:
                pass
        if self._run.error and self._throw:
            raise RunError(self._run)
        return self._run


class Agent:
    """A keyed agent (from Agents.upsert), synchronous. `id` is safe to log; `client` is the lower-level AgentClient."""

    def __init__(self, client, agents=None):
        self.client, self.id, self._agents = client, client.id, agents
        # For an agent fork() made: {"agentId", "atMessage"}.
        self.forked_from = None
        # From upsert and get: a hash of the agent's configuration (see camelai_run.Agent.config_hash).
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

    def run(self, text, *, user=None, files=None, metadata=None, idempotency_key=None, timeout=None, throw_on_error=True, while_running=None,
            allow_disconnected=False, spend_limit=None, output=None, traceparent=None, history=None, run_limits=None):
        """Send a message and wait for the run it starts: its reply, or the input it waits on. As camelai_run.Agent.run:
        `timeout` (seconds) only stops the wait, a failed run raises RunError unless throw_on_error=False, and the same
        idempotency_key returns the same run."""
        request_id = idempotency_key or str(uuid.uuid4())
        params = self.client._prompt_params(request_id, text, from_=_sender(user) if user else None, files=files, metadata=metadata, while_running=while_running,
                                            allow_disconnected=allow_disconnected, spend_limit=spend_limit, output=_output_request(output), history=history,
                                            run_limits=run_limits)
        record = self.client._submit("prompt", params, request_id, traceparent)
        return self._settled(request_id, self.client._outcome(request_id, record, timeout), output, throw_on_error, timeout)

    def _settled(self, request_id, outcome, output, throw_on_error, timeout=None):
        result = outcome.get("result")
        # A steered message's request completes as the running turn takes it: the run is that turn's.
        if isinstance(result, dict) and isinstance(result.get("steeredInto"), str) and "reply" not in result:
            request_id = result["steeredInto"]
            outcome = self.client._outcome(request_id, timeout=timeout)
        run = _outcome_run(request_id, outcome, output, lambda input: RunInput(self, input, output))
        if run.error and throw_on_error:
            raise RunError(run)
        return run

    def stream(self, text, *, user=None, files=None, metadata=None, idempotency_key=None, timeout=None, throw_on_error=True, while_running=None,
               allow_disconnected=False, spend_limit=None, output=None, traceparent=None, history=None):
        """Send a message and read the run as it happens: text as it is written, tool calls and results, the input it
        waits on and, last, "done" with the run."""
        return RunStream(self, text, {"user": user, "files": files, "metadata": metadata, "idempotency_key": idempotency_key, "timeout": timeout,
                                      "throw_on_error": throw_on_error, "while_running": while_running, "allow_disconnected": allow_disconnected,
                                      "spend_limit": spend_limit, "output": output, "traceparent": traceparent, "history": history})

    def _respond(self, input, answer, from_, throw_on_error, timeout):
        audience = (input.get("responders") or {}).get("audience")
        if audience and not from_:
            raise AgentError(f"Say who answers (from_): only {', '.join(audience)} may answer this")
        answered = self.client.answer(input["id"], **answer, **({"from_": _sender(from_)} if from_ else {}))
        request = answered.get("request")
        if request:
            return self._settled(request["id"], self.client._outcome(request["id"], timeout=timeout), input._output, throw_on_error, timeout)
        # Other inputs of the run still wait: it resumes once they are answered too.
        pending = [RunInput(self, other, input._output) for other in self.client.inputs(state="pending") if other["requestId"] == input["requestId"]]
        return Run(input["requestId"], "input_required", inputs=pending)

    def send(self, text, *, user=None, files=None, metadata=None, idempotency_key=None, allow_disconnected=False, spend_limit=None,
             output=None, traceparent=None, history=None, run_limits=None):
        """Send a message and return as soon as the runtime has it, without waiting for the run: {"id", "state"} (running
        or queued). Get its outcome later with wait(id), the agent's events, or a run.completed webhook."""
        request_id = idempotency_key or str(uuid.uuid4())
        params = self.client._prompt_params(request_id, text, from_=_sender(user) if user else None, files=files, metadata=metadata,
                                            allow_disconnected=allow_disconnected, spend_limit=spend_limit, output=_output_request(output), history=history,
                                            run_limits=run_limits)
        record = self.client._submit("prompt", params, request_id, traceparent)
        return {"id": record["id"], "state": record["state"]}

    def wait(self, request_id, *, timeout=None, throw_on_error=True):
        """A run sent with send, once it ends: as run answers (RunError if it failed, unless throw_on_error=False)."""
        return self._settled(request_id, self.client._outcome(request_id, timeout=timeout), None, throw_on_error, timeout)

    def pending_inputs(self):
        """Inputs waiting on people, across the agent's runs."""
        return [RunInput(self, input) for input in self.client.inputs(state="pending")]

    def history(self):
        """Its whole history: every message, oldest first (history_page reads a page at a time)."""
        return self.client.history()["messages"]

    def history_page(self, *, before=None, limit=50):
        return self.client.history_page(before=before, limit=limit)

    def steer(self, text, *, wait=False, **options):
        """A message for the running turn; returns a receipt {"id", "status", "steeredInto"?} as soon as the runtime has it.
        wait=True waits for the run that took it instead (run(text, while_running="steer"))."""
        if wait:
            return self.run(text, **options, while_running="steer")
        user = options.pop("user", None)
        unknown = set(options) - {"files", "metadata", "idempotency_key", "allow_disconnected", "traceparent"}
        if unknown:
            raise TypeError(f"steer() takes {', '.join(sorted(unknown))} only with wait=True")
        return self.client.steer_message(text, from_=_sender(user) if user else None, **options)

    def configure(self, *, model=None, instructions=None, thinking_level=None, tools=None, max_output_tokens=_DEFAULT, temperature=_DEFAULT):
        """Change its model, instructions, thinking level or declared tools between runs."""
        return self.client.configure(model=model, system_prompt=instructions, thinking_level=thinking_level, tools=tools, max_output_tokens=max_output_tokens, temperature=temperature)

    def abort(self, *, queued=None, children=None):
        """Stop the agent: its running turn, and the runs queued behind it unless queued="keep", and its background
        sub-agents unless children="keep"."""
        return self.client.abort(queued=queued, children=children)

    def fork(self, *, key=None, name=None, at_message=None, ttl_seconds=_DEFAULT, subject=None, context=None, instructions_append=None, model_headers=_DEFAULT):
        """A new agent with this one's configuration, a copy of its history and a fork of its workspace (see camelai_run.Agent.fork)."""
        if self._agents is None:
            raise AgentError("fork needs the Agents this agent came from (agents.upsert, get or agent)")
        return self._agents.fork(self.id, key=key, name=name, at_message=at_message, ttl_seconds=ttl_seconds, subject=subject, context=context,
                                 instructions_append=instructions_append, model_headers=model_headers)

    def schedule(self, *, text=None, code=None, at=None, in_seconds=None, every_seconds=None):
        """Wake the agent later with a message (text), or run code; every_seconds (at least 60) repeats it."""
        return self.client.schedule(text=text, code=code, at=at, in_seconds=in_seconds, every_seconds=every_seconds)

    def schedules(self):
        return self.client.schedules()

    def unschedule(self, schedule_id):
        return self.client.unschedule(schedule_id)

    def delete(self):
        """Delete the agent, its history and its files, for good."""
        self.client.destroy()

    def close(self):
        """Close this handle's HTTP connections; the agent and its runs go on in the runtime."""
        self.client.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


class StatelessRunStream:
    """for part in agents.runs.stream(input, ...): the run's text as it is written, tool calls and results, and last
    "done" with the run. `id` is the run's; result() is the run. Breaking off stops the reading, not the run."""

    def __init__(self, runtime, run_id, output, throw_on_error):
        self.id, self._runtime, self._output, self._throw = run_id, runtime, output, throw_on_error

    def result(self):
        return _stateless_run(self._runtime.wait_for_run(self.id), self._output, self._throw)

    def __iter__(self):
        reader = _PartReader()
        for frame in self._runtime.run_events(self.id):
            data = frame["data"]
            if data.get("type") == "response":
                break
            yield from reader.read(data.get("event") or {} if data.get("type") == "event" else {})
        run = _stateless_run(self._runtime.wait_for_run(self.id), self._output, False)
        yield StreamPart("done", run=run)
        if run.error and self._throw:
            raise RunError(run)


class Runs:
    """Stateless runs (POST /v1/runs): a configuration and an input in, a result out, nothing carried over. See Agents.run."""

    def __init__(self, runtime):
        self.runtime = runtime

    def create(self, input, *, idempotency_key=None, wait=None, traceparent=None, **config):
        """Start a run and return at once, still running (or, with `wait`, once it ends within it): its view as a dict."""
        return self.runtime.create_run(_AsyncRuns._request(input, **config), idempotency_key=idempotency_key, wait=wait, traceparent=traceparent)

    def get(self, run_id, *, wait=0):
        """A run by its id, as a dict: running, or how it ended. `wait` (seconds, at most 25) waits for it to end first."""
        return self.runtime.get_run(run_id, wait=wait)

    def abort(self, run_id):
        """Stop a running run: it ends failed, code "aborted"."""
        return self.runtime.abort_run(run_id)

    def delete(self, run_id):
        """Delete a run's result, events and messages now, before its retention ends."""
        return self.runtime.delete_run(run_id)

    def messages(self, run_id):
        return self.runtime.run_messages(run_id)

    def events(self, run_id, *, last_event_id=None):
        """A run's raw event stream, to its end; see stream for one read into text, tool calls and the result."""
        return self.runtime.run_events(run_id, last_event_id=last_event_id)

    def run(self, input, *, idempotency_key=None, throw_on_error=True, traceparent=None, timeout=None, **config):
        """Run and wait for its result: see Agents.run. `timeout` (seconds) stops the wait, not the run."""
        view = self.create(input, idempotency_key=idempotency_key, wait=True if timeout is None else min(timeout, 60), traceparent=traceparent, **config)
        if view["status"] == "running":
            view = self.runtime.wait_for_run(view["id"], timeout=None if timeout is None else max(0.0, timeout - 60))
        return _stateless_run(view, config.get("output"), throw_on_error)

    def stream(self, input=None, *, run_id=None, idempotency_key=None, throw_on_error=True, traceparent=None, **config):
        """Run, reading it as it happens (or, given run_id, follow that run). Returns a StatelessRunStream."""
        if run_id is None:
            run_id = self.create(input, idempotency_key=idempotency_key, traceparent=traceparent, **config)["id"]
        return StatelessRunStream(self.runtime, run_id, config.get("output"), throw_on_error)


class Agents:
    """Keyed agents you upsert and run, synchronous (camelai_run.Agents, for code that is not async).

        with Agents() as agents:
            agent = agents.upsert("support-triage", model="anthropic/claude-sonnet-5-5", instructions="...")
            print(agent.run("Hello").text)

    api_key defaults to CAMELAI_API_KEY; url to CAMELAI_BASE_URL, else https://run.camelai.com. Agent handles hold no
    connection: agent.run() waits for its outcome by asking for it, and agent.stream() reads the agent's events while
    it reads a run."""

    def __init__(self, api_key=None, *, url=None):
        self.runtime = AgentRuntime(url=url, api_key=api_key)
        # Stateless runs: create, get, stream, abort, delete, messages; Agents.run is the one-call form.
        self.runs = Runs(self.runtime)
        # Speech to text on its own: create(file or url=...). Audio attached to a message is transcribed without it.
        self.transcriptions = self.runtime.transcriptions
        self.images = self.runtime.images
        self._open = set()

    def run(self, input, **options):
        """A stateless run: a configuration and `input` in, its result (a Run) out, nothing carried over and no agent kept.
        Options as camelai_run.Agents.run's, and `timeout` (seconds) to stop waiting.

            run = agents.run("Ship on Friday?", instructions="Vote yes or no.", output=Vote)
        """
        return self.runs.run(input, **options)

    def upsert(self, key, *, model=None, instructions=None, tools=None, definition=None, thinking_level=None, subject=None, context=None,
               key_scope=None, spend_limit=None, run_limits=None, model_headers=None, mounts=None, remount=None, name=None, instructions_append=None, file_tools=None,
               builtins=None, delegate=None, code_mode=None, initial_messages=None, import_messages=None, max_output_tokens=None, temperature=None, mcp_servers=None):
        """The agent for `key`, made now if there is none, and set to this configuration if it differs (see
        camelai_run.Agents.upsert). `tools` are declared, never served here: a process with the async SDK serves them
        (Agents().get(key, tools=...)). Tools for serverless or many workers: serve_tools and a definition. An upsert
        sets the agent's tools to those given: get an agent another process serves tools for instead of upserting it.
        `initial_messages` (Pi messages) is the history it begins with, used only when the agent is made; `import_messages`
        ({"format": "anthropic" | "openai-responses" | "openai-chat", "messages": [...], "model"?}) is one in another API's
        format, which the runtime converts (not both). `mcp_servers` are MCP servers of its own, without credentials
        (auth {"type": "runtime"} or none)."""
        tools = list(tools or [])
        session = self.runtime.upsert_agent(key, tools=tools, definition=definition, system_prompt=instructions, model=model, thinking_level=thinking_level,
                                            subject=subject, context=context, key_scope=key_scope, spend_limit=spend_limit, run_limits=run_limits,
                                            model_headers=model_headers, mounts=mounts, remount=remount, name=name, system_prompt_append=instructions_append, file_tools=file_tools,
                                            builtins=builtins, delegate=delegate, code_mode=code_mode, initial_messages=initial_messages, import_messages=import_messages,
                                            max_output_tokens=max_output_tokens, temperature=temperature, mcp_servers=mcp_servers)
        agent = self.agent(session, tools=tools)
        agent.config_hash = session.get("configHash")
        return agent

    def get(self, key_or_id):
        """The existing agent with this key (or id), without changing it. AgentError with status 404 when there is none."""
        session = self.runtime.agent_credentials(key_or_id)
        agent = self.agent(session)
        agent.config_hash = session.get("configHash")
        return agent

    def fork(self, agent_id, *, key=None, name=None, at_message=None, ttl_seconds=_DEFAULT, subject=None, context=None, instructions_append=None, model_headers=_DEFAULT):
        """A new agent forked from `agent_id` (see camelai_run.Agent.fork)."""
        answer = self.runtime.fork_agent(agent_id, key=key, name=name, at_message=at_message, ttl_seconds=ttl_seconds, subject=subject,
                                         context=context, instructions_append=instructions_append, model_headers=model_headers)
        agent = self.agent(answer)
        agent.forked_from = answer.get("forkedFrom")
        return agent

    def agent(self, session, *, tools=()):
        """An agent you hold the credentials of ({"id", "token"}, from another process say)."""
        agent = Agent(self.runtime.connect_agent(session, tools=tools), self)
        self._open.add(agent)
        return agent

    def close(self):
        """Close every handle's HTTP connections (the agents and their runs go on in the runtime)."""
        for agent in list(self._open):
            agent.close()
        self._open.clear()
        self.runtime.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


# Serving tools from a WSGI app (Django, Flask) ------------------------------------------------------


def verify_runtime_token(token, *, runtime, audience, tenant=None, issuer=None, http=None, clock_tolerance=30):
    """camelai_run.verify_runtime_token, synchronous: verify an identity token and return who the call is for (a
    RuntimeIdentity). `audience` is a string or a list; `http` an httpx.Client to read the runtime's keys with."""
    tenants = _require_tenant(tenant)
    pieces, header = _token_header(token)
    runtime = runtime.rstrip("/")
    key = _public_key_sync(f"{runtime}/.well-known/jwks.json", header["kid"], http)
    return _verified(pieces, key, runtime=runtime, audience=audience, tenants=tenants, issuer=issuer, clock_tolerance=clock_tolerance)


def verify_file_url(url, *, runtime, tenant=None, agent=None, issuer=None, http=None, clock_tolerance=30):
    """camelai_run.verify_file_url, synchronous: check that a file URL a tool was sent came from the runtime, for the
    tenant and agent you expect, and has not expired; returns what it grants. `http` is an httpx.Client to read the runtime's keys with."""
    runtime = runtime.rstrip("/")
    pieces, header = _token_header(_file_token(url, runtime))
    key = _public_key_sync(f"{runtime}/.well-known/jwks.json", header["kid"], http)
    return _file_claims(pieces, key, runtime=runtime, tenant=tenant, agent=agent, issuer=issuer, clock_tolerance=clock_tolerance)


def serve_tools(tools, *, runtime, tenant=None, audience=None, issuer=None, metadata=True, http=None, server_name="agent-runtime-tools"):
    """Serve tools (@tool functions, a list or a dict) as camelai_run.serve_tools does, as a WSGI app: mount it in
    Django or Flask, or run it with any WSGI server. Plain functions run in the request's thread (with its database
    connection); async ones in an event loop of the request's own. Every call's ToolContext carries the verified
    identity; requests without a valid token get a 401. `audience` is your server's URL as the runtime calls it (or a
    list of those); by default the request's URL. `http` is an httpx.Client to read the runtime's keys with."""
    _require_tenant(tenant)
    table = _tool_table(tools)
    issuer = _issuer_of(runtime, issuer)

    def app(environ, start_response):
        headers = {name[5:].replace("_", "-").lower(): value for name, value in environ.items() if name.startswith("HTTP_")}
        script, path_info = environ.get("SCRIPT_NAME", ""), environ.get("PATH_INFO", "") or "/"
        path = script + path_info
        origin = f"{environ.get('wsgi.url_scheme', 'http')}://{headers.get('host') or environ.get('SERVER_NAME', 'localhost')}"

        def respond(status, body=None, extra=()):
            data = b"" if body is None else json.dumps(body).encode()
            start_response(f"{status} {HTTPStatus(status).phrase}", [*([("Content-Type", "application/json")] if body is not None else []), *extra,
                                                                    ("Content-Length", str(len(data)))])
            return [data]

        early = _tool_server_response(environ.get("REQUEST_METHOD", "GET"), path_info, origin, metadata, issuer, server_name)
        if early:
            return respond(*early)
        try:
            length = int(environ.get("CONTENT_LENGTH") or 0)
        except ValueError:
            length = 0
        body = environ["wsgi.input"].read(length) if length > 0 else b""
        try:
            identity = verify_runtime_token(_bearer(headers.get("authorization")), runtime=runtime, tenant=tenant, audience=audience or f"{origin}{path}", issuer=issuer, http=http)
        except RuntimeTokenError as error:
            return respond(*_unauthorized(error, origin, path, metadata))
        return respond(*asyncio.run(_tool_server_answer(body, table, identity, server_name, inline=True)))

    return app


class TestRuntime(_AsyncTestRuntime):
    """camelai_run.TestRuntime for WSGI apps: signs identity tokens with a key of its own, and serves that key to
    camelai_run.sync's serve_tools / verify_runtime_token through `http` (an httpx.Client).

        runtime = TestRuntime()
        app = serve_tools(tools, **runtime.options)
        result = runtime.call_tool(app, "https://app.test/mcp", "list_todos", {}, subject="alice")
    """
    __test__ = False

    def __init__(self, url="https://runtime.test"):
        super().__init__(url)
        jwks = f"{self.url}/.well-known/jwks.json"
        self.http = httpx.Client(transport=httpx.MockTransport(
            lambda request: httpx.Response(200, json={"keys": [self.jwk]}) if str(request.url) == jwks else httpx.Response(404)))
        self.options = {"runtime": self.url, "http": self.http, "tenant": "test"}

    def post(self, app, url, message, token=None, **identity):
        """POST a JSON-RPC message to a WSGI app at `url`, with a token for `identity` (or `token`; "" for none)."""
        token = self.token(url, **identity) if token is None else token
        headers = {"Content-Type": "application/json", **({"Authorization": f"Bearer {token}"} if token else {})}
        with httpx.Client(transport=httpx.WSGITransport(app=app)) as client:
            return client.post(url, json=message, headers=headers)

    def call_tool(self, app, url, name, arguments, idempotency_key=None, **identity):
        """Call one tool through a WSGI app as `identity`: its CallToolResult, or the error raised. Each call carries its
        own idempotency key, as each of the runtime's calls does; pass `idempotency_key` to send one again."""
        meta = {"agent-runtime/idempotencyKey": idempotency_key or str(uuid.uuid4())}
        response = self.post(app, url, {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": arguments, "_meta": meta}}, **identity)
        body = response.json()
        if response.status_code != 200:
            raise RuntimeError(f"HTTP {response.status_code}: {body.get('error')}")
        if "error" in body:
            raise RuntimeError(body["error"]["message"])
        return body["result"]
