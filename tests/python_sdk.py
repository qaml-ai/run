"""Run with: python3 tests/python_sdk.py (requires httpx)."""
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
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlencode, urlsplit, urlunsplit

import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "clients" / "python"))
from camelai_run import _answer_for, _origin, AgentError, AgentRuntime, Agents, RunError, RuntimeTokenError, TestRuntime, ToolContext, _answer_mcp, _tool_context, serve_tools, tool, verify_runtime_token

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
            delta = script.pop(0) if script else {"role": "assistant", "content": "seen"}
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
        self.host = await asyncio.create_subprocess_exec(
            "node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", str(ROOT / "src" / "server.ts"), stdout=asyncio.subprocess.PIPE,
            env={"PATH": os.environ["PATH"], "HOME": self.directory.name,
                 "AGENT_DATABASE_URL": urlunsplit(url._replace(query=urlencode({"options": f"-c search_path={self.schema}"}))),
                 "AGENT_DATA_DIR": self.directory.name, "AGENT_TENANTS_FILE": str(tenants), "AGENT_SESSION_SECRET": self.token, "PORT": "0",
                 "AGENT_PROVIDER": "openrouter", "AGENT_MODEL": "openai/gpt-4o-mini", "AGENT_BASE_URL": f"http://127.0.0.1:{self.model.server_port}/v1",
                 # Providers of the tenant's own: sealed keys, and the fake model server reachable as one.
                 "AGENT_SECRETS_KEY": "ab" * 32, "AGENT_OUTBOUND_ALLOW_HTTP": "true", "AGENT_OUTBOUND_ALLOW_CIDRS": "127.0.0.1/32",
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
        agent = await self.make([lookup])
        self.call("lookup", {"sku": "A1"})
        stream = agent.stream("look up A1")
        parts = [part async for part in stream]
        self.assertEqual([part.type for part in parts], ["tool_call", "tool_result", "text", "done"])
        self.assertEqual((parts[0].name, parts[0].arguments), ("lookup", {"sku": "A1"}))
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
        self.assertEqual((await self.runtime.http.get(f"{self.url}/v1/agents/{researcher.id}", headers={"Authorization": f"Bearer {self.token}"})).json()["builtins"], ["web_fetch"])
        joined = await asyncio.gather(agent.client.request("status", idempotency_key="py-status"), agent.client.request("status", idempotency_key="py-status"))
        self.assertEqual(joined[0], joined[1])
        page = await agent.history_page(limit=1)
        whole = await agent.history()
        self.assertIsInstance(whole, list, "the simple API's history is the list of messages")
        self.assertEqual(page["total"], len(whole))
        self.assertEqual((await agent.client.wait_for_request("py-first"))["reply"], first.text)

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
        with self.assertRaisesRegex(Exception, "outcome is unknown"):
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


class OriginTest(unittest.TestCase):
    def test_plain_http_reaches_only_private_hosts(self):
        for url in ["http://localhost:8790", "http://127.0.0.1:8790", "http://runtime:8790", "http://agent-runtime.internal", "http://10.1.2.3", "http://172.20.0.5:8790", "http://192.168.1.9", "https://agents.example.com"]:
            self.assertEqual(_origin(url), url)
        for url in ["http://agents.example.com", "http://8.8.8.8", "http://172.32.0.1", "http://[2001:db8::1]"]:
            with self.assertRaisesRegex(ValueError, "require https"):
                _origin(url)


if __name__ == "__main__":
    unittest.main()
