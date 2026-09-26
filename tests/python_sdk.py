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
from camelai_agent_runtime import AgentRuntime, RuntimeTokenError, TestRuntime, ToolContext, _answer_mcp, _tool_context, serve_tools, tool, verify_runtime_token

DATABASE_URL = os.environ.get("AGENT_TEST_DATABASE_URL", "postgres://postgres:test@127.0.0.1:55432/postgres")


PNG = bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13]) + b"IHDR" + bytes([0, 0, 0, 2, 0, 0, 0, 3, 8, 2, 0, 0, 0])


def fake_model(bodies):
    """An OpenAI-compatible model on localhost that answers "seen" and keeps each request body."""
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            bodies.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            for delta, finish in (({"role": "assistant", "content": "seen"}, None), ({}, "stop")):
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
        self.bodies = []
        self.model = fake_model(self.bodies)
        self.host = await asyncio.create_subprocess_exec(
            "node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", str(ROOT / "src" / "server.ts"), stdout=asyncio.subprocess.PIPE,
            env={"PATH": os.environ["PATH"], "HOME": self.directory.name,
                 "AGENT_DATABASE_URL": urlunsplit(url._replace(query=urlencode({"options": f"-c search_path={self.schema}"}))),
                 "AGENT_DATA_DIR": self.directory.name, "AGENT_TENANTS_FILE": str(tenants), "AGENT_SESSION_SECRET": self.token, "PORT": "0",
                 "AGENT_PROVIDER": "openrouter", "AGENT_MODEL": "openai/gpt-4o-mini", "AGENT_BASE_URL": f"http://127.0.0.1:{self.model.server_port}/v1",
                 **({"AGENT_RUNTIME": os.environ["AGENT_RUNTIME"]} if "AGENT_RUNTIME" in os.environ else {})},
        )
        ready = json.loads(await asyncio.wait_for(self.host.stdout.readline(), 15))
        self.runtime = AgentRuntime(url=f"http://127.0.0.1:{ready['address']['port']}", api_key=self.token,
                                    state_directory=Path(self.directory.name) / "sdk")

    async def asyncTearDown(self):
        await self.runtime.close()
        self.host.terminate()
        await asyncio.wait_for(self.host.wait(), 10)
        database(f"drop schema {self.schema} cascade")
        self.model.shutdown()
        self.model.server_close()
        self.directory.cleanup()

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
        self.assertEqual((downloaded["data"], downloaded["content_type"]), (b"quarterly numbers", "text/plain"))
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
        me = (await call("whoami", subject="alice", actor="bob", tenant="t1", agent="client_1", context={"team": "acme"}, origin={"channel": "slack"}))["structuredContent"]
        self.assertEqual(me, {"user": "bob", "subject": "alice", "actor": "bob", "tenant": "t1", "agent": "client_1", "context": {"team": "acme"}, "origin": {"channel": "slack"}})
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


if __name__ == "__main__":
    unittest.main()
