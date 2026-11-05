"""Original Python SDK assertions; only the backend fixture is replaced.

The Python tests talk to the same base-URL fixture as TypeScript. Model replies
remain the original tests' local HTTP server and mutable script, unchanged.
"""
import asyncio
import functools
import hashlib
import importlib.util
import json
import math
import os
import signal
import sys
from pathlib import Path
import tempfile
import time
import unittest
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]
from python_runner import OUT_OF_SCOPE, inventory, run_cases

manifest = inventory(ROOT / "tests/python_sdk.py")
if "--list" in sys.argv:
    for row in manifest:
        print("@@CONTRACT_CASE@@" + json.dumps(row))
    raise SystemExit(0)
selected_case = next((arg[len("--case="):] for arg in sys.argv[1:] if arg.startswith("--case=")), None)
if selected_case is None:
    raise SystemExit(run_cases(manifest, Path(__file__), int(os.environ.get("CONTRACT_PYTHON_CONCURRENCY", "4"))))
if selected_case not in {row["name"] for row in manifest}:
    raise ValueError(f"Unknown Python contract case: {selected_case}")

import httpx

spec = importlib.util.spec_from_file_location("contract_original_python_sdk", ROOT / "tests/python_sdk.py")
original = importlib.util.module_from_spec(spec)
spec.loader.exec_module(original)

# unittest runs one case at a time, while a case's synchronous SDK calls may
# run in a thread. Capture the owner before sending so a late response cannot
# be attributed to the next case. Instrument both clients, including ones the
# SDK constructs internally, without changing requests or response bodies.
active_case = None


def observe_response(test, response):
    if test is None or not isinstance(test, original.PythonSDKTest) or not getattr(test, "url", None):
        return
    target, base = urlsplit(str(response.request.url)), urlsplit(test.url)
    if (target.scheme, target.netloc) != (base.scheme, base.netloc):
        return
    if target.path == "/healthz" or "__test" in target.path.split("/"):
        return
    test._contract_http_response = True


async_send = httpx.AsyncClient.send
sync_send = httpx.Client.send


@functools.wraps(async_send)
async def observed_async_send(client, request, *args, **kwargs):
    owner = active_case
    response = await async_send(client, request, *args, **kwargs)
    observe_response(owner, response)
    return response


@functools.wraps(sync_send)
def observed_sync_send(client, request, *args, **kwargs):
    owner = active_case
    response = sync_send(client, request, *args, **kwargs)
    observe_response(owner, response)
    return response


httpx.AsyncClient.send = observed_async_send
httpx.Client.send = observed_sync_send


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
                # The fixture host owns backend teardown. Signal it alone so
                # children finish through its registered cleanup hooks.
                host.terminate()
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
        host_output = []
        for name in ("logs", "host_errors"):
            task = getattr(self, name, None)
            if task is not None:
                try:
                    host_output.append(await asyncio.wait_for(task, 5))
                except Exception as error:
                    errors.append(error)
        if host.returncode != 0:
            detail = b"\n".join(host_output).decode(errors="replace")[-4000:]
            errors.append(RuntimeError(f"Fixture host exited with {host.returncode}: {detail}"))
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
        details = "; ".join(str(error) for error in errors)
        raise RuntimeError(f"Python fixture cleanup failed ({len(errors)} resources): {details}") from errors[0]


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
        "node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", "--test-reporter=spec", str(ROOT / "tests/contract/python-host.ts"),
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


def case_timeout_ms(name):
    explicit = os.environ.get("CONTRACT_TIMEOUT_MS")
    if explicit is not None:
        timeout = float(explicit)
        if not math.isfinite(timeout) or not timeout > 0:
            raise ValueError("CONTRACT_TIMEOUT_MS must be positive")
        return timeout
    baseline = os.environ.get("CONTRACT_NODE_BASELINE")
    if os.environ.get("CONTRACT_BACKEND") != "workers" or not baseline:
        return 90000
    for row in json.loads(Path(baseline).read_text())["rows"]:
        if row.get("area") == "python" and row.get("source") == "tests/python_sdk.py" and row.get("name") == name and row.get("status") == "pass":
            samples = sorted(value for value in row.get("durationSamplesMs", [row.get("durationMs")]) if isinstance(value, (int, float)) and math.isfinite(value) and value > 0)
            if samples:
                return max(10000, math.ceil(3 * samples[math.ceil(len(samples) * 0.99) - 1]))
    return 90000


def bounded_case(method):
    """Keep the source method intact, but let a missing backend feature time out."""
    @functools.wraps(method)
    async def run(self):
        timeout_ms = case_timeout_ms(f"{self.__class__.__name__}.{method.__name__}")
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

# Transport scope is explicit; no other skipped test can become a backend pass.
for name in ("test_voice_sessions_need_the_runtime_to_hold_calls", "test_audio_is_transcribed_in_messages_runs_and_on_its_own"):
    setattr(original.PythonSDKTest, name, unittest.skip("Voice/audio is out of scope")(getattr(original.PythonSDKTest, name)))
for name in dir(original.VoiceLibraryTest):
    if name.startswith("test_"):
        setattr(original.VoiceLibraryTest, name, unittest.skip("Voice/audio is out of scope")(getattr(original.VoiceLibraryTest, name)))


class Result(unittest.TextTestResult):
    def startTest(self, test):
        global active_case
        active_case = test
        test._contract_http_response = False
        self.started = time.monotonic()
        self.case_status = None
        self.case_reasons = []
        self.case_errors = []
        super().startTest(test)

    def record(self, test, status, reason="", error=None):
        if self.case_status != "fail":
            self.case_status = status
        if reason:
            self.case_reasons.append(" ".join(reason.split()))
        if error:
            self.case_errors.append(error)

    def stopTest(self, test):
        global active_case
        super().stopTest(test)
        status = self.case_status or "fail"
        if self.case_status is None:
            self.case_reasons.append("Test ended without a supported result")
        row = {"area": "python", "source": "tests/python_sdk.py", "name": f"{test.__class__.__name__}.{test._testMethodName}",
               "status": status, "backend": os.environ.get("CONTRACT_BACKEND", "node") if test._contract_http_response else "sdk-unit",
               "durationMs": (time.monotonic() - self.started) * 1000, "reason": "; ".join(self.case_reasons), "error": "\n".join(self.case_errors) or None}
        print("@@CONTRACT_RESULT@@" + json.dumps(row), flush=True)
        active_case = None

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
        if (test.__class__.__name__, test._testMethodName) not in OUT_OF_SCOPE:
            error = AssertionError(f"Unexpected skipped contract: {reason}")
            self.addFailure(test, (AssertionError, error, None))
            return
        super().addSkip(test, reason)
        self.record(test, "out-of-scope", reason)


suite = unittest.defaultTestLoader.loadTestsFromModule(original)


def cases(value):
    if isinstance(value, unittest.TestSuite):
        for child in value:
            yield from cases(child)
    else:
        yield value


discovered = {f"{case.__class__.__name__}.{case._testMethodName}": case for case in cases(suite)}
if set(discovered) != {row["name"] for row in manifest}:
    raise RuntimeError("Python static inventory differs from unittest discovery; update python_runner.py before running parity")
result = unittest.TextTestRunner(verbosity=1, resultclass=Result).run(unittest.TestSuite([discovered[selected_case]]))
raise SystemExit(0 if result.wasSuccessful() else 1)
