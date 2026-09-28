"""The quickstart: an agent with one tool of yours, which answers and exits.

    CAMELAI_API_KEY=art_... python examples/quickstart.py
"""
import asyncio
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "clients" / "python"))  # in your app: pip install camelai-agent-runtime
from camelai_agent_runtime import Agents, tool


@tool
def weather(city: str) -> dict:
    """Today's weather in a city"""
    return {"city": city, "forecast": "sunny", "highC": 24}


async def main():
    async with Agents() as agents:  # reads CAMELAI_API_KEY (and CAMELAI_BASE_URL, for a runtime of your own)
        agent = await agents.upsert("quickstart-py", model=os.environ.get("AGENT_MODEL", "anthropic/claude-sonnet-5"),
                                    instructions="You are a concise assistant.", tools=[weather])
        run = await agent.run("Should I bring an umbrella in Lisbon today?")
        print(run.text)


asyncio.run(main())
