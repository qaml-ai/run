#!/usr/bin/env python3
"""Repository Python SDK smoke. Key comes only through stdin, never argv."""
import asyncio
import json
import os
import sys
from camelai_run import Agents

async def main():
    key = sys.stdin.read().strip()
    if not key:
        raise RuntimeError("Supply a throwaway tenant key through stdin")
    url = os.environ.get("PILOT_URL", "https://run-pilot.camelai.dev")
    if url != "https://run-pilot.camelai.dev":
        raise RuntimeError("Python smoke targets only the pilot")
    async with Agents(key, url=url) as agents:
        agent = await agents.upsert("pilot-smoke-python", model="pilot-fake/deterministic")
        try:
            run = await agent.run("pilot:python")
            assert run.text == "Echo: pilot:python"
            parts = [part async for part in agent.stream("pilot:python-stream")]
            assert "".join(part.text for part in parts if part.type == "text") == "Echo: pilot:python-stream"
            assert parts[-1].type == "done"
            assert "pilot:python" in json.dumps(await agent.history())
        finally:
            await agent.delete()
    print(json.dumps({"python_sdk": "pass"}))

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as error:
        # SDK exceptions can contain response details. Report only the class.
        print(type(error).__name__, file=sys.stderr)
        sys.exit(1)
