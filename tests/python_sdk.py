"""Run with: python3 tests/python_sdk.py (requires httpx)."""
import io
import tarfile
import asyncio
import base64
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlencode, urlsplit, urlunsplit

import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "clients" / "python"))
from camelai_run import AgentClient, _answer_for, _origin, AgentError, AgentRuntime, Agents, RunError, Runs, RuntimeTokenError, TestRuntime, ToolContext, WebhookVerificationError, _answer_mcp, _tool_context, serve_tools, tool, verify_file_url, verify_runtime_token, verify_webhook
from camelai_run import sync
from camelai_run.projects import Projects, file_bytes, publish_tool

DATABASE_URL = os.environ.get("AGENT_TEST_DATABASE_URL", "postgres://postgres:test@127.0.0.1:55432/postgres")


PNG = bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13]) + b"IHDR" + bytes([0, 0, 0, 2, 0, 0, 0, 3, 8, 2, 0, 0, 0])


def fake_model(bodies, script=None):
    """An OpenAI-compatible model on localhost that answers with `script`'s deltas in turn, then "seen", and keeps each request body."""
    script = script if script is not None else []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            bodies.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
            if script and "httpStatus" in script[0]:
                # A provider refusing the request.
                refusal = script.pop(0)
                body = json.dumps({"error": {"message": refusal["message"], "type": "invalid_request_error"}}).encode()
                self.send_response(refusal["httpStatus"])
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            delta = dict(script.pop(0)) if script else {"role": "assistant", "content": "seen"}
            # A slow model: `delayMs` before it answers.
            time.sleep(delta.pop("delayMs", 0) / 1000)
            for delta, finish in ((delta, None), ({}, "tool_calls" if "tool_calls" in delta else "stop")):
                self.wfile.write(f"data: {json.dumps({'id': 'fixture', 'object': 'chat.completion.chunk', 'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}]})}\n\n".encode())
            self.wfile.write(b"data: [DONE]\n\n")

        def log_message(self, *_):
            pass
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def database(statement):
    """Run one statement against the test database with the runtime's own driver."""
    script = "import pg from 'pg'; const c = new pg.Client(process.env.URL); await c.connect(); await c.query(process.env.SQL); await c.end();"
    subprocess.run(["node", "--input-type=module", "-e", script], cwd=ROOT, check=True,
                   env={"PATH": os.environ["PATH"], "URL": DATABASE_URL, "SQL": statement})


def otlp_receiver(requests):
    """An OTLP/HTTP traces receiver on localhost (send JSON to it): keeps each request's headers and decoded body."""

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = self.rfile.read(int(self.headers["Content-Length"]))
            requests.append({"path": self.path, "headers": {key.lower(): value for key, value in self.headers.items()},
                             "body": json.loads(body) if self.headers.get("Content-Type") == "application/json" else body})
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", "2")
            self.end_headers()
            self.wfile.write(b"{}")

        def log_message(self, *_):
            pass
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def webhook_receiver(deliveries):
    """A webhook endpoint on localhost: keeps each delivery's headers and raw body, and answers 200."""

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            deliveries.append({"headers": dict(self.headers.items()), "body": self.rfile.read(int(self.headers["Content-Length"]))})
            self.send_response(200)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def log_message(self, *_):
            pass
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


ASK = {"questions": [{"question": "Which region?", "header": "Region", "options": [{"label": "EU"}, {"label": "US"}]}]}


def trace_ids(requests):
    """Every span's (trace id, name) in the JSON exports received."""
    return [(span["traceId"], span["name"]) for request in requests if isinstance(request["body"], dict)
            for resource in request["body"]["resourceSpans"] for scope in resource["scopeSpans"] for span in scope["spans"]]


HELLO = (ROOT / "tests" / "fixtures" / "audio" / "hello.ogg").read_bytes()
# A 1024x1024 PNG's header (signature and IHDR): all the runtime reads of an image made or given to edit.
IMAGE = bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13]) + b"IHDR" + (1024).to_bytes(4, "big") * 2 + bytes([8, 6, 0, 0, 0, 0, 0, 0, 0])


def fake_transcriber(requests):
    """OpenAI's transcription endpoint on localhost (and the voice note at /hello.ogg): answers every audio with one
    transcript, keeping each request's model, file name and size. Its images endpoints answer with a 1024x1024 PNG
    header per image asked for (1,000 tokens each)."""

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Type", "audio/ogg")
            self.send_header("Content-Length", str(len(HELLO)))
            self.end_headers()
            self.wfile.write(HELLO)

        def do_POST(self):
            body = self.rfile.read(int(self.headers["Content-Length"]))
            form = httpx.Request("POST", "http://x", content=body, headers={"Content-Type": self.headers["Content-Type"]})
            requests.append({"key": self.headers["Authorization"], "type": self.headers["Content-Type"].split(";")[0], "bytes": len(body), "has_audio": HELLO[:64] in body, "path": self.path})
            if self.path.startswith("/images/"):
                n = int(json.loads(body)["n"]) if self.path == "/images/generations" else 1
                image = base64.b64encode(IMAGE).decode()
                answer = json.dumps({"data": [{"b64_json": image}] * n, "usage": {"input_tokens": 10, "input_tokens_details": {"text_tokens": 10, "image_tokens": 0}, "output_tokens": 1000 * n}}).encode()
            else:
                answer = json.dumps({"text": "Hello from camelRun.", "languages": [{"code": "en"}], "usage": {"type": "duration", "seconds": 5}}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(answer)))
            self.end_headers()
            self.wfile.write(answer)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


class PythonSDKTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="camelai-python-sdk-")
        self.token = "fixture-only-python-sdk-operator-token"
        # A schema of its own, so the runtime's tables start empty.
        self.schema = f"python_{secrets.token_hex(6)}"
        database(f"create schema {self.schema}")
        url = urlsplit(DATABASE_URL)
        # The tests run scripted code, never the model: the tenant's key is a placeholder.
        tenants = Path(self.directory.name) / "tenants.json"
        tenants.write_text(json.dumps({"tenants": {"python": {"tokenSha256": hashlib.sha256(self.token.encode()).hexdigest(), "apiKeys": {"openrouter": "unset"}}}}))
        self.bodies, self.script = [], []
        self.model = fake_model(self.bodies, self.script)
        self.transcribed = []
        self.transcriber = fake_transcriber(self.transcribed)
        self.host = await asyncio.create_subprocess_exec(
            "node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", str(ROOT / "src" / "server.ts"), stdout=asyncio.subprocess.PIPE,
            env={"PATH": os.environ["PATH"], "HOME": self.directory.name,
                 "AGENT_DATABASE_URL": urlunsplit(url._replace(query=urlencode({"options": f"-c search_path={self.schema}"}))),
                 "AGENT_DATA_DIR": self.directory.name, "AGENT_TENANTS_FILE": str(tenants), "AGENT_SESSION_SECRET": self.token, "PORT": "0",
                 "AGENT_PROVIDER": "openrouter", "AGENT_MODEL": "openai/gpt-4o-mini", "AGENT_BASE_URL": f"http://127.0.0.1:{self.model.server_port}/v1",
                 # Providers of the tenant's own: sealed keys, and the fake model server reachable as one.
                 "AGENT_SECRETS_KEY": "ab" * 32, "AGENT_OUTBOUND_ALLOW_HTTP": "true", "AGENT_OUTBOUND_ALLOW_CIDRS": "127.0.0.1/32",
                 # Trace export to a local OTLP receiver, flushed quickly.
                 "AGENT_TELEMETRY_INTERVAL_MS": "100",
                 # Transcription, on a local stand-in for OpenAI's.
                 "AGENT_TRANSCRIPTION_URL": f"http://127.0.0.1:{self.transcriber.server_port}",
                 "AGENT_IMAGES_URL": f"http://127.0.0.1:{self.transcriber.server_port}",
                 **({"AGENT_RUNTIME": os.environ["AGENT_RUNTIME"]} if "AGENT_RUNTIME" in os.environ else {})},
        )
        ready = json.loads(await asyncio.wait_for(self.host.stdout.readline(), 15))
        # Keep reading the host's log, so it never writes into a closed pipe as it shuts down.
        self.logs = asyncio.create_task(self.host.stdout.read())
        self.url = f"http://127.0.0.1:{ready['address']['port']}"
        self.model_url = f"http://127.0.0.1:{self.model.server_port}/v1"
        self.runtime = AgentRuntime(url=self.url, api_key=self.token)
        self.agents = Agents(self.token, url=self.url)
        # The SDK keeps no cursor store: a restarted client resumes from a snapshot.
        with self.assertRaises(TypeError):
            AgentRuntime(url=self.url, api_key=self.token, state_directory="sdk")

    async def make(self, tools=(), **options):
        """An agent made over REST (with `tools` declared), held by the simple interface."""
        created = await self.runtime.http.post(f"{self.url}/v1/agents", headers={"Authorization": f"Bearer {self.token}"},
                                               json={"ttlSeconds": None, "mcp": {"tools": [item.mcp_tool() for item in tools]}})
        self.assertEqual(created.status_code, 201, created.text)
        return await self.agents.agent(created.json(), tools=tools, **options)

    def call(self, name, arguments, call_id=None):
        """A scripted model turn that calls tool `name`."""
        self.script.append({"role": "assistant", "tool_calls": [{"index": 0, "id": call_id or f"call_{name}", "type": "function", "function": {"name": name, "arguments": json.dumps(arguments)}}]})

    async def test_delegate_settings_bring_their_builtin_and_a_run_names_its_child_and_streams_it(self):
        agent = await self.agents.upsert("coordinator", delegate={"instructions": True}, subagents=True)
        detail = (await self.runtime.http.get(f"{self.url}/v1/agents/{agent.id}", headers={"Authorization": f"Bearer {self.token}"})).json()
        self.assertEqual((detail["builtins"], detail["delegate"]), (["delegate"], {"instructions": True}))
        # The parent delegates, its child answers, then the parent does.
        self.call("delegate", {"instructions": "You help.", "task": "help"}, "call_delegate")
        self.script.append({"role": "assistant", "content": "helped"})
        self.script.append({"role": "assistant", "content": "done"})
        parts = [part async for part in agent.stream("go")]
        run = parts[-1].run
        self.assertEqual(run.text, "done")
        child = next(call for call in run.tool_calls if call["tool"] == "delegate")["agentId"]
        self.assertTrue(child.startswith("client_"))
        self.assertEqual([(part.type, part.agent_id) for part in parts if part.type.startswith("subagent_")], [("subagent_start", child), ("subagent_end", child)])
        self.assertIn("helped", json.dumps(self.bodies[-1]))

    async def test_lazy_handles_hold_no_stream_while_idle_run_without_one_and_stream_for_a_run(self):
        streaming = lambda agent: agent.client.runner is not None and not agent.client.runner.done()
        # 50 handles on 4 agents (a tenant runs a few agents at once): none holds a stream after upsert or get.
        keys = ["yes", "no", "maybe", "unsure"]
        handles = [await self.agents.upsert(key, instructions="Answer yes or no.") for key in keys]
        while len(handles) < 50:
            handles.append(await self.agents.get(keys[len(handles) % len(keys)]))
        self.assertFalse(any(streaming(agent) for agent in handles))
        runs = await asyncio.gather(*(agent.run("Is water wet?") for agent in handles[:4]))
        self.assertEqual([run.text for run in runs], ["seen"] * 4)
        self.assertFalse(any(streaming(agent) for agent in handles), "a run settles without a stream")
        # stream() connects for its run, sees it from the start, and lets the stream go once it ended.
        for attempt in range(2):
            self.script.append({"role": "assistant", "content": f"streamed {attempt}", "delayMs": 200})
            parts = [part async for part in handles[0].stream("go")]
            self.assertEqual([part.type for part in parts], ["text", "done"])
            self.assertEqual(parts[0].text, f"streamed {attempt}")
            await asyncio.sleep(0.05)
            self.assertFalse(streaming(handles[0]))
        # Handles that need the stream hold it from the start: on_event, or connection="eager".
        watched = await self.agents.get("yes", on_event=lambda event: None)
        eager = await self.agents.get("yes", connection="eager")
        self.assertTrue(streaming(watched) and streaming(eager))
        # A lazy run whose agent is deleted while it runs ends rather than waiting for good.
        slow = await self.agents.upsert("deleted-mid-run")
        self.script.append({"role": "assistant", "content": "late", "delayMs": 1500})
        pending = asyncio.ensure_future(slow.run("slow", throw_on_error=False))
        await asyncio.sleep(0.3)
        deleted = await self.runtime.http.delete(f"{self.url}/v1/agents/{slow.id}", headers={"Authorization": f"Bearer {self.token}"})
        self.assertEqual(deleted.status_code, 200)
        try:
            run = await asyncio.wait_for(pending, 10)
            self.assertEqual(run.status, "failed")
        except AgentError as error:
            self.assertIn(error.status, (404, 410))

    async def test_a_tool_process_that_dies_mid_run_the_restarted_one_serves_its_calls_and_the_same_key_fetches_it(self):
        @tool
        async def slow(value: str) -> dict:
            """Do something slowly"""
            started.set()
            await asyncio.Event().wait()

        @tool(name="slow")
        async def slow_next(value: str) -> dict:
            """Do something slowly"""
            return {"answer": f"restarted process {value}"}

        started = asyncio.Event()
        crashed, restarted = Agents(self.token, url=self.url), Agents(self.token, url=self.url)
        try:
            agent = await crashed.upsert("orphaned", tools=[slow])
            self.call("slow", {"value": "go"}, "call_1")
            # Told the call was cut off, the model calls it again, a second later.
            self.script.append({"role": "assistant", "tool_calls": [{"index": 0, "id": "call_2", "type": "function", "function": {"name": "slow", "arguments": json.dumps({"value": "again"})}}], "delayMs": 1000})
            self.script.append({"role": "assistant", "content": "done"})
            orphaned = asyncio.ensure_future(agent.run("go", idempotency_key="job-42"))
            await asyncio.wait_for(started.wait(), 10)
            await crashed.close(drain=0)
            await asyncio.gather(orphaned, return_exceptions=True)

            # The docs' recipe: serve the tools again, then collect the job's run by its key.
            agent = await restarted.upsert("orphaned", tools=[slow_next])
            run = await agent.run("go", idempotency_key="job-42")
            lost = [error for error in run.tool_errors if error["code"] == "connection_lost"]
            self.assertEqual((run.id, run.status, len(lost), lost[0]["tool"]), ("job-42", "completed", 1, "slow"))
            self.assertEqual([call["tool"] for call in run.tool_calls], ["slow", "slow"])
            self.assertIn("restarted process again", json.dumps(self.bodies[-1]))
        finally:
            await crashed.close(drain=0)
            await restarted.close(drain=0)

    async def test_steer_answers_once_the_runtime_has_it_and_abort_cancels_the_queue(self):
        agent = await self.agents.upsert("py-steer")
        # With no turn running, a steer starts one (queued); into a running turn it is accepted at once, not at the turn's end.
        self.script.append({"role": "assistant", "content": "first", "delayMs": 1500})
        self.script.append({"role": "assistant", "content": "with the steer"})
        self.assertEqual(await agent.steer("start", idempotency_key="py-steer-1"), {"id": "py-steer-1", "status": "queued"})
        while len(self.bodies) < 1:
            await asyncio.sleep(0.05)
        receipt = await agent.steer("also this", idempotency_key="py-steer-2")
        self.assertIn(receipt["status"], ("accepted", "taken"))
        self.assertEqual((await agent.client.wait_for_request("py-steer-1"))["reply"], "with the steer")
        # wait=True waits for the run that took it.
        self.assertEqual((await agent.steer("now", wait=True)).text, "seen")
        # A stop ends the running turn and cancels what waits behind it.
        self.script.append({"role": "assistant", "content": "slow", "delayMs": 3000})
        running = asyncio.create_task(agent.run("slow one", idempotency_key="py-slow", throw_on_error=False))
        while len(self.bodies) < 4:
            await asyncio.sleep(0.05)
        queued = asyncio.create_task(agent.run("queued", idempotency_key="py-queued", throw_on_error=False))
        while (await agent.client.status())["queuedRuns"] < 1:
            await asyncio.sleep(0.05)
        stopped = await agent.abort()
        self.assertEqual(stopped["cancelled"], ["py-queued"])
        self.assertEqual((await queued).error["code"], "cancelled")
        self.assertEqual((await running).status, "failed")
        self.assertFalse((await agent.client.status())["busy"])

    async def test_get_takes_an_existing_agent_by_key_or_id_without_changing_it(self):
        made = await self.agents.upsert("kept", instructions="Be terse.")
        by_key = await self.agents.get("kept")
        self.assertEqual(by_key.id, made.id)
        self.assertEqual((await self.runtime.http.get(f"{self.url}/v1/agents/{made.id}", headers={"Authorization": f"Bearer {self.token}"})).json()["systemPrompt"], "Be terse.")
        self.assertEqual((await by_key.run("hello")).text, "seen")
        self.assertEqual((await self.agents.get(made.id)).id, made.id)
        with self.assertRaises(AgentError) as missing:
            await self.agents.get("never-made")
        self.assertEqual(missing.exception.status, 404)

    async def test_fork_copies_the_agent_and_a_key_returns_the_same_fork(self):
        source = await self.agents.upsert("py-fork-source", instructions="Be terse.")
        await source.run("hello")
        fork = await source.fork(key="py-fork")
        self.assertNotEqual(fork.id, source.id)
        self.assertEqual(fork.forked_from, {"agentId": source.id, "atMessage": 1})
        self.assertEqual([message["role"] for message in await fork.history()], ["user", "assistant"])
        self.assertEqual((await source.fork(key="py-fork")).id, fork.id)
        detail = (await self.runtime.http.get(f"{self.url}/v1/agents/{fork.id}", headers={"Authorization": f"Bearer {self.token}"})).json()
        self.assertEqual((detail["systemPrompt"], detail["forkedFrom"]), ("Be terse.", {"agentId": source.id, "atMessage": 1}))
        early = await self.agents.fork(source.id, at_message=0, instructions_append="EARLY-APPEND")
        self.assertEqual((await self.runtime.http.get(f"{self.url}/v1/agents/{early.id}", headers={"Authorization": f"Bearer {self.token}"})).json()["systemPromptAppend"], "EARLY-APPEND")
        self.assertEqual(len(await early.history()), 1)
        self.assertAlmostEqual(early.session["expiresAt"] / 1000 - __import__("time").time(), 86400, delta=60)
        await fork.run("again")
        self.assertEqual(len(await source.history()), 2)

    async def test_a_deploy_loses_no_tool_call_close_finishes_the_calls_running(self):
        gate, started = asyncio.Event(), asyncio.Event()

        @tool
        async def slow(value: str) -> dict:
            """Do something slowly"""
            started.set()
            await gate.wait()
            return {"answer": f"old process {value}"}

        @tool(name="slow")
        async def slow_next(value: str) -> dict:
            """Do something slowly"""
            return {"answer": f"new process {value}"}

        old, fresh = Agents(self.token, url=self.url), Agents(self.token, url=self.url)
        try:
            agent = await old.upsert("deploy", tools=[slow])
            # The run's caller is elsewhere: the process serving the tools is the one deployed.
            caller = await self.agents.agent(agent.session)
            self.call("slow", {"value": "x"})
            running = asyncio.ensure_future(caller.run("go"))
            await asyncio.wait_for(started.wait(), 10)
            # The new process takes over, then the old one gets SIGTERM: it finishes the call it has before it disconnects.
            replacement = await fresh.upsert("deploy", tools=[slow_next], takeover=True)
            closing = asyncio.ensure_future(old.close())
            await asyncio.sleep(0.3)
            self.assertFalse(closing.done(), "close() waits for the call it has")
            gate.set()
            run = await running
            self.assertEqual(run.tool_errors, [])
            self.assertIn("old process x", json.dumps(self.bodies[-1]))
            await closing
            self.call("slow", {"value": "y"})
            await replacement.run("again")
            self.assertIn("new process y", json.dumps(self.bodies[-1]))
        finally:
            await old.close(drain=0)
            await fresh.close(drain=0)

    async def test_run_resolves_with_a_run_and_the_token_stays_out_of_logs(self):
        agent = await self.make()
        run = await agent.run("hello", user="u1")
        self.assertEqual((run.status, run.text, run.inputs, run.error), ("completed", "seen", [], None))
        self.assertTrue(agent.id.startswith("client_"))
        token = agent.session["token"]
        for shown in (repr(agent), repr(agent.session), str(agent.session), repr(agent.client)):
            self.assertNotIn(token, shown)
        with self.assertRaises(TypeError):
            json.dumps(agent.session)
        self.assertEqual(agent.session.credentials()["token"], token)
        scratch = await self.runtime.create_agent(tools=[])
        self.assertAlmostEqual(scratch.session["expiresAt"] / 1000 - __import__("time").time(), 86400, delta=60)
        durable = await self.runtime.create_agent(tools=[], idempotency_key="py-durable")
        self.assertIsNone(durable.session["expiresAt"])
        self.assertEqual(self.bodies[-1]["messages"][-1]["role"], "user")

    async def test_telemetry_set_get_test_clear_and_a_traceparent_continues_the_callers_trace(self):
        received = []
        receiver = otlp_receiver(received)
        self.addCleanup(receiver.server_close)
        self.addCleanup(receiver.shutdown)
        endpoint = f"http://127.0.0.1:{receiver.server_port}"
        telemetry = self.agents.runtime.telemetry
        self.assertIsNone(await telemetry.get())
        self.assertEqual(await telemetry.clear(), {"deleted": False})

        settings = await telemetry.set(endpoint, headers={"x-api-key": "otlp-python-secret"}, protocol="http/json", sample_rate=1, include_content=False)
        self.assertEqual({**settings, "createdAt": 0, "updatedAt": 0}, {
            "endpoint": f"{endpoint}/v1/traces", "protocol": "http/json", "sampleRate": 1, "include": {"content": False}, "headers": ["x-api-key"],
            "createdAt": 0, "updatedAt": 0, "setBy": "operator", "status": {"lastExportAt": None, "lastError": None, "lastErrorAt": None}})
        shown = await telemetry.get()
        self.assertEqual(shown["headers"], ["x-api-key"])
        self.assertNotIn("otlp-python-secret", json.dumps([settings, shown]))

        tested = await telemetry.test()
        self.assertTrue(tested["ok"], tested)
        for _ in range(100):
            if any(trace == tested["traceId"] for trace, _ in trace_ids(received)):
                break
            await asyncio.sleep(0.05)
        self.assertIn(tested["traceId"], [trace for trace, _ in trace_ids(received)])
        self.assertEqual(received[0]["headers"]["x-api-key"], "otlp-python-secret")

        # run(), stream() and the lower-level prompt() each send the caller's trace context.
        agent = await self.make()
        cases = [("a" * 31 + "1", lambda traceparent: agent.run("hi", traceparent=traceparent)),
                 ("b" * 31 + "2", lambda traceparent: agent.stream("hi", traceparent=traceparent).result()),
                 ("c" * 31 + "3", lambda traceparent: agent.client.prompt("hi", traceparent=traceparent, idempotency_key="low-level-traced"))]
        for trace_id, send in cases:
            result = await send(f"00-{trace_id}-00f067aa0ba902b7-01")
            request_id = getattr(result, "id", "low-level-traced")
            trace = (await agent.client.request_status(request_id))["trace"]
            self.assertEqual({**trace, "spanId": ""}, {"traceId": trace_id, "spanId": "", "parentSpanId": "00f067aa0ba902b7", "sampled": True})
        # A first prompt sent with the create continues the caller's trace too.
        created = await self.runtime.upsert_agent("traced-create", prompt={"text": "hello", "requestId": "first-traced"},
                                                  traceparent=f"00-{'d' * 31}4-00f067aa0ba902b7-01")
        self.assertEqual(created["prompt"]["trace"]["traceId"], "d" * 31 + "4")

        self.assertEqual(await telemetry.clear(), {"deleted": True})
        self.assertIsNone(await telemetry.get())
        after = await agent.run("after")
        self.assertNotIn("trace", await agent.client.request_status(after.id))

    async def test_a_failed_run_raises_run_error_or_returns_it(self):
        agent = await self.make()
        self.script.extend([{"httpStatus": 400, "message": "model says no"}, {"httpStatus": 400, "message": "model says no"}])
        with self.assertRaises(RunError) as failed:
            await agent.run("hi")
        self.assertEqual((failed.exception.code, failed.exception.run.status), ("model_error", "failed"))
        self.assertIn("model says no", str(failed.exception))
        run = await agent.run("again", throw_on_error=False)
        self.assertEqual((run.status, run.error["code"]), ("failed", "model_error"))

    async def test_stream_yields_tool_calls_results_text_then_done_and_plain_functions_are_tools(self):
        @tool(timeout=60)
        def lookup(sku: str, context: ToolContext) -> dict:
            """Look up a SKU (a plain function: it runs in a thread)"""
            context.progress("looking")
            return {"sku": sku, "key": context.idempotency_key}

        self.assertEqual(lookup.mcp_tool()["_meta"], {"agent-runtime/timeoutMs": 60000})

        @tool(exposure="direct")
        def render(text: str) -> dict:
            """Kept out of js_exec: the model calls it as a tool of its own"""
            return {}

        self.assertEqual(render.mcp_tool()["_meta"], {"agent-runtime/exposure": "direct"})
        with self.assertRaises(ValueError):
            tool(exposure="sometimes")
        agent = await self.make([lookup])
        self.call("lookup", {"sku": "A1"})
        stream = agent.stream("look up A1")
        parts = [part async for part in stream]
        self.assertEqual([part.type for part in parts], ["tool_call", "tool_result", "text", "done"])
        self.assertEqual((parts[0].name, parts[0].arguments), ("lookup", {"sku": "A1"}))
        self.assertEqual((parts[0].tool, parts[0].tool_call_id, parts[1].tool), ("lookup", parts[0].id, "lookup"), "run.tool_calls' names")
        result = json.loads(parts[1].output)
        self.assertEqual(result["sku"], "A1")
        self.assertRegex(result["key"], r"^[0-9a-f]{32}$", "the runtime's key for this call")
        self.assertEqual(parts[2].text, "seen")
        self.assertEqual(parts[3].run.text, "seen")
        self.assertEqual((await stream.result()).id, stream.id)

    async def test_async_and_slow_on_event_run_apart_from_the_connection(self):
        handled, errors = [], []

        async def slow(event, run_id):
            await asyncio.sleep(0.5)
            handled.append((event["type"], run_id))
            if event["type"] == "agent_start":
                raise ValueError("display broke")

        @tool
        async def echo(value: str) -> str:
            """Echo"""
            return value

        agent = await self.make([echo], on_event=slow, on_error=errors.append)
        for index in range(3):
            self.call("echo", {"value": f"v{index}"}, f"call_{index}")
        started = asyncio.get_running_loop().time()
        run = await agent.run("echo thrice")
        self.assertEqual(run.text, "seen")
        self.assertEqual(run.tool_calls, [{"tool": "echo", "toolCallId": f"call_{index}", "ok": True} for index in range(3)])
        self.assertLess(asyncio.get_running_loop().time() - started, 8, "the run did not wait for on_event")
        for _ in range(100):
            if any(isinstance(error, ValueError) for error in errors):
                break
            await asyncio.sleep(0.1)
        self.assertTrue(handled, "the async on_event ran")
        self.assertTrue(all(run_id == run.id for kind, run_id in handled if kind == "agent_start"))
        self.assertTrue(any("display broke" in str(error) for error in errors))

        # Closing stops on_event: the call in progress finishes, and the backlog is dropped.
        self.assertGreater(agent.client.events.qsize(), 0, "events were still queued")
        closing = asyncio.get_running_loop().time()
        await agent.close()
        self.assertLess(asyncio.get_running_loop().time() - closing, 1.5, "close waited only for the call in progress")
        at_close = len(handled)
        await asyncio.sleep(1.5)
        self.assertEqual(len(handled), at_close, "no queued event reached on_event after close")

    async def test_an_approval_answered_through_the_run_resumes_it(self):
        done = []

        @tool(needs_approval=True)
        async def wipe(disk: str):
            """Wipe a disk"""
            done.append(disk)

        agent = await self.make([wipe])
        self.call("wipe", {"disk": "d1"})
        run = await agent.run("wipe d1")
        self.assertEqual((run.status, run.inputs[0]["kind"]), ("input_required", "approval"))
        self.assertEqual(done, [])
        resumed = await run.inputs[0].answer(True)
        self.assertEqual((resumed.status, resumed.text, done), ("completed", "seen", ["d1"]))

    async def test_code_mode_false_history_none_and_config_hash(self):
        # A tool-less agent: no js_exec, no file tools; the same upsert again is the same configuration.
        agent = await self.agents.upsert("yes-no", instructions="Answer yes or no.", code_mode=False, file_tools=False)
        again = await self.agents.upsert("yes-no", instructions="Answer yes or no.", code_mode=False, file_tools=False)
        self.assertRegex(agent.config_hash, r"^[0-9a-f]{64}$")
        self.assertEqual(again.config_hash, agent.config_hash)
        self.assertEqual((await self.agents.get("yes-no")).config_hash, agent.config_hash)
        self.assertIn("configHash", next(item for item in await self.runtime.list_agents() if item["id"] == agent.id))
        await agent.run("First question")
        self.call("final_output", {"yes": True})
        run = await agent.run("Second question", history="none", output={"type": "object", "properties": {"yes": {"type": "boolean"}}, "required": ["yes"]})
        self.assertEqual(run.output, {"yes": True})
        body = self.bodies[-1]
        # Only the run's own message; final_output is the only tool, so it is forced from the first request.
        users = [message for message in body["messages"] if message["role"] == "user"]
        self.assertEqual(len(users), 1)
        self.assertIn("Second question", json.dumps(users[0]))
        self.assertEqual([item["function"]["name"] for item in body["tools"]], ["final_output"])
        self.assertEqual(body["tool_choice"], {"type": "function", "function": {"name": "final_output"}})
        self.assertNotIn("js_exec", json.dumps(body))

    async def test_max_output_tokens_and_temperature_go_on_model_calls_and_configure_removes_them(self):
        agent = await self.agents.upsert("py-settings", instructions="Be brief.", max_output_tokens=300, temperature=0.3)
        await agent.run("hi")
        body = self.bodies[-1]
        self.assertEqual((body.get("max_completion_tokens", body.get("max_tokens")), body.get("temperature")), (300, 0.3))
        await agent.configure(temperature=None)
        await agent.run("again")
        self.assertNotIn("temperature", self.bodies[-1])
        run = await self.agents.run("once", instructions="Be brief.", temperature=0.6, max_output_tokens=200)
        self.assertEqual(run.text, "seen")
        self.assertEqual(self.bodies[-1].get("temperature"), 0.6)

    async def test_run_with_output_returns_a_pydantic_model_or_the_json_schema_value(self):
        from typing import Literal
        from pydantic import BaseModel, field_validator

        class Item(BaseModel):
            name: str
            qty: int

        class Order(BaseModel):
            customer: str
            items: list[Item]
            priority: Literal["low", "high"] = "low"

        agent = await self.make()
        answer = {"customer": "Ada", "items": [{"name": "bolt", "qty": 3}]}
        self.call("final_output", answer)
        run = await agent.run("Read this order", output=Order)
        self.assertIsInstance(run.output, Order)
        self.assertEqual((run.output.customer, run.output.items[0].qty, run.output.priority), ("Ada", 3, "low"))
        # The model was given the model's JSON Schema, nested models ($defs) included.
        declared = next(item["function"] for item in self.bodies[-1]["tools"] if item["function"]["name"] == "final_output")
        self.assertEqual(declared["parameters"]["$defs"]["Item"]["required"], ["name", "qty"])

        # A JSON Schema dict gives the value as is; a validator the schema cannot say fails the run here.
        self.call("final_output", {"customer": "Bob", "items": []})
        plain = await agent.run("Again", output={"type": "object", "properties": {"customer": {"type": "string"}, "items": {"type": "array"}}, "required": ["customer"]})
        self.assertEqual(plain.output, {"customer": "Bob", "items": []})

        class Big(Order):
            @field_validator("items")
            @classmethod
            def some(cls, items):
                if not items:
                    raise ValueError("an order has items")
                return items

        self.call("final_output", {"customer": "Cy", "items": []})
        failed = await agent.run("Once more", output=Big, throw_on_error=False)
        self.assertEqual((failed.status, failed.error["code"]), ("failed", "output_invalid"))
        self.assertIn("an order has items", failed.error["message"])

        # Ended without final_output: output_missing. A run without output has none.
        with self.assertRaises(RunError) as missing:
            await agent.run("Say it in words", output=Order)
        self.assertEqual(missing.exception.code, "output_missing")
        self.assertIsNone((await agent.run("hi")).output)

    async def test_stateless_runs_one_call_stream_get_abort_and_no_agent_left(self):
        from typing import Literal
        from pydantic import BaseModel

        class Vote(BaseModel):
            vote: Literal["yes", "no"]

        self.call("final_output", {"vote": "yes"})
        run = await self.agents.run("Ship on Friday?", instructions="Vote yes or no.", output=Vote, metadata={"voter": "1"})
        self.assertEqual(run.status, "completed")
        self.assertIsInstance(run.output, Vote)
        self.assertEqual(run.output.vote, "yes")
        self.assertTrue(run.id.startswith("run_"))
        self.assertEqual(len([message for message in self.bodies[-1]["messages"] if message["role"] == "user"]), 1)
        again = await self.agents.runs.get(run.id)
        self.assertEqual((again["status"], again["metadata"]), ("completed", {"voter": "1"}))
        self.assertEqual([message["role"] for message in await self.agents.runs.messages(run.id)], ["user", "assistant", "toolResult"])
        # The same key is the same run.
        first = await self.agents.runs.create("Ship on Monday?", idempotency_key="k1", wait=True)
        self.assertEqual((await self.agents.runs.create("Ship on Monday?", idempotency_key="k1", wait=True))["id"], first["id"])

        self.call("js_exec", {"code": "return 1 + 1"})
        self.script.append({"role": "assistant", "content": "two"})
        stream = await self.agents.runs.stream("add", code_mode=True)
        parts = [part async for part in stream]
        self.assertEqual([part.type for part in parts], ["tool_call", "tool_result", "text", "done"])
        self.assertEqual(parts[-1].run.text, "two")
        self.assertEqual((await stream.result()).text, "two")

        self.script.append({"role": "assistant", "content": "too late", "delayMs": 5000})
        slow = await self.agents.runs.create("slow")
        self.assertEqual(slow["status"], "running")
        await asyncio.sleep(0.5)
        await self.agents.runs.abort(slow["id"])
        with self.assertRaises(RunError) as aborted:
            await (await self.agents.runs.stream(run_id=slow["id"])).result()
        self.assertEqual(aborted.exception.code, "aborted")
        listed = await self.runtime.http.get(f"{self.url}/v1/agents", headers={"Authorization": f"Bearer {self.token}"})
        self.assertEqual(listed.json(), [])

    async def test_parity_history_configure_tools_and_wait_for_request(self):
        agent = await self.make()
        # The same key sent again while its run goes on joins that run.
        first, again = await asyncio.gather(agent.run("one", idempotency_key="py-first", spend_limit={"usd": 5}), agent.run("one", idempotency_key="py-first", spend_limit={"usd": 5}))
        self.assertEqual(first.text, again.text)
        researcher = await self.agents.upsert("py-researcher", builtins=["web_fetch"])
        # A provider of one's own: here the fake model server (allowed by the operator's outbound policy).
        own = await self.runtime.set_provider("py-local", base_url=self.model_url, models=[{"id": "fixture-model", "contextWindow": 32768}])
        self.assertEqual(own["custom"]["models"][0]["id"], "fixture-model")
        on_own = await self.agents.upsert("py-own-model", model="py-local/fixture-model")
        self.assertEqual((await on_own.run("hi")).text, "seen")
        await self.runtime.delete_provider("py-local")
        self.assertEqual(next(entry["key"] for entry in await self.runtime.list_agents() if entry["id"] == researcher.id), "py-researcher")
        defined = await self.runtime.upsert_definition("py-researcher", name="Researcher", builtins=["web_search"])
        self.assertEqual((await self.runtime.upsert_definition("py-researcher", name="Researcher", builtins=["web_search"]))["revision"], defined["revision"])
        limited = await self.runtime.upsert_definition("py-limited", name="Limited", run_limits={"maxResponses": 20, "maxSeconds": 600})
        self.assertEqual(limited["runLimits"], {"maxResponses": 20, "maxSeconds": 600})
        self.assertEqual((await self.runtime.http.get(f"{self.url}/v1/agents/{researcher.id}", headers={"Authorization": f"Bearer {self.token}"})).json()["builtins"], ["web_fetch"])
        # MCP servers of its own, without credentials.
        server = {"name": "kb", "url": "http://127.0.0.1:9/mcp", "auth": {"type": "runtime"}}
        served = await self.agents.upsert("py-own-mcp", mcp_servers=[server])
        self.assertEqual((await self.runtime.http.get(f"{self.url}/v1/agents/{served.id}", headers={"Authorization": f"Bearer {self.token}"})).json()["mcpServers"], [server])
        with self.assertRaises(AgentError) as refused:
            await self.agents.upsert("py-own-mcp-bearer", mcp_servers=[{**server, "auth": {"type": "bearer", "token": "secret"}}])
        self.assertEqual(refused.exception.status, 400)
        self.assertEqual(Runs._request("hi", mcp_servers=[server])["mcpServers"], [server])
        joined = await asyncio.gather(agent.client.request("status", idempotency_key="py-status"), agent.client.request("status", idempotency_key="py-status"))
        self.assertEqual(joined[0], joined[1])
        page = await agent.history_page(limit=1)
        whole = await agent.history()
        self.assertIsInstance(whole, list, "the simple API's history is the list of messages")
        self.assertEqual(page["total"], len(whole))
        self.assertEqual((await agent.client.wait_for_request("py-first"))["reply"], first.text)
        # A request sent without waiting, then waited on with one long poll.
        await agent.client._http("/requests", "POST", {"id": "py-waited", "method": "prompt", "params": {"text": "waited"}})
        waited = await agent.client.request_status("py-waited", wait=25)
        self.assertEqual((waited["state"], waited["outcome"]["result"]["reply"]), ("completed", "seen"))

        @tool
        async def added(value: str) -> str:
            """A tool added later"""
            return f"added {value}"

        await agent.configure(tools=[added], instructions="Be brief.")
        self.assertEqual((await agent.client.execute('return await tools.added({value:"x"})'))["output"], ["added x"])
        self.assertEqual((await agent.run("later")).text, "seen")
        self.assertFalse(hasattr(agent, "follow_up") or hasattr(agent.client, "follow_up"))
        minted = await self.agents.runtime.browser_token(agent.id, ttl_seconds=60)
        self.assertEqual(minted["agentId"], agent.id)
        self.assertEqual((await self.runtime.http.get(f"{self.url}/v1/agents/{agent.id}/state", headers={"Authorization": f"Bearer {minted['token']}"})).status_code, 200)

    async def test_upsert_is_the_same_agent_for_a_key_and_one_process_serves_its_tools(self):
        @tool
        async def echo(value: str) -> str:
            """Echo"""
            return value

        first = await self.agents.upsert("py-shared", instructions="You are terse.", tools=[echo])
        self.assertEqual((await first.run("hi")).text, "seen")
        self.assertEqual((await self.agents.upsert("py-shared", instructions="You are terse.", tools=[echo], attach=False)).id, first.id)
        async with Agents(self.token, url=self.url) as other:
            with self.assertRaises(AgentError) as refused:
                await other.upsert("py-shared", instructions="You are terse.", tools=[echo])
        self.assertEqual(refused.exception.code, "APPLICATION_CONNECTED")
        errors = []
        first.client.on_error = errors.append
        second = Agents(self.token, url=self.url)
        try:
            taken = await second.upsert("py-shared", instructions="You are verbose.", tools=[echo], takeover=True)
            for _ in range(100):
                if any(getattr(error, "code", None) == "APPLICATION_REPLACED" for error in errors):
                    break
                await asyncio.sleep(0.05)
            self.assertTrue(any(getattr(error, "code", None) == "APPLICATION_REPLACED" for error in errors))
            await taken.run("again")
            self.assertIn("You are verbose.", json.dumps(self.bodies[-1]["messages"][0]))
            self.assertEqual((await taken.client.execute('return await tools.echo({value:"mine"})'))["output"], ["mine"])
        finally:
            await second.close()
        with self.assertRaises(AgentError):
            await self.agents.upsert("not a key!")

    async def test_connecting_with_changed_tools_declares_them_and_a_run_needs_them_served(self):
        @tool
        async def old(value: str) -> str:
            """Old"""
            return value

        @tool
        async def fresh(value: str) -> str:
            """Fresh"""
            return f"fresh {value}"

        created = (await self.runtime.http.post(f"{self.url}/v1/agents", headers={"Authorization": f"Bearer {self.token}"},
                                                json={"ttlSeconds": None, "mcp": {"tools": [old.mcp_tool()]}})).json()
        follower = await self.agents.agent(created)
        with self.assertRaises(AgentError) as refused:
            await follower.run("hi")
        self.assertEqual(refused.exception.code, "APPLICATION_NOT_CONNECTED")
        self.assertEqual((await follower.run("hi", allow_disconnected=True)).text, "seen")
        serving = await self.agents.agent(created, tools=[fresh])
        for _ in range(100):
            try:
                if (await serving.client.execute('return await tools.fresh({value:"x"})'))["output"] == ["fresh x"]:
                    break
            except AgentError:
                pass
            await asyncio.sleep(0.1)
        else:
            self.fail("the new tools were not declared")

    async def asyncTearDown(self):
        await self.agents.close()
        await self.runtime.close()
        self.host.terminate()
        await asyncio.wait_for(self.host.wait(), 10)
        await self.logs
        database(f"drop schema {self.schema} cascade")
        self.model.shutdown()
        self.model.server_close()
        self.transcriber.shutdown()
        self.transcriber.server_close()
        self.directory.cleanup()

    async def test_an_approval_answered_by_on_input_resumes_the_turn(self):
        wiped = []

        @tool(needs_approval=True)
        async def wipe(disk: str):
            """Wipe a disk"""
            wiped.append(disk)
            return {"wiped": disk}

        seen = []

        def approve(input):
            seen.append(input)
            return {"action": "accept", "actor": "ops"}

        self.script.append({"role": "assistant", "tool_calls": [{"index": 0, "id": "call_wipe", "type": "function", "function": {"name": "wipe", "arguments": json.dumps({"disk": "d1"})}}]})
        agent = await self.runtime.create_agent(tools=[wipe], on_input=approve)
        suspended = await agent.prompt("Wipe d1")
        self.assertEqual(suspended["stopped"], "input_required")
        for _ in range(200):
            if wiped and len(self.bodies) == 2:
                break
            await asyncio.sleep(0.05)
        self.assertEqual(wiped, ["d1"])
        self.assertEqual(seen[0]["kind"], "approval")
        self.assertEqual(seen[0]["detail"]["arguments"], {"disk": "d1"})
        self.assertEqual((await agent.inputs())[0]["answer"]["by"], {"via": "agent", "actor": "ops"})
        self.assertEqual(await agent.inputs(state="pending"), [])

    async def test_events_start_from_a_snapshot_and_updates_are_deltas(self):
        seen = []
        agent = await self.runtime.create_agent(tools=[], on_event=seen.append)
        self.assertEqual((await agent.prompt("hello"))["reply"], "seen")
        self.assertEqual(seen[0]["type"], "snapshot")
        self.assertIsNone(seen[0]["turn"])
        updates = [event for event in seen if event.get("type") == "message_update"]
        self.assertTrue(updates)
        for event in updates:
            self.assertNotIn("message", event)
            self.assertNotIn("partial", event["assistantMessageEvent"])
        self.assertEqual("".join(event["assistantMessageEvent"]["delta"] for event in updates if event["assistantMessageEvent"]["type"] == "text_delta"), "seen")

    async def test_annotations_reconnect_and_lost_acknowledgements(self):
        writes = []
        entered, release = asyncio.Event(), asyncio.Event()

        @tool
        async def save(value: str, context: ToolContext):
            """Save an application value and its idempotency key."""
            if value == "hold":
                entered.set()
                await release.wait()
            writes.append((value, context.call_id))
            return {"saved": value}

        self.assertEqual(save.parameters["properties"], {"value": {"type": "string"}})
        self.assertEqual(save.parameters["required"], ["value"])
        agent = await self.runtime.create_agent(tools=[save], system_prompt="You are the inventory planner.", name="Downtown cafe", type="inventory-planner")
        inspect = lambda: self.runtime.http.get(f"{self.runtime.base}/v1/agents/{agent.session['id']}", headers={"Authorization": f"Bearer {self.token}"})
        saved = (await inspect()).json()
        self.assertEqual(saved["systemPrompt"], "You are the inventory planner.")
        self.assertEqual((saved["name"], saved["type"]), ("Downtown cafe", "inventory-planner"))
        await agent.set_metadata(name="Uptown cafe", type="inventory-planner")
        saved = (await inspect()).json()
        self.assertEqual(saved["name"], "Uptown cafe")
        original = agent.http.request
        dropped = set()

        async def flaky_request(method, url, **kwargs):
            response = await original(method, url, **kwargs)
            suffix = str(url).split("/")[-1]
            if method == "POST" and suffix in ("requests", "mcp") and suffix not in dropped:
                dropped.add(suffix)
                raise ConnectionError("Simulated acknowledgement lost after server commit")
            return response

        agent.http.request = flaky_request
        script = 'return await tools.save({value:"once"})'
        first = await agent.execute(script, idempotency_key="stable-python-request")
        repeated = await agent.execute(script, idempotency_key="stable-python-request")
        self.assertEqual(first, repeated)
        self.assertEqual(len(writes), 1)
        self.assertEqual(dropped, {"requests", "mcp"})

        # Restart only the receive stream while the application callback is live: the call on
        # the old connection ends as unknown, and is not sent again.
        pending = asyncio.create_task(agent.execute('return await tools.save({value:"hold"})'))
        await asyncio.wait_for(entered.wait(), 5)
        agent.runner.cancel()
        await asyncio.gather(agent.runner, return_exceptions=True)
        agent.runner = None
        agent.ready.clear()
        await agent.connect()
        with self.assertRaisesRegex(Exception, "may or may not have taken effect"):
            await asyncio.wait_for(pending, 5)
        release.set()
        await asyncio.sleep(0.2)
        self.assertEqual(len(writes), 2)
        self.assertNotEqual(writes[0][1], writes[1][1])
        self.assertEqual(json.loads((await agent.execute(script))["output"][0]), {"saved": "once"}, "the new connection answers calls")

        # A result whose event never arrives is found by asking for the request's status.
        receive = agent._receive
        agent._receive = lambda event: None if event["type"] == "response" else receive(event)
        agent.poll_interval = 0.2
        self.assertEqual((await asyncio.wait_for(agent.execute('return "polled"'), 10))["output"][0], "polled")
        agent._receive = receive
        await agent.destroy()

    async def test_the_sync_client_upserts_runs_streams_answers_and_runs_statelessly(self):
        def scenario():
            with sync.Agents(self.token, url=self.url) as agents:
                agent = agents.upsert("py-sync", instructions="Be brief.", code_mode=True)
                self.assertEqual(agents.upsert("py-sync", instructions="Be brief.", code_mode=True).config_hash, agent.config_hash)
                run = agent.run("hello", user="u1", metadata={"thread": "t1"}, idempotency_key="py-sync-1")
                self.assertEqual((run.id, run.status, run.text, run.error), ("py-sync-1", "completed", "seen", None))
                # The same key is the same run, never a second one.
                calls = len(self.bodies)
                self.assertEqual(agent.run("hello", user="u1", metadata={"thread": "t1"}, idempotency_key="py-sync-1").text, "seen")
                self.assertEqual(len(self.bodies), calls)
                token = agent.session["token"]
                self.assertNotIn(token, repr(agent) + repr(agent.session) + repr(agent.client))

                # A stream: the tool call, its result, the text, then the run.
                self.call("js_exec", {"code": "return 1 + 1"})
                self.script.append({"role": "assistant", "content": "two"})
                stream = agent.stream("add")
                parts = list(stream)
                self.assertEqual([part.type for part in parts], ["tool_call", "tool_result", "text", "done"])
                self.assertEqual((parts[0].tool, parts[1].output, parts[-1].run.text, stream.result().text), ("js_exec", "2", "two", "two"))
                self.assertEqual(agent.stream("again").result().text, "seen")

                # Human input: the run waits on a question, and an answer resumes it.
                asker = agents.upsert("py-sync-ask", builtins=["ask_user"])
                self.call("ask_user", ASK)
                waiting = asker.run("deploy")
                self.assertEqual((waiting.status, waiting.inputs[0]["kind"]), ("input_required", "question"))
                self.assertEqual([item["id"] for item in asker.pending_inputs()], [waiting.inputs[0]["id"]])
                self.script.append({"role": "assistant", "content": "Deploying to EU"})
                resumed = waiting.inputs[0].answer("EU")
                self.assertEqual((resumed.status, resumed.text), ("completed", "Deploying to EU"))
                self.assertEqual(json.loads(self.bodies[-1]["messages"][-1]["content"])["answers"], {"Which region?": "EU"})

                # get takes the agent as it is; history, steer, a failed run.
                got = agents.get("py-sync")
                self.assertEqual((got.id, got.config_hash), (agent.id, agent.config_hash))
                self.assertEqual([message["role"] for message in got.history()][:2], ["user", "assistant"])
                self.assertEqual(got.history()[0]["metadata"], {"thread": "t1"})
                self.assertEqual(got.steer("now", idempotency_key="py-sync-steer"), {"id": "py-sync-steer", "status": "queued"})
                self.assertEqual(got.client.wait_for_request("py-sync-steer")["reply"], "seen")
                self.script.extend([{"httpStatus": 400, "message": "model says no"}, {"httpStatus": 400, "message": "model says no"}])
                with self.assertRaises(RunError) as failed:
                    got.run("hi")
                self.assertEqual(failed.exception.code, "model_error")
                self.assertEqual(got.run("again", throw_on_error=False).error["code"], "model_error")

                # Stateless runs: one call, and a stream.
                self.call("final_output", {"vote": "yes"})
                vote = agents.run("Ship on Friday?", instructions="Vote yes or no.", output={"type": "object", "properties": {"vote": {"type": "string"}}, "required": ["vote"]})
                self.assertEqual((vote.status, vote.output), ("completed", {"vote": "yes"}))
                self.assertEqual(agents.runs.get(vote.id)["status"], "completed")
                self.script.append({"role": "assistant", "content": "streamed"})
                parts = list(agents.runs.stream("hi"))
                self.assertEqual((parts[-1].type, parts[-1].run.text), ("done", "streamed"))
                self.assertEqual(agents.runs.messages(parts[-1].run.id)[0]["role"], "user")

                agent.delete()
                with self.assertRaises(AgentError) as gone:
                    agents.get("py-sync")
                self.assertEqual(gone.exception.status, 404)

        await asyncio.to_thread(scenario)

    async def test_send_returns_at_once_and_wait_gets_the_run(self):
        agent = await self.agents.upsert("py-send")
        sent = await agent.send("Go", idempotency_key="py-fire-1")
        self.assertEqual(sent["id"], "py-fire-1")
        self.assertIn(sent["state"], ("running", "queued", "completed"))
        self.assertEqual((await agent.wait(sent["id"])).status, "completed")

        def in_sync():
            with sync.Agents(self.token, url=self.url) as agents:
                handle = agents.upsert("py-send-sync")
                return handle.wait(handle.send("Go")["id"]).status
        self.assertEqual(await asyncio.to_thread(in_sync), "completed")

    async def test_initial_messages_begin_an_agents_history_when_it_is_made(self):
        imported = [{"role": "user", "content": "My name is Ada.", "timestamp": 1},
                    {"role": "assistant", "content": [{"type": "text", "text": "Hello, Ada."}], "api": "openai-completions", "provider": "openrouter", "model": "openai/gpt-4o-mini",
                     "usage": {"input": 1, "output": 1, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 2, "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0}},
                     "stopReason": "stop", "timestamp": 2}]
        agent = await self.agents.upsert("py-imported", initial_messages=imported)
        self.assertEqual([message["content"] for message in await agent.history()], [imported[0]["content"], imported[1]["content"]])
        await agent.run("What is my name?")
        self.assertIn("My name is Ada.", json.dumps(self.bodies[-1]))
        # Only when the agent is made: an upsert of the agent it names leaves its history.
        await self.agents.upsert("py-imported", initial_messages=[{"role": "user", "content": "Forget it."}])
        self.assertNotIn("Forget it.", json.dumps(await agent.history()))
        with self.assertRaises(AgentError) as refused:
            await self.agents.upsert("py-imported-bad", initial_messages=[{"role": "robot"}])
        self.assertEqual((refused.exception.status, refused.exception.code), (400, "INVALID_HISTORY"))

        def made_in_sync():
            with sync.Agents(self.token, url=self.url) as agents:
                return [message["content"] for message in agents.upsert("py-imported-sync", initial_messages=imported).history()]
        self.assertEqual(await asyncio.to_thread(made_in_sync), [imported[0]["content"], imported[1]["content"]])

    async def test_import_messages_converts_another_apis_conversation(self):
        conversation = {"format": "anthropic", "model": "anthropic/claude-sonnet-5", "messages": [
            {"role": "user", "content": "My name is Grace."},
            {"role": "assistant", "content": [{"type": "tool_use", "id": "toolu_1", "name": "remember", "input": {"name": "Grace"}}]},
            {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "toolu_1", "content": "REMEMBERED"}]},
            {"role": "assistant", "content": "Nice to meet you, Grace."}]}
        agent = await self.agents.upsert("py-import-anthropic", import_messages=conversation)
        self.assertEqual([message["role"] for message in await agent.history()], ["user", "assistant", "toolResult", "assistant"])
        await agent.run("What is my name?")
        self.assertIn("REMEMBERED", json.dumps(self.bodies[-1]))

        def made_in_sync():
            with sync.Agents(self.token, url=self.url) as agents:
                return [message["role"] for message in agents.upsert("py-import-sync", import_messages={"format": "openai-chat", "messages": [{"role": "user", "content": "hi"}]}).history()]
        self.assertEqual(await asyncio.to_thread(made_in_sync), ["user"])

    async def test_projects_publish_checked_snapshots_and_the_tool_finds_the_project_from_identity(self):
        projects = Projects(self.runtime)
        project = await projects.create("py-bot-1", template={"bot.py": "def run(): pass\n"})
        self.assertEqual((await projects.create("py-bot-1", template={"bot.py": "other"})).id, project.id)
        self.assertEqual(await project.volume.read_text("bot.py"), "def run(): pass\n")
        self.assertEqual(project.mount("/bot")["mounts"][1], {"workspace": True})
        check = lambda files: [{"path": file["path"], "message": "no secrets"} for file in files if "secret" in file["path"]]
        stored = []
        result = await project.publish(validate=check, store=lambda files, version, about: stored.append([file["path"] for file in files]))
        self.assertTrue(result["ok"])
        self.assertEqual(stored, [["/bot.py"]])
        self.assertEqual(file_bytes((await project.files(version=result["version"]["id"]))["files"][0]), b"def run(): pass\n")
        await project.volume.write("secret.py", "x = 1\n")
        self.assertEqual(await project.publish(validate=check, store=lambda *args: None), {"ok": False, "problems": [{"path": "/secret.py", "message": "no secrets"}]})
        self.assertEqual(len(await project.versions()), 1)
        # Restored in place to the published version: the secret goes, and the version stays.
        restored = await project.restore(result["version"]["id"])
        self.assertEqual((restored["written"], restored["removed"]), (0, 1))
        self.assertEqual([file["path"] for file in (await project.files())["files"]], ["/bot.py"])
        self.assertEqual(len(await project.versions()), 1)
        archive = tarfile.open(fileobj=io.BytesIO(await project.archive(version=result["version"]["id"])), mode="r:gz")
        self.assertEqual(archive.extractfile("bot.py").read(), b"def run(): pass\n")
        # A check may hand what it computed to store and the result.
        bundled = await project.publish(validate=lambda files: {"problems": [], "data": {"entries": len(files)}},
                                        store=lambda files, version, about: about["checked"])
        self.assertEqual((bundled["stored"], bundled["checked"]), ({"entries": 1}, {"entries": 1}))
        await project.volume.write("secret.py", "x = 1\n")
        # A pinned, labelled version; a snapshot made from contents leaves the volume alone.
        imported = await project.volume.snapshot(name="published:py-import", pinned=True, labels={"release": "v0"}, files={"/bot.py": "def old(): pass\n"})
        self.assertEqual((imported["pinned"], imported["labels"]), (True, {"release": "v0"}))
        self.assertEqual([version["id"] for version in await project.versions(labels={"release": "v0"})], [imported["id"]])
        self.assertEqual((await project.unpin(imported["id"]))["pinned"], False)
        self.assertEqual((await project.pin(imported["id"], labels={"release": "v0", "kept": "yes"}))["labels"], {"release": "v0", "kept": "yes"})
        with self.assertRaises(AgentError) as refused:
            await project.volume.delete_snapshot(imported["id"])
        self.assertEqual(refused.exception.status, 409)
        await project.volume.delete_snapshot(imported["id"], force=True)

        # The tool takes no arguments; the project comes from the call's identity.
        other = await projects.create("py-bot-2", template={"bot.py": "def two(): pass\n"})
        ids = {"1": project.id, "2": other.id}
        tests = TestRuntime()
        app = serve_tools([publish_tool(project=lambda identity: projects.get(ids[identity.context["bot"]]), validate=check,
                                        store=lambda files, version, about: stored.append([file["text"] for file in files]))], **tests.options)
        done = await tests.call_tool(app, "https://app.test/mcp", "publish", {}, subject="owner", context={"bot": "2"})
        self.assertFalse(done.get("isError"))
        self.assertEqual(stored[-1], ["def two(): pass\n"])
        refused = await tests.call_tool(app, "https://app.test/mcp", "publish", {}, subject="owner", context={"bot": "1"})
        self.assertTrue(refused["isError"])
        self.assertIn("/secret.py: no secrets", refused["content"][0]["text"])
        # No idempotency key and JSON-RPC id 1 every time: each publish is its own, not the first one's files again.
        bare = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "publish", "arguments": {}}}
        for text in ("def three(): pass\n", "def four(): pass\n"):
            await other.volume.write("bot.py", text)
            self.assertNotIn("error", (await tests.post(app, "https://app.test/mcp", bare, subject="owner", context={"bot": "2"})).json())
            self.assertEqual(stored[-1], [text])

    async def test_key_scopes_tokens_usage_webhooks_and_rotated_credentials(self):
        deliveries = []
        receiver = webhook_receiver(deliveries)
        try:
            scope = await self.runtime.set_scope_key("org-1", "openrouter", api_key="sk-or-fixture-1234")
            self.assertEqual((scope["scope"], scope["providers"][0]["provider"], scope["providers"][0]["last4"]), ("org-1", "openrouter", "1234"))
            self.assertNotIn("sk-or-fixture", json.dumps(await self.runtime.key_scope("org-1")))
            await self.runtime.set_scope_provider("org-1", "local", base_url=self.model_url, models=[{"id": "m1", "contextWindow": 8000}])
            self.assertEqual([item["id"] for item in await self.runtime.scope_providers("org-1")], ["local"])
            await self.runtime.delete_scope_provider("org-1", "local")
            await self.runtime.delete_scope_key("org-1", "openrouter")
            self.assertEqual((await self.runtime.key_scope("org-1"))["providers"], [])
            await self.runtime.delete_key_scope("org-1")

            made = await self.runtime.create_token("ci")
            self.assertTrue(made["token"])
            self.assertIn(made["id"], [item["id"] for item in await self.runtime.tokens()])
            self.assertNotIn(made["token"], json.dumps(await self.runtime.tokens()))
            self.assertEqual((await AgentRuntime(url=self.url, api_key=made["token"]).me())["tenant"], "python")

            endpoint = await self.runtime.create_webhook(f"http://127.0.0.1:{receiver.server_port}/hooks", ["run.completed"], description="test")
            self.assertTrue(endpoint["secret"].startswith("whsec_"))
            self.assertEqual([item["id"] for item in await self.runtime.webhooks()], [endpoint["id"]])
            self.assertEqual((await self.runtime.update_webhook(endpoint["id"], description="tests"))["description"], "tests")
            agent = await self.agents.upsert("py-hooked")
            run = await agent.run("hello", metadata={"thread": "t1"})
            for _ in range(200):
                if deliveries:
                    break
                await asyncio.sleep(0.05)
            delivery = deliveries[0]
            event = verify_webhook(delivery["body"], delivery["headers"], endpoint["secret"])
            self.assertEqual((event["type"], event["data"]["requestId"], event["data"]["metadata"]), ("run.completed", run.id, {"thread": "t1"}))
            with self.assertRaises(WebhookVerificationError):
                verify_webhook(delivery["body"], delivery["headers"], (await self.runtime.rotate_webhook_secret(endpoint["id"]))["secret"])
            self.assertEqual((await self.runtime.webhook(endpoint["id"]))["id"], endpoint["id"])
            await self.runtime.delete_webhook(endpoint["id"])
            self.assertEqual(await self.runtime.webhooks(), [])

            # A token revoked stops at once, and lists what it set that keeps sending.
            revoked = await self.runtime.revoke_token(made["id"])
            self.assertEqual(revoked["revoked"], True)
            with self.assertRaises(AgentError) as refused:
                await AgentRuntime(url=self.url, api_key=made["token"]).me()
            self.assertEqual(refused.exception.status, 401)

            usage = await self.runtime.usage(days=1)
            self.assertGreaterEqual(usage["totals"]["responses"], 1)

            rotated = await self.runtime.rotate_agent_credentials(agent.id)
            self.assertEqual(rotated["id"], agent.id)
            self.assertNotEqual(rotated["token"], agent.session["token"])
            fresh = await self.agents.agent(rotated)
            self.assertEqual((await fresh.run("again")).text, "seen")

            # The synchronous client has the same calls.
            def managed():
                with sync.AgentRuntime(url=self.url, api_key=self.token) as runtime:
                    runtime.set_scope_key("org-2", "openrouter", api_key="sk-or-fixture-5678")
                    providers = runtime.key_scope("org-2")["providers"]
                    runtime.delete_key_scope("org-2")
                    made = runtime.create_token("sync")
                    runtime.revoke_token(made["id"])
                    return providers[0]["last4"], runtime.usage()["totals"]["responses"] >= 1, runtime.me()["tenant"], runtime.telemetry.get()
            self.assertEqual(await asyncio.to_thread(managed), ("5678", True, "python", None))
        finally:
            receiver.shutdown()

    async def test_volumes_files_snapshots_and_mounts(self):
        created = await self.runtime.create_volume(name="shared docs")
        volume = self.runtime.volume(created["id"])
        written = await volume.write("/docs/readme.md", "hello volumes", version=0)
        with self.assertRaises(Exception) as stale:
            await volume.write("docs/readme.md", "stale", version=written["version"] + 1)
        self.assertEqual(stale.exception.status, 412)
        self.assertEqual(await volume.read_text("docs/readme.md"), "hello volumes")
        self.assertEqual((await volume.read("docs/readme.md", range=(6, 13)))[0], b"volumes")
        # A proxy that gzips weakens the ETag (W/"n"): the version comes from X-File-Version.
        raw = volume._raw
        async def weakened(method, path, content=None, headers=None):
            response = await raw(method, path, content, headers)
            response.headers["etag"] = f'W/{response.headers["etag"]}'
            return response
        volume._raw = weakened
        self.assertEqual((await volume.read("docs/readme.md"))[1], written["version"])
        volume._raw = raw
        self.assertEqual([entry["path"] for entry in (await volume.list(prefix="/docs"))["files"]], ["/docs/readme.md"])
        snapshot = await volume.snapshot(name="first")
        await volume.write("docs/readme.md", "changed", version=written["version"])
        fork = self.runtime.volume((await volume.fork(snapshot=snapshot["id"]))["id"])
        self.assertEqual(await fork.read_text("docs/readme.md"), "hello volumes")
        self.assertEqual([change["kind"] for change in (await volume.changes())["changes"]], ["write", "write"])
        then = await volume.read_all(prefix="/docs", snapshot=snapshot["id"])
        self.assertEqual((then["snapshot"], [(entry["path"], entry["text"]) for entry in then["files"]]), (snapshot["id"], [("/docs/readme.md", "hello volumes")]))
        self.assertEqual([entry["text"] for entry in (await volume.read_all())["files"]], ["changed"])
        self.assertEqual((await volume.read("docs/readme.md", snapshot=snapshot["id"]))[0], b"hello volumes")
        self.assertEqual([change["path"] for change in (await volume.changes(prefix="/docs"))["changes"]], ["/docs/readme.md", "/docs/readme.md"])
        self.assertEqual([entry["seq"] for entry in await self.runtime.volumes([volume.id])], [(await volume.info())["seq"]])

        agent = await self.runtime.create_agent(tools=[], mounts=[{"volumeId": volume.id, "path": "/docs", "mode": "ro", "subpath": "/docs"}])
        result = await agent.execute('return (await tools.read({ path: "/docs/readme.md" })).content')
        self.assertEqual(result["output"], ["changed"])
        self.assertEqual((await self.runtime.mounts(agent.session["id"]))[0]["mode"], "ro")
        files = next(source for source in await self.runtime.tool_sources(agent.session["id"]) if source["kind"] == "files")
        self.assertIn("read", [tool["name"] for tool in files["tools"]])
        await self.runtime.set_mounts(agent.session["id"], [{"volumeId": fork.id, "path": "/workspace", "mode": "rw"}])
        await agent.execute('await tools.write({ path: "/workspace/new.md", content: "from the agent" })')
        self.assertEqual(await fork.read_text("new.md"), "from the agent")
        await fork.remove("new.md")
        await volume.delete()
        self.assertNotIn(volume.id, [entry["id"] for entry in await self.runtime.list_volumes()])


    async def test_attachments_and_the_agents_files(self):
        agent = await self.runtime.create_agent(tools=[])
        local = Path(self.directory.name) / "report.txt"
        local.write_text("quarterly numbers")
        await agent.files.upload("/workspace/in/chart.png", PNG)
        result = await agent.prompt("Look", files=[PNG, local, {"name": "photo.png", "data": PNG, "content_type": "image/png"}, {"path": "/workspace/in/chart.png"}], idempotency_key="py-files")
        self.assertEqual(result["reply"], "seen")
        listing = await agent.files.list(path="/workspace/uploads/py-files")
        self.assertEqual([(entry["path"], entry["contentType"]) for entry in listing["files"]], [
            ("/workspace/uploads/py-files/attachment-1", "image/png"), ("/workspace/uploads/py-files/photo.png", "image/png"), ("/workspace/uploads/py-files/report.txt", "text/plain")])
        user = next(message for message in self.bodies[-1]["messages"] if message["role"] == "user")["content"]
        self.assertEqual(sum(1 for part in user if part.get("type") == "image_url"), 3)
        self.assertTrue(any(part.get("text", "").startswith("[File /workspace/uploads/py-files/report.txt (text/plain") for part in user))
        history = await agent._http("/history")
        self.assertNotIn(__import__("base64").b64encode(PNG).decode(), json.dumps(history), "the transcript keeps references, not bytes")
        downloaded = await agent.files.download("/workspace/uploads/py-files/report.txt")
        self.assertEqual((downloaded.data, downloaded.content_type, downloaded.version > 0), (b"quarterly numbers", "text/plain", True))
        link = await agent.files.link("/workspace/uploads/py-files/report.txt")
        self.assertEqual((await self.runtime.http.get(link["url"])).content, b"quarterly numbers")
        await agent.destroy()


    async def test_audio_is_transcribed_in_messages_runs_and_on_its_own(self):
        put = await self.runtime.http.put(f"{self.url}/v1/providers/openai/key", headers={"Authorization": f"Bearer {self.token}"}, json={"apiKey": "py-openai-key", "verify": False})
        self.assertEqual(put.status_code, 200, put.text)
        # On its own: bytes, a local path, a URL; async and sync.
        local = Path(self.directory.name) / "voice.ogg"
        local.write_bytes(HELLO)
        alone = await self.agents.transcriptions.create(HELLO, language="en", subject="user_1", context={"org": "o1"})
        self.assertEqual((alone["text"], alone["language"], alone["durationSeconds"], alone["model"]), ("Hello from camelRun.", "en", 5, "openai/gpt-transcribe"))
        self.assertEqual(self.transcribed[-1]["key"], "Bearer py-openai-key")
        self.assertEqual((await self.runtime.transcriptions.create(local))["text"], "Hello from camelRun.")
        by_url = await self.runtime.transcriptions.create(url=f"http://127.0.0.1:{self.transcriber.server_port}/hello.ogg")
        self.assertEqual(by_url["text"], "Hello from camelRun.")
        with self.assertRaises(AgentError) as refused:
            await self.runtime.transcriptions.create(b"plain text, not audio")
        self.assertEqual(refused.exception.status, 415)
        with self.assertRaises(AgentError):
            await self.runtime.transcriptions.create()
        with sync.Agents(self.token, url=self.url) as agents:
            self.assertEqual(await asyncio.to_thread(agents.transcriptions.create, HELLO), alone)
        self.assertEqual(len(self.transcribed), 4)
        # Attached to a message: the model reads the transcript; transcribe=False keeps it a file.
        agent = await self.runtime.create_agent(tools=[])
        await agent.prompt("", files=[{"name": "voice.ogg", "data": HELLO, "content_type": "audio/ogg"}], idempotency_key="py-voice")
        user = next(message for message in reversed(self.bodies[-1]["messages"]) if message["role"] == "user")["content"]
        text = "".join(part.get("text", "") for part in user) if isinstance(user, list) else user
        self.assertIn("/workspace/uploads/py-voice/voice.ogg (audio/ogg, 0:05, en), transcript:\nHello from camelRun.", text)
        await agent.prompt("keep it", files=[{"name": "kept.ogg", "data": HELLO, "transcribe": False}], idempotency_key="py-kept")
        self.assertEqual(len(self.transcribed), 5)
        history = await agent._http("/history")
        files = [block for message in history["messages"] if message["role"] == "user" for block in message["content"] if block.get("type") == "file"]
        self.assertEqual([(block["path"].rsplit("/", 1)[-1], "transcript" in block) for block in files], [("voice.ogg", True), ("kept.ogg", False)])
        await agent.destroy()
        # A stateless run takes audio as input: by URL, with no text.
        run = await self.agents.run("", files=[{"url": f"http://127.0.0.1:{self.transcriber.server_port}/hello.ogg"}])
        self.assertEqual(run.text, "seen")
        self.assertEqual(len(self.transcribed), 6)


    async def test_images_on_their_own(self):
        put = await self.runtime.http.put(f"{self.url}/v1/providers/openai/key", headers={"Authorization": f"Bearer {self.token}"}, json={"apiKey": "py-openai-key", "verify": False})
        self.assertEqual(put.status_code, 200, put.text)
        made = await self.agents.images.generate("a camel at dawn", quality="low", n=2, subject="user_1", context={"org": "o1"})
        self.assertEqual([(image["contentType"], image["width"], base64.b64decode(image["data"])) for image in made["images"]], [("image/png", 1024, IMAGE)] * 2)
        self.assertEqual((made["model"], made["usage"]), ("openai/gpt-image-2.5-flare", {"inputTokens": 10, "outputTokens": 2000}))
        self.assertEqual((self.transcribed[-1]["path"], self.transcribed[-1]["key"]), ("/images/generations", "Bearer py-openai-key"))
        local = Path(self.directory.name) / "camel.png"
        local.write_bytes(IMAGE)
        edited = await self.runtime.images.edit("make it blue", [IMAGE, local], size="1536x1024")
        self.assertEqual(len(edited["images"]), 1)
        self.assertEqual((self.transcribed[-1]["path"], self.transcribed[-1]["type"]), ("/images/edits", "multipart/form-data"))
        with self.assertRaises(AgentError) as refused:
            await self.runtime.images.edit("x", [b"plain text, not an image"])
        self.assertEqual(refused.exception.status, 415)
        with self.assertRaises(AgentError):
            await self.runtime.images.edit("x", [])
        with sync.Agents(self.token, url=self.url) as agents:
            self.assertEqual(len((await asyncio.to_thread(agents.images.generate, "a camel"))["images"]), 1)
        self.assertEqual(len(self.transcribed), 3)


