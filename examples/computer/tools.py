"""One private computer per attached agent; credentials stay in the adapter process."""
import asyncio
import base64
from dataclasses import asdict
import json
import time

from camelai_run import ToolContext, tool


class ComputerTools:
    def __init__(self, computer):
        self.computer = computer
        self.agent_id = None
        self.lock = asyncio.Lock()
        self.results = {}

    def bind(self, agent_id):
        if self.agent_id is not None and self.agent_id != agent_id:
            raise ValueError("A computer cannot be rebound to another agent")
        self.agent_id = agent_id

    async def execute(self, command, timeout, context):
        if not context.identity or context.identity.agent != self.agent_id:
            raise PermissionError("This computer belongs to a different agent")
        if not isinstance(command, str) or not 1 <= len(command) <= 32_000:
            raise ValueError("command must be 1–32000 characters")
        if type(timeout) is not int or not 1 <= timeout <= 120:
            raise ValueError("timeout must be 1–120 seconds")
        key = context.idempotency_key
        async with self.lock:
            if key in self.results:
                previous_command, result = self.results[key]
                if previous_command != command:
                    raise ValueError("A retried call changed its command")
                return result
            remaining = int(self.computer.expires_at - time.monotonic())
            if remaining <= 0:
                raise TimeoutError("Computer lease expired")
            context.progress("Running in the agent's private computer")
            # Record uncertainty before dispatch; never silently replay a write after an error.
            self.results[key] = (command, {"error": "Previous attempt has an unknown outcome; inspect state before retrying."})
            try:
                result = await asyncio.to_thread(self.computer.execute, command, min(timeout, remaining))
                value = asdict(result)
                value["truncated"] = any(len(value[field]) > 24_000 for field in ("stdout", "stderr"))
                for field in ("stdout", "stderr"):
                    value[field] = value[field][:24_000]
                self.results[key] = (command, value)
                return value
            except Exception as error:
                # Provider exceptions sometimes contain authenticated URLs or request headers.
                # Keep them out of the agent's history, logs and this example's output.
                raise RuntimeError(f"Computer command failed ({type(error).__name__}); outcome may be uncertain") from None

    def tools(self):
        @tool(timeout=150, exposure="direct")
        async def computer_exec(command: str, context: ToolContext, timeout_seconds: int = 60):
            """Run a Linux shell command in your private remote computer. Files and background processes survive between calls and turns. Use redirected output for background servers. No access to camelRun's host. Maximum 120 seconds per command; check exit_code."""
            return await self.execute(command, timeout_seconds, context)

        @tool(timeout=150, exposure="direct")
        async def computer_write_file(path: str, content: str, context: ToolContext):
            """Write a UTF-8 file inside your remote computer, creating parent directories. This does not write to camelRun volumes. Maximum 16,000 characters."""
            if not isinstance(path, str) or not path or len(path) > 1024 or len(content) > 16_000:
                raise ValueError("Invalid path or file too large")
            payload = base64.b64encode(json.dumps({"path": path, "content": content}).encode()).decode()
            command = "python3 - <<'PY'\nimport base64,json,pathlib\nd=json.loads(base64.b64decode('" + payload + "'))\np=pathlib.Path(d['path']);p.parent.mkdir(parents=True,exist_ok=True);p.write_text(d['content']);print('written',p)\nPY"
            return await self.execute(command, 30, context)

        return [computer_exec, computer_write_file]
