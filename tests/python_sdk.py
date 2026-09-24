"""Run with: python3 tests/python_sdk.py (requires httpx)."""
import asyncio
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import unittest
from urllib.parse import urlencode, urlsplit, urlunsplit

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "clients" / "python"))
from agent_client import AgentRuntime, ToolContext, tool

DATABASE_URL = os.environ.get("AGENT_TEST_DATABASE_URL", "postgres://postgres:test@127.0.0.1:55432/postgres")


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
        self.host = await asyncio.create_subprocess_exec(
            "node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", str(ROOT / "src" / "server.ts"), stdout=asyncio.subprocess.PIPE,
            env={"PATH": os.environ["PATH"], "HOME": self.directory.name,
                 "AGENT_DATABASE_URL": urlunsplit(url._replace(query=urlencode({"options": f"-c search_path={self.schema}"}))),
                 "AGENT_DATA_DIR": self.directory.name, "AGENT_RUNTIME_TOKEN": self.token, "PORT": "0",
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
            if method == "POST" and suffix in ("requests", "outcome") and suffix not in dropped:
                dropped.add(suffix)
                raise ConnectionError("Simulated acknowledgement lost after server commit")
            return response

        agent.http.request = flaky_request
        script = 'return await tools.save({value:"once"})'
        first = await agent.execute(script, idempotency_key="stable-python-request")
        repeated = await agent.execute(script, idempotency_key="stable-python-request")
        self.assertEqual(first, repeated)
        self.assertEqual(len(writes), 1)
        self.assertEqual(dropped, {"requests", "outcome"})

        # Restart only the receive stream while the application callback is live.
        pending = asyncio.create_task(agent.execute('return await tools.save({value:"hold"})'))
        await asyncio.wait_for(entered.wait(), 5)
        agent.runner.cancel()
        await asyncio.gather(agent.runner, return_exceptions=True)
        agent.runner = None
        agent.ready.clear()
        await agent.connect()
        release.set()
        result = await asyncio.wait_for(pending, 5)
        self.assertEqual(json.loads(result["output"][0]), {"saved": "hold"})
        self.assertEqual(len(writes), 2)
        self.assertNotEqual(writes[0][1], writes[1][1])
        self.assertTrue(all(call["state"] == "completed" for call in (await agent.outcomes())["calls"]))
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
        await self.runtime.set_mounts(agent.session["id"], [{"volumeId": fork.id, "path": "/workspace", "mode": "rw"}])
        await agent.execute('await tools.write({ path: "/workspace/new.md", content: "from the agent" })')
        self.assertEqual(await fork.read_text("new.md"), "from the agent")
        await fork.remove("new.md")
        await volume.delete()
        self.assertNotIn(volume.id, [entry["id"] for entry in await self.runtime.list_volumes()])



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
