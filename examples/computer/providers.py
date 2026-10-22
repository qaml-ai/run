"""Optional provider adapters for the computer-agent example. No host-shell fallback."""
from dataclasses import dataclass
import os
import time


@dataclass
class CommandResult:
    exit_code: int
    stdout: str
    stderr: str = ""


class ModalComputer:
    provider = "modal"

    def __init__(self, lifetime: int):
        import modal
        app = modal.App.lookup("camelrun-computer-lab", create_if_missing=True)
        self.sandbox = modal.Sandbox.create(
            "sleep", "infinity", app=app, image=modal.Image.debian_slim(python_version="3.11"),
            cpu=1, memory=1024, timeout=lifetime,
        )
        self.id = self.sandbox.object_id

    def execute(self, command: str, timeout: int) -> CommandResult:
        process = self.sandbox.exec("bash", "-lc", command, timeout=timeout)
        # Drain both streams before wait: pipe buffers must not stall a command.
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=2) as pool:
            stdout = pool.submit(process.stdout.read)
            stderr = pool.submit(process.stderr.read)
            process.wait()
            return CommandResult(process.returncode, stdout.result(), stderr.result())

    def close(self):
        self.sandbox.terminate()


class DaytonaComputer:
    provider = "daytona"

    def __init__(self, lifetime: int):
        from daytona import Daytona, CreateSandboxFromSnapshotParams
        self.client = Daytona()
        self.sandbox = self.client.create(CreateSandboxFromSnapshotParams(
            language="python", ephemeral=True,
            auto_stop_interval=max(1, (lifetime + 59) // 60),
        ))
        self.id = self.sandbox.id

    def execute(self, command: str, timeout: int) -> CommandResult:
        result = self.sandbox.process.exec(command, timeout=timeout)
        return CommandResult(result.exit_code, result.result)

    def close(self):
        self.client.delete(self.sandbox, wait=True, timeout=60)


class BoatComputer:
    provider = "boat"

    def __init__(self, lifetime: int):
        from boat_sdk import ApiClient, Configuration, wait_until_ready
        from boat_sdk.api.boat_api import BoatApi
        from boat_sdk.models import CreateSandboxRequest
        self.client = ApiClient(Configuration(host="https://boat.dev/api/v1", access_token=os.environ["BOAT_API_KEY"]))
        self.api = BoatApi(self.client)
        # no_env prevents the account's default environment injecting repos or credentials.
        created = self.api.create(create_sandbox_request=CreateSandboxRequest(type="small", ttl_seconds=lifetime, no_env=True), _request_timeout=(10, 120))
        self.id = created.sandbox.id
        try:
            wait_until_ready(self.api, self.id, timeout_seconds=120)
        except BaseException:
            self.close()
            raise

    def execute(self, command: str, timeout: int) -> CommandResult:
        from boat_sdk.models import CommandRequest
        result = self.api.command(self.id, CommandRequest(command=command, timeout_seconds=timeout), _request_timeout=(10, timeout + 10)).actual_instance
        return CommandResult(result.exit_code, result.stdout or "", result.stderr or "")

    def close(self):
        from boat_sdk.exceptions import ApiException
        try:
            self.api.delete_sandbox(sandbox_id=self.id, x_ascii_confirm_delete=self.id, _request_timeout=(10, 60))
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline:
                try:
                    self.api.get(sandbox_id=self.id, _request_timeout=(10, 10))
                except ApiException as error:
                    if error.status == 404:
                        return
                    raise
                time.sleep(1)
            raise TimeoutError("Boat deletion was accepted but not confirmed within 60 seconds")
        finally:
            self.client.__exit__(None, None, None)


class E2BComputer:
    provider = "e2b"

    def __init__(self, lifetime: int):
        from e2b import Sandbox
        self.sandbox = Sandbox.create(timeout=lifetime, secure=True, envs={})
        self.id = self.sandbox.sandbox_id

    def execute(self, command: str, timeout: int) -> CommandResult:
        from e2b import CommandExitException
        try:
            result = self.sandbox.commands.run(command, timeout=timeout)
        except CommandExitException as result:
            return CommandResult(result.exit_code, result.stdout, result.stderr)
        return CommandResult(result.exit_code, result.stdout, result.stderr)

    def close(self):
        self.sandbox.kill()


class TunnelComputer:
    """Connect to one explicitly started BYOC session; never execute on this host."""
    provider = "tunnel"

    def __init__(self, lifetime: int):
        import json
        from pathlib import Path
        from urllib.parse import urlsplit
        import httpx
        connection = json.loads(Path(os.environ["CAMELRUN_COMPUTER_CONNECTION"]).read_text())
        url = connection["url"]
        parsed = urlsplit(url)
        if parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ("", "/"):
            raise ValueError("Connection URL must be an origin without credentials")
        if parsed.scheme != "https" and not (parsed.scheme == "http" and parsed.hostname in ("127.0.0.1", "localhost", "::1")):
            raise ValueError("Remote computers require HTTPS")
        self.client = httpx.Client(base_url=url, headers={"Authorization": "Bearer " + connection["token"]},
                                   follow_redirects=False, trust_env=False, timeout=10)
        import uuid
        self.claim = uuid.uuid4().hex
        try:
            response = self.client.post("/claim", json={"claim": self.claim})
            response.raise_for_status()
            info = response.json()
            self.id = info["id"]
            self.expires_at = time.monotonic() + min(lifetime, info["seconds_remaining"])
        except BaseException:
            self.client.close()
            raise

    def execute(self, command: str, timeout: int) -> CommandResult:
        import uuid
        response = self.client.post("/exec", json={"claim": self.claim, "key": uuid.uuid4().hex,
                                    "command": command, "timeout": timeout}, timeout=timeout + 15)
        response.raise_for_status()
        result = response.json()
        return CommandResult(result["exit_code"], result["stdout"], result["stderr"])

    def close(self):
        try:
            response = self.client.post("/close", json={"claim": self.claim}, timeout=30)
            response.raise_for_status()
        finally:
            self.client.close()


PROVIDERS = {"modal": ModalComputer, "daytona": DaytonaComputer, "boat": BoatComputer,
             "e2b": E2BComputer, "tunnel": TunnelComputer}


def create_computer(provider: str, lifetime: int = 900):
    if provider not in PROVIDERS:
        raise ValueError("Unknown Linux computer provider")
    if not 60 <= lifetime <= 900:
        raise ValueError("computer lifetime must be 60–900 seconds")
    computer = PROVIDERS[provider](lifetime)
    if not hasattr(computer, "expires_at"):
        computer.expires_at = time.monotonic() + lifetime
    return computer
