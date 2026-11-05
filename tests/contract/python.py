"""Original Python SDK assertions; only the backend fixture is replaced.

The Python tests talk to the same base-URL fixture as TypeScript. Model replies
remain the original tests' local HTTP server and mutable script, unchanged.
"""
import asyncio
import functools
import hashlib
import importlib.util
import json
import os
import signal
from pathlib import Path
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("contract_original_python_sdk", ROOT / "tests/python_sdk.py")
original = importlib.util.module_from_spec(spec)
spec.loader.exec_module(original)


async def cleanup(self):
    """Also registered before setup, because unittest skips tearDown on setup errors."""
    if getattr(self, "_contract_closed", False):
        return
    self._contract_closed = True
    errors = []
    for name in ("agents", "runtime"):
        client = getattr(self, name, None)
        if client is not None:
            try:
                await asyncio.wait_for(client.close(), 10)
            except Exception as error:
                errors.append(error)
    host = getattr(self, "host", None)
    if host is not None:
        # Drain both pipes even if readiness was never reported. Waiting for an
        # unread pipe can otherwise block process termination indefinitely.
        for name, stream in (("logs", host.stdout), ("host_errors", host.stderr)):
            if getattr(self, name, None) is None and stream is not None:
                setattr(self, name, asyncio.create_task(stream.read()))
        if host.returncode is None:
            try:
                os.killpg(host.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                await asyncio.wait_for(host.wait(), 20)
            except asyncio.TimeoutError:
                try:
                    os.killpg(host.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                try:
                    await asyncio.wait_for(host.wait(), 5)
                except Exception as error:
                    errors.append(error)
        for name in ("logs", "host_errors"):
            task = getattr(self, name, None)
            if task is not None:
                try:
                    await asyncio.wait_for(task, 5)
                except Exception as error:
                    errors.append(error)
    for name in ("model", "transcriber"):
        server = getattr(self, name, None)
        if server is not None:
            try:
                await asyncio.to_thread(server.shutdown)
                await asyncio.to_thread(server.server_close)
            except Exception as error:
                errors.append(error)
    directory = getattr(self, "directory", None)
    if directory is not None:
        try:
            directory.cleanup()
        except Exception as error:
            errors.append(error)
    if errors:
        raise RuntimeError(f"Python fixture cleanup failed ({len(errors)} resources)") from errors[0]


async def setup(self):
    self.addAsyncCleanup(cleanup, self)
    self.directory = tempfile.TemporaryDirectory(prefix="camelrun-contract-python-")
    self.token = "fixture-only-python-sdk-operator-token"
    self.bodies, self.script, self.transcribed = [], [], []
    self.model = original.fake_model(self.bodies, self.script)
    self.transcriber = original.fake_transcriber(self.transcribed)
    self.model_url = f"http://127.0.0.1:{self.model.server_port}/v1"
    options = {
        "tenants": {"tenants": {"python": {"tokenSha256": hashlib.sha256(self.token.encode()).hexdigest(), "apiKeys": {"openrouter": "unset"}}}},
        "env": {
            "AGENT_MODEL": "openai/gpt-4o-mini", "AGENT_BASE_URL": self.model_url,
            "AGENT_PUBLIC_URL": "",
            "AGENT_OUTBOUND_ALLOW_HTTP": "true", "AGENT_OUTBOUND_ALLOW_CIDRS": "127.0.0.1/32",
            "AGENT_TRANSCRIPTION_URL": f"http://127.0.0.1:{self.transcriber.server_port}",
            "AGENT_IMAGES_URL": f"http://127.0.0.1:{self.transcriber.server_port}",
        },
    }
    self.host = await asyncio.create_subprocess_exec(
        "node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", "--test", "--test-reporter=spec", str(ROOT / "tests/contract/python-host.ts"),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        env={**os.environ, "CONTRACT_FIXTURE_OPTIONS": json.dumps(options)}, cwd=ROOT, start_new_session=True,
    )
    self.host_errors = asyncio.create_task(self.host.stderr.read())
    while True:
        line = await asyncio.wait_for(self.host.stdout.readline(), 60)
        if not line:
            raise RuntimeError(f"Fixture host exited before readiness: {(await self.host_errors).decode()[-2000:]}")
        if b"@@CONTRACT_HOST@@" in line:
            self.url = json.loads(line.split(b"@@CONTRACT_HOST@@", 1)[1])["base"]
            break
    self.logs = asyncio.create_task(self.host.stdout.read())
    self.runtime = original.AgentRuntime(url=self.url, api_key=self.token)
    self.agents = original.Agents(self.token, url=self.url)
    with self.assertRaises(TypeError):
        original.AgentRuntime(url=self.url, api_key=self.token, state_directory="sdk")


async def teardown(self):
    await cleanup(self)


original.PythonSDKTest.asyncSetUp = setup
original.PythonSDKTest.asyncTearDown = teardown


def bounded_case(method):
    """Keep the source method intact, but let a missing backend feature time out."""
    @functools.wraps(method)
    async def run(self):
        timeout_ms = int(os.environ.get("CONTRACT_TIMEOUT_MS", "90000"))
        if timeout_ms <= 0:
            raise ValueError("CONTRACT_TIMEOUT_MS must be positive")
        task = asyncio.create_task(method(self))
        try:
            return await asyncio.wait_for(task, timeout_ms / 1000)
        except asyncio.TimeoutError:
            if task.cancelled():
                self.fail(f"Python contract timed out after {timeout_ms} ms")
            raise
    return run


for name in dir(original.PythonSDKTest):
    method = getattr(original.PythonSDKTest, name)
    if name.startswith("test_") and asyncio.iscoroutinefunction(method):
        setattr(original.PythonSDKTest, name, bounded_case(method))

# Transport scope is explicit; these are never reported as failures or passes.
for name in ("test_voice_sessions_need_the_runtime_to_hold_calls", "test_audio_is_transcribed_in_messages_runs_and_on_its_own"):
    setattr(original.PythonSDKTest, name, unittest.skip("Voice/audio is out of scope")(getattr(original.PythonSDKTest, name)))
for name in dir(original.VoiceLibraryTest):
    if name.startswith("test_"):
        setattr(original.VoiceLibraryTest, name, unittest.skip("Voice/audio is out of scope")(getattr(original.VoiceLibraryTest, name)))


class Result(unittest.TextTestResult):
    def startTest(self, test):
        self.started = time.monotonic()
        super().startTest(test)

    def record(self, test, status, reason="", error=None):
        row = {"area": "python", "source": "tests/python_sdk.py", "name": f"{test.__class__.__name__}.{test._testMethodName}",
               "status": status, "backend": os.environ.get("CONTRACT_BACKEND", "node") if isinstance(test, original.PythonSDKTest) else "sdk-unit",
               "durationMs": (time.monotonic() - self.started) * 1000, "reason": " ".join(reason.split()), "error": error}
        print("@@CONTRACT_RESULT@@" + json.dumps(row), flush=True)

    def addSuccess(self, test):
        super().addSuccess(test)
        self.record(test, "pass")

    def addFailure(self, test, err):
        super().addFailure(test, err)
        self.record(test, "fail", str(err[1]), self._exc_info_to_string(err, test))

    def addError(self, test, err):
        super().addError(test, err)
        self.record(test, "fail", str(err[1]), self._exc_info_to_string(err, test))

    def addSkip(self, test, reason):
        super().addSkip(test, reason)
        self.record(test, "out-of-scope", reason)


suite = unittest.defaultTestLoader.loadTestsFromModule(original)
if "--list" in __import__("sys").argv:
    def cases(value):
        if isinstance(value, unittest.TestSuite):
            for child in value:
                yield from cases(child)
        else:
            yield value
    for case in cases(suite):
        print("@@CONTRACT_CASE@@" + json.dumps({"area": "python", "source": "tests/python_sdk.py", "name": f"{case.__class__.__name__}.{case._testMethodName}", "file": "tests/contract/python.py"}))
    raise SystemExit(0)
result = unittest.TextTestRunner(verbosity=1, resultclass=Result).run(suite)
raise SystemExit(0 if result.wasSuccessful() else 1)
