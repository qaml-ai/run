"""Offline checks for ownership, retries and expiry. No provider credentials needed."""
import asyncio
from pathlib import Path
import sys
import time
from types import SimpleNamespace
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "clients" / "python"))
from providers import CommandResult
from tools import ComputerTools


class FakeComputer:
    def __init__(self):
        self.calls = []
        self.expires_at = time.monotonic() + 900

    def execute(self, command, timeout):
        self.calls.append((command, timeout))
        if command == "fail":
            raise ValueError("secret-provider-credential")
        if command == "long":
            return CommandResult(0, "x" * 25_000)
        return CommandResult(7, "result", "command stderr")


def context(agent="agent-a", key="call-1"):
    return SimpleNamespace(identity=SimpleNamespace(agent=agent), idempotency_key=key, progress=lambda _: None)


class ComputerTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.computer = FakeComputer()
        self.tools = ComputerTools(self.computer)
        self.tools.bind("agent-a")

    async def test_other_agent_cannot_execute(self):
        with self.assertRaises(PermissionError):
            await self.tools.execute("true", 10, context("agent-b"))
        self.assertEqual(self.computer.calls, [])

    async def test_retry_executes_once_and_keeps_nonzero_exit(self):
        a, b = await asyncio.gather(*(self.tools.execute("false", 10, context()) for _ in range(2)))
        self.assertEqual(a, b)
        self.assertEqual(a["exit_code"], 7)
        self.assertEqual(len(self.computer.calls), 1)
        with self.assertRaises(ValueError):
            await self.tools.execute("changed", 10, context())

    async def test_expired_lease_refuses_dispatch(self):
        self.computer.expires_at = time.monotonic() - 1
        with self.assertRaises(TimeoutError):
            await self.tools.execute("true", 10, context())
        self.assertEqual(self.computer.calls, [])

    async def test_output_is_bounded_and_marked(self):
        result = await self.tools.execute("long", 10, context())
        self.assertEqual(len(result["stdout"]), 24_000)
        self.assertTrue(result["truncated"])

    async def test_ambiguous_failure_is_not_replayed_or_leaked(self):
        with self.assertRaisesRegex(RuntimeError, "ValueError") as error:
            await self.tools.execute("fail", 10, context())
        self.assertNotIn("secret-provider-credential", str(error.exception))
        result = await self.tools.execute("fail", 10, context())
        self.assertIn("unknown outcome", result["error"])
        self.assertEqual(len(self.computer.calls), 1)

    async def test_refuses_unbounded_commands(self):
        for timeout in (0, 121, True):
            with self.assertRaises(ValueError):
                await self.tools.execute("true", timeout, context())
        self.assertEqual(self.computer.calls, [])


if __name__ == "__main__":
    unittest.main()
