"""Decision answers through both Python SDKs, without a running server."""
import asyncio
from importlib.util import find_spec
from pathlib import Path
import sys
import unittest

missing = [name for name in ("httpx", "websockets") if find_spec(name) is None]
if missing:
    print(f"SKIP python_inbox: missing {', '.join(missing)}; install clients/python/requirements.txt")
    raise SystemExit(0)

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "clients" / "python"))
from camelai_run import Agent, RunInput
from camelai_run import sync

INPUT = {"id": "decision", "requestId": "original", "kind": "decision", "blocking": False,
         "responders": {}, "detail": {"questions": [{"question": "Region?"}]}}
EXPECTED = {"action": "accept", "content": {"answers": {"Region?": "EU"}}}


class DecisionAnswers(unittest.TestCase):
    def test_async(self):
        class Client:
            id = "agent"

            async def answer(self, input_id, **answer):
                self.sent = (input_id, answer)
                return {"input": INPUT, "request": None}

        client = Client()
        receipt = asyncio.run(RunInput(Agent(client), INPUT).answer("EU"))
        self.assertEqual(client.sent, ("decision", EXPECTED))
        self.assertEqual((receipt.status, receipt.inputs), ("completed", []))

    def test_sync(self):
        class Client:
            id = "agent"

            def answer(self, input_id, **answer):
                self.sent = (input_id, answer)
                return {"input": INPUT, "request": None}

        client = Client()
        receipt = sync.RunInput(sync.Agent(client), INPUT).answer("EU")
        self.assertEqual(client.sent, ("decision", EXPECTED))
        self.assertEqual((receipt.status, receipt.inputs), ("completed", []))


if __name__ == "__main__":
    unittest.main()