TODOS = [{"owner": "alice", "team": "acme", "text": "ship it"}, {"owner": "bob", "team": "acme", "text": "review it"}, {"owner": "alice", "team": "other", "text": "not this team"}]


@tool
async def list_todos(context: ToolContext) -> dict:
    """The current user's to-dos"""
    who = context.identity
    return {"todos": [todo["text"] for todo in TODOS if todo["owner"] == who.user and todo["team"] == who.context.get("team")]}


@tool
async def whoami(context: ToolContext) -> dict:
    """Who is asking"""
    who = context.identity
    return {"user": who.user, "subject": who.subject, "actor": who.actor, "tenant": who.tenant, "agent": who.agent, "context": who.context, "origin": context.origin}


DELETED = []


@tool
async def archive(name: str, context: ToolContext) -> dict:
    """Archive a project, once the user confirms and says why"""
    if not await context.confirm(f"Archive {name}?"):
        return {"cancelled": True}
    why = await context.ask("Why?", {"type": "object", "properties": {"reason": {"type": "string"}}})
    return {"archived": name, "reason": why["reason"]}


@tool(needs_approval=True)
async def delete_todo(text: str) -> dict:
    """Delete a to-do"""
    DELETED.append(text)
    return {"deleted": text}


class ServeToolsTest(unittest.IsolatedAsyncioTestCase):
    """serve_tools and verify_runtime_token, against TestRuntime: no runtime needed."""
    APP = "https://app.test/mcp"

    async def asyncSetUp(self):
        self.runtime = TestRuntime()
        self.app = serve_tools([list_todos, whoami], **self.runtime.options)

    async def asyncTearDown(self):
        await self.runtime.http.aclose()

    async def test_each_call_is_answered_as_the_user_the_token_names(self):
        call = lambda name, **who: self.runtime.call_tool(self.app, self.APP, name, {}, **who)
        self.assertEqual((await call("list_todos", subject="alice", context={"team": "acme"}))["structuredContent"], {"todos": ["ship it"]})
        self.assertEqual((await call("list_todos", subject="team-acme", actor="bob", context={"team": "acme"}))["structuredContent"], {"todos": ["review it"]})
        me = (await call("whoami", subject="alice", actor="bob", tenant="test", agent="client_1", context={"team": "acme"}, origin={"channel": "slack"}))["structuredContent"]
        self.assertEqual(me, {"user": "bob", "subject": "alice", "actor": "bob", "tenant": "test", "agent": "client_1", "context": {"team": "acme"}, "origin": {"channel": "slack"}})
        listed = (await self.runtime.post(self.app, self.APP, [{"jsonrpc": "2.0", "id": 1, "method": "tools/list"}, {"jsonrpc": "2.0", "method": "notifications/initialized"}], subject="alice")).json()
        self.assertEqual([entry["name"] for entry in listed[0]["result"]["tools"]], ["list_todos", "whoami"])
        self.assertEqual((await self.runtime.post(self.app, self.APP, {"jsonrpc": "2.0", "method": "notifications/initialized"}, subject="alice")).status_code, 202)

    async def test_a_function_of_identity_lists_each_caller_its_own_tools(self):
        @tool
        def admin_only() -> str:
            """Admin only."""
            return "done"
        app = serve_tools(lambda identity: [whoami, admin_only] if identity.context.get("role") == "admin" else [whoami], **self.runtime.options)
        listed = lambda role: self.runtime.post(app, self.APP, {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}, subject="u", context={"role": role})
        self.assertEqual([entry["name"] for entry in (await listed("admin")).json()["result"]["tools"]], ["whoami", "admin_only"])
        self.assertEqual([entry["name"] for entry in (await listed("member")).json()["result"]["tools"]], ["whoami"])

    async def test_anything_but_the_runtimes_token_for_this_server_is_refused(self):
        call = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "list_todos", "arguments": {}}}
        stranger = TestRuntime()
        forged = self.runtime.token(self.APP, subject="alice")
        head, body, signature = forged.split(".")
        claims = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
        tampered = base64.urlsafe_b64encode(json.dumps({**claims, "sub": "bob"}).encode()).rstrip(b"=").decode()
        cases = [
            ("", "No bearer token"),
            (self.runtime.token("https://other.test/mcp", subject="alice"), "Token is for another server"),
            (self.runtime.token(self.APP, subject="alice", expires_in=-120), "Token has expired"),
            (stranger.token(self.APP, subject="alice"), "Token signed with a key the runtime does not publish"),
            (f"{head}.{tampered}.{signature}", "Token signature does not verify"),
            (self.runtime.token(self.APP, subject="alice", claims={"iss": "https://evil.test"}), "Token is from another issuer"),
            (self.runtime.token(self.APP, subject="alice", header={"alg": "none"}), "Token is not an EdDSA token with a key id"),
            ("not-a-token", "Malformed token"),
        ]
        for token, error in cases:
            response = await self.runtime.post(self.app, self.APP, call, token=token)
            self.assertEqual(response.status_code, 401, error)
            self.assertEqual(response.json()["error"], error)
            self.assertEqual(response.headers["www-authenticate"], 'Bearer error="invalid_token", resource_metadata="https://app.test/.well-known/oauth-protected-resource/mcp"')
        await stranger.http.aclose()
        with self.assertRaises(RuntimeTokenError):
            await verify_runtime_token("not-a-token", audience=self.APP, **self.runtime.options)
        identity = await verify_runtime_token(self.runtime.token("https://app.test/mcp/", actor="bob"), audience=self.APP, **self.runtime.options)
        self.assertEqual(identity.user, "bob")
        child = await verify_runtime_token(self.runtime.token(self.APP, parent_agent_id="client_parent", root_agent_id="client_root"), audience=self.APP, **self.runtime.options)
        self.assertEqual((child.parent_agent_id, child.root_agent_id), ("client_parent", "client_root"))

    async def test_a_token_from_another_tenant_is_refused_and_tenant_is_required(self):
        response = await self.runtime.post(self.app, self.APP, {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "list_todos", "arguments": {}}},
                                           tenant="mallory", subject="alice", context={"team": "acme"})
        self.assertEqual((response.status_code, response.json()["error"]), (401, "Token is for another tenant's agent"))
        options = {key: value for key, value in self.runtime.options.items() if key != "tenant"}
        with self.assertRaisesRegex(TypeError, "Pass tenant="):
            serve_tools([list_todos], **options)
        with self.assertRaisesRegex(TypeError, "Pass tenant="):
            await verify_runtime_token(self.runtime.token(self.APP), audience=self.APP, **options)
        identity = await verify_runtime_token(self.runtime.token(self.APP, tenant="b"), audience=self.APP, **{**options, "tenant": ["a", "b"]})
        self.assertEqual(identity.tenant, "b")

    async def test_verify_file_url_checks_the_url_is_the_runtimes_for_a_file_of_the_agent(self):
        url = self.runtime.file_url(agent="client_a")
        claims = await verify_file_url(url, agent="client_a", **self.runtime.options)
        self.assertEqual((claims["kind"], claims["agentPath"], claims["version"], claims["tenant"]), ("file", "/workspace/report.pdf", 1, "test"))
        self.assertEqual((await verify_file_url(url, runtime=self.runtime.url, http=self.runtime.http))["agent"], "client_a")
        stranger = TestRuntime()
        cases = [
            (url, {"agent": "client_b"}, "another agent"),
            (url, {"tenant": ["acme"]}, "another tenant"),
            (url.replace("https://runtime.test", "https://evil.test"), {}, "not at the runtime"),
            (f"{self.runtime.url}/v1/links/x/y", {}, "Not a file URL"),
            (self.runtime.file_url(expires_in=-120), {}, "expired"),
            (f"{self.runtime.url}/v1/files/{self.runtime.token(self.APP)}/x", {}, "not for a file"),
            (stranger.file_url().replace(stranger.url, self.runtime.url), {}, "does not publish"),
        ]
        for target, options, error in cases:
            with self.assertRaisesRegex(RuntimeTokenError, error):
                await verify_file_url(target, **{**self.runtime.options, **options})
        await stranger.http.aclose()

    async def test_the_hosted_runtime_signs_as_agents_camelai_dev_at_either_url(self):
        for url in ("https://run.camelai.com", "https://agents.camelai.dev"):
            runtime = TestRuntime(url)
            identity = await verify_runtime_token(runtime.token(self.APP, subject="alice", claims={"iss": "https://agents.camelai.dev"}), audience=self.APP, **runtime.options)
            self.assertEqual(identity.subject, "alice", url)
            with self.assertRaisesRegex(RuntimeTokenError, "another issuer"):
                await verify_runtime_token(runtime.token(self.APP, claims={"iss": "https://run.camelai.com"}), audience=self.APP, **runtime.options)
            await runtime.http.aclose()

    async def test_a_tool_that_needs_approval_asks_first_and_runs_once_approved(self):
        app = serve_tools([delete_todo], **self.runtime.options)
        listed = (await self.runtime.post(app, self.APP, {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}, subject="alice")).json()
        self.assertEqual(listed["result"]["tools"][0]["_meta"], {"agent-runtime/needsApproval": True})
        asked = await self.runtime.call_tool(app, self.APP, "delete_todo", {"text": "ship it"}, subject="alice")
        self.assertEqual(asked, {"resultType": "input_required", "inputRequests": {"approval": {"method": "agent-runtime/approval"}}})
        self.assertEqual(DELETED, [])
        approval = {"input": "inp_1", "by": {"actor": "alice"}, "at": 1}
        done = await self.runtime.call_tool(app, self.APP, "delete_todo", {"text": "ship it"}, subject="alice", claims={"approval": approval})
        self.assertEqual(done["structuredContent"], {"deleted": "ship it"})
        self.assertEqual(DELETED, ["ship it"])

    async def test_a_tool_asks_the_user_and_runs_again_with_each_answer(self):
        call = lambda params: _answer_mcp({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "archive", "arguments": {"name": "x"}, **params}},
                                          {"archive": archive}, lambda meta: _tool_context(meta, "1"))
        first = (await call({}))["result"]
        self.assertEqual(first["inputRequests"]["input_1"]["params"]["message"], "Archive x?")
        second = (await call({"inputResponses": {"input_1": {"action": "accept", "content": {}}}}))["result"]
        self.assertEqual(second["inputRequests"]["input_2"]["params"]["message"], "Why?")
        done = (await call({"inputResponses": {"input_2": {"action": "accept", "content": {"reason": "old"}}}, "requestState": second["requestState"]}))["result"]
        self.assertEqual(done["structuredContent"], {"archived": "x", "reason": "old"})

    def test_a_confirmation_takes_true_or_false(self):
        confirm = {"kind": "form", "detail": {"requestedSchema": {"type": "object", "properties": {}}}}
        self.assertEqual(_answer_for(confirm, True), {"action": "accept", "content": {}})
        self.assertEqual(_answer_for(confirm, False), {"action": "decline"})
        form = {"kind": "form", "detail": {"requestedSchema": {"type": "object", "properties": {"reason": {"type": "string"}}}}}
        with self.assertRaisesRegex(AgentError, "has fields"):
            _answer_for(form, True)
        self.assertEqual(_answer_for(form, {"reason": "old"}), {"action": "accept", "content": {"reason": "old"}})

    async def test_protected_resource_metadata_and_post_only(self):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app)) as client:
            metadata = (await client.get("https://app.test/.well-known/oauth-protected-resource/mcp")).json()
            self.assertEqual(metadata, {"resource": self.APP, "authorization_servers": [self.runtime.url], "bearer_methods_supported": ["header"], "resource_name": "agent-runtime-tools"})
            self.assertEqual((await client.get(self.APP)).status_code, 405)

    async def test_attached_calls_carry_the_identity_the_runtime_sent(self):
        meta = {"agent-runtime/callId": "c1", "agent-runtime/identity": {"tenant": "t1", "agent": "client_1", "sub": "team-acme", "act": "alice", "ctx": {"team": "acme"}}}
        answer = await _answer_mcp({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "list_todos", "arguments": {}, "_meta": meta}},
                                   {"list_todos": list_todos}, lambda given: _tool_context(given, "1"))
        self.assertEqual(answer["result"]["structuredContent"], {"todos": ["ship it"]})


class WebhookTest(unittest.TestCase):
    """verify_webhook against requests signed as the runtime signs them (src/webhooks.ts signedHeaders)."""
    SECRET = "whsec_" + base64.b64encode(b"k" * 24).decode()

    @staticmethod
    def signed(body, secrets, *, at=None, webhook_id="evt_1"):
        import hmac
        timestamp = str(int(time.time() if at is None else at))
        signatures = [f"v1,{base64.b64encode(hmac.new(base64.b64decode(secret[6:]), f'{webhook_id}.{timestamp}.{body}'.encode(), hashlib.sha256).digest()).decode()}" for secret in secrets]
        return {"webhook-id": webhook_id, "webhook-timestamp": timestamp, "webhook-signature": " ".join(signatures)}

    def test_a_signed_event_verifies_and_anything_else_is_refused(self):
        body = json.dumps({"id": "evt_1", "type": "run.completed", "created": 1, "data": {"agentId": "client_1"}})
        headers = self.signed(body, [self.SECRET])
        self.assertEqual(verify_webhook(body, headers, self.SECRET)["type"], "run.completed")
        # Bytes or text, headers in any case (Flask and Django give them capitalized).
        self.assertEqual(verify_webhook(body.encode(), {name.title(): value for name, value in headers.items()}, self.SECRET)["data"], {"agentId": "client_1"})
        other = "whsec_" + base64.b64encode(b"o" * 24).decode()
        cases = [
            (body.replace("client_1", "client_2"), headers, self.SECRET, "No signature verifies"),
            (body, headers, other, "No signature verifies"),
            (body, {**headers, "webhook-id": "evt_2"}, self.SECRET, "No signature verifies"),
            (body, self.signed(body, [self.SECRET], at=time.time() - 600), self.SECRET, "too far from now"),
            (body, self.signed(body, [self.SECRET], at=time.time() + 600), self.SECRET, "too far from now"),
            (body, {key: value for key, value in headers.items() if key != "webhook-signature"}, self.SECRET, "Missing"),
            (body, {**headers, "webhook-timestamp": "soon"}, self.SECRET, "Invalid webhook-timestamp"),
            (body, {**headers, "webhook-signature": "v2," + headers["webhook-signature"][3:]}, self.SECRET, "No signature verifies"),
        ]
        for given, given_headers, secret, error in cases:
            with self.assertRaisesRegex(WebhookVerificationError, error):
                verify_webhook(given, given_headers, secret)
        # An older request verifies within a wider tolerance.
        self.assertEqual(verify_webhook(body, self.signed(body, [self.SECRET], at=time.time() - 600), self.SECRET, tolerance=900)["id"], "evt_1")

    def test_during_a_rotation_either_secret_verifies(self):
        body = json.dumps({"id": "evt_1", "type": "usage.recorded", "created": 1, "data": {}})
        new = "whsec_" + base64.b64encode(b"n" * 24).decode()
        # The runtime signs with the new secret and, for 24 hours, the old one too.
        both = self.signed(body, [new, self.SECRET])
        self.assertEqual(verify_webhook(body, both, self.SECRET)["id"], "evt_1")
        self.assertEqual(verify_webhook(body, both, new)["id"], "evt_1")
        # A receiver moving to the new secret accepts either.
        self.assertEqual(verify_webhook(body, self.signed(body, [self.SECRET]), [new, self.SECRET])["id"], "evt_1")


class WsgiServeToolsTest(unittest.TestCase):
    """camelai_run.sync's serve_tools (a WSGI app) and verify_runtime_token, against its TestRuntime."""
    APP = "https://app.test/mcp"

    def setUp(self):
        self.runtime = sync.TestRuntime()
        self.threads = []

        @tool
        def plain_whoami(context: ToolContext) -> dict:
            """Who is asking, from a plain function"""
            self.threads.append(threading.get_ident())
            return {"user": context.identity.user, "context": context.identity.context}

        self.app = sync.serve_tools([plain_whoami, list_todos, delete_todo], **self.runtime.options)

    def tearDown(self):
        self.runtime.http.close()

    def test_each_call_is_answered_as_the_user_the_token_names(self):
        self.assertEqual(self.runtime.call_tool(self.app, self.APP, "plain_whoami", {}, subject="team-acme", actor="bob", context={"team": "acme"})["structuredContent"],
                         {"user": "bob", "context": {"team": "acme"}})
        # An async tool runs too, in an event loop of the request's own.
        self.assertEqual(self.runtime.call_tool(self.app, self.APP, "list_todos", {}, subject="alice", context={"team": "acme"})["structuredContent"], {"todos": ["ship it"]})
        listed = self.runtime.post(self.app, self.APP, [{"jsonrpc": "2.0", "id": 1, "method": "tools/list"}, {"jsonrpc": "2.0", "method": "notifications/initialized"}], subject="alice").json()
        self.assertEqual([entry["name"] for entry in listed[0]["result"]["tools"]], ["plain_whoami", "list_todos", "delete_todo"])
        self.assertEqual(self.runtime.post(self.app, self.APP, {"jsonrpc": "2.0", "method": "notifications/initialized"}, subject="alice").status_code, 202)
        asked = self.runtime.call_tool(self.app, self.APP, "delete_todo", {"text": "ship it"}, subject="alice")
        self.assertEqual(asked["resultType"], "input_required")

    def test_anything_but_the_runtimes_token_for_this_server_is_refused(self):
        call = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "plain_whoami", "arguments": {}}}
        stranger = sync.TestRuntime()
        cases = [
            ("", "No bearer token"),
            (self.runtime.token("https://other.test/mcp", subject="alice"), "Token is for another server"),
            (self.runtime.token(self.APP, subject="alice", expires_in=-120), "Token has expired"),
            (self.runtime.token(self.APP, subject="alice", tenant="mallory"), "Token is for another tenant's agent"),
            (stranger.token(self.APP, subject="alice"), "Token signed with a key the runtime does not publish"),
            ("not-a-token", "Malformed token"),
        ]
        for token, error in cases:
            response = self.runtime.post(self.app, self.APP, call, token=token)
            self.assertEqual((response.status_code, response.json()["error"]), (401, error))
            self.assertEqual(response.headers["www-authenticate"], 'Bearer error="invalid_token", resource_metadata="https://app.test/.well-known/oauth-protected-resource/mcp"')
        stranger.http.close()
        self.assertEqual(self.threads, [])
        with httpx.Client(transport=httpx.WSGITransport(app=self.app)) as client:
            metadata = client.get("https://app.test/.well-known/oauth-protected-resource/mcp").json()
            self.assertEqual((metadata["resource"], metadata["authorization_servers"]), (self.APP, [self.runtime.url]))
            self.assertEqual(client.get(self.APP).status_code, 405)

    def test_verify_runtime_token_is_synchronous_and_takes_a_list_of_audiences(self):
        identity = sync.verify_runtime_token(self.runtime.token("https://app.test/mcp/", actor="bob"), audience=self.APP, **self.runtime.options)
        self.assertEqual((identity.user, identity.claims["aud"]), ("bob", "https://app.test/mcp/"))
        both = ["https://app.test/mcp", "https://app.example/mcp"]
        self.assertEqual(sync.verify_runtime_token(self.runtime.token("https://app.example/mcp", subject="alice"), audience=both, **self.runtime.options).user, "alice")
        with self.assertRaisesRegex(RuntimeTokenError, "another server"):
            sync.verify_runtime_token(self.runtime.token("https://other.test/mcp"), audience=both, **self.runtime.options)
        options = {key: value for key, value in self.runtime.options.items() if key != "tenant"}
        with self.assertRaisesRegex(TypeError, "Pass tenant="):
            sync.serve_tools([list_todos], **options)
        with self.assertRaisesRegex(TypeError, "Pass tenant="):
            sync.verify_runtime_token(self.runtime.token(self.APP), audience=self.APP, **options)

    def test_verify_file_url_is_synchronous(self):
        url = self.runtime.file_url(kind="manifest", snapshot="snap_1", version=None)
        self.assertEqual(sync.verify_file_url(url, **self.runtime.options)["kind"], "manifest")
        with self.assertRaisesRegex(RuntimeTokenError, "another agent"):
            sync.verify_file_url(url, agent="client_other", **self.runtime.options)

    def test_a_real_wsgi_server_runs_plain_tools_in_the_request_thread(self):
        from wsgiref.simple_server import WSGIRequestHandler, make_server

        class Quiet(WSGIRequestHandler):
            def log_message(self, *_):
                pass
        requests = []

        def app(environ, start_response):
            requests.append(threading.get_ident())
            return self.app(environ, start_response)
        server = make_server("127.0.0.1", 0, app, handler_class=Quiet)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            url = f"http://127.0.0.1:{server.server_port}/tools/mcp"
            response = httpx.post(url, headers={"Authorization": f"Bearer {self.runtime.token(url, subject='alice')}"},
                                  json={"jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": {"name": "plain_whoami", "arguments": {}}})
            self.assertEqual((response.status_code, response.json()["id"], response.json()["result"]["structuredContent"]["user"]), (200, 7, "alice"))
            self.assertEqual(self.threads, requests)
            refused = httpx.post(url, json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
            self.assertEqual((refused.status_code, refused.headers["www-authenticate"]),
                             (401, f'Bearer error="invalid_token", resource_metadata="http://127.0.0.1:{server.server_port}/.well-known/oauth-protected-resource/tools/mcp"'))
        finally:
            server.shutdown()
            server.server_close()


class RateLimitRetryTest(unittest.IsolatedAsyncioTestCase):
    """429s are retried, honouring Retry-After, without a runtime."""

    async def test_rate_limited_requests_wait_and_retry(self):
        import time
        import httpx
        seen = []

        def answer(request):
            seen.append(time.monotonic())
            if len(seen) <= 2:
                return httpx.Response(429, json={"error": "This tenant already has 1 agents running"}, headers={"Retry-After": "1"})
            return httpx.Response(201, json={"id": "vol_" + "b" * 24, "name": "v", "createdAt": 1})

        runtime = AgentRuntime(url="http://127.0.0.1:1", api_key="operator")
        await runtime.http.aclose()
        runtime.http = httpx.AsyncClient(transport=httpx.MockTransport(answer))
        try:
            # create_volume does not retry other failures; a 429 was refused before anything happened.
            self.assertEqual((await runtime.create_volume(name="v"))["name"], "v")
            self.assertEqual(len(seen), 3)
            self.assertTrue(seen[1] - seen[0] >= 0.99 and seen[2] - seen[1] >= 0.99)

            refusals = []

            def refuse(request):
                refusals.append(request)
                return httpx.Response(429, json={"error": "busy"}, headers={"Retry-After": "0"})

            await runtime.http.aclose()
            runtime.http = httpx.AsyncClient(transport=httpx.MockTransport(refuse))
            with self.assertRaises(Exception) as refused:
                await runtime.list_volumes()
            self.assertEqual((refused.exception.status, refused.exception.retry_after), (429, 0))
            self.assertEqual(len(refusals), 8)
        finally:
            await runtime.close()


class ReconnectHintTest(unittest.IsolatedAsyncioTestCase):
    """A stream the runtime closes on purpose (event: reconnect) is reconnected at once; one that just ends, after a backoff."""

    async def reconnects(self, hinted):
        import httpx
        starts = []

        def answer(request):
            if request.url.path.endswith("/state"):
                return httpx.Response(200, json={"cursor": 7, "requests": []})
            starts.append((time.monotonic(), request.headers.get("last-event-id")))
            body = 'event: ready\ndata: {"connection": "c1"}\n\nid: 7\ndata: {"type": "event", "event": {"type": "agent_start"}}\n\n'
            # Only the first stream is closed on purpose; the next one just ends.
            if hinted and len(starts) == 1:
                body += 'event: reconnect\nretry: 0\ndata: {"type": "reconnect", "reason": "drain", "retryMs": 0}\n\n'
            return httpx.Response(200, content=body.encode(), headers={"Content-Type": "text/event-stream"})

        client = AgentClient("http://127.0.0.1:1", {"id": "client_" + "a" * 40, "token": "t"}, [], attach=False)
        await client.http.aclose()
        client.http = httpx.AsyncClient(transport=httpx.MockTransport(answer))
        try:
            await client.connect()
            for _ in range(100):
                if len(starts) >= 2:
                    break
                await asyncio.sleep(0.01)
        finally:
            await client.close(drain=0)
        self.assertGreaterEqual(len(starts), 2)
        # The reconnect resumes after the last event it had.
        self.assertEqual(starts[1][1], "7")
        return starts[1][0] - starts[0][0]

    async def test_a_hinted_close_reconnects_at_once_and_an_unhinted_one_backs_off(self):
        self.assertLess(await self.reconnects(True), 0.2)
        self.assertGreaterEqual(await self.reconnects(False), 0.24)


class VersionTest(unittest.TestCase):
    def test_version_is_pyprojects(self):
        import camelai_run
        import tomllib
        self.assertEqual(camelai_run.__version__, tomllib.loads((ROOT / "clients" / "python" / "pyproject.toml").read_text())["project"]["version"])


class OriginTest(unittest.TestCase):
    def test_plain_http_reaches_only_private_hosts(self):
        for url in ["http://localhost:8790", "http://127.0.0.1:8790", "http://runtime:8790", "http://agent-runtime.internal", "http://10.1.2.3", "http://172.20.0.5:8790", "http://192.168.1.9", "https://agents.example.com"]:
            self.assertEqual(_origin(url), url)
        for url in ["http://agents.example.com", "http://8.8.8.8", "http://172.32.0.1", "http://[2001:db8::1]"]:
            with self.assertRaisesRegex(ValueError, "require https"):
                _origin(url)


if __name__ == "__main__":
    unittest.main()
