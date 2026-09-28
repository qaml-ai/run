import asyncio
from camelai_agent_runtime import Agents

async def main():
    async with Agents() as agents:  # reads CAMELAI_API_KEY
        agent = await agents.upsert("hello-py", model="openrouter/openai/gpt-6-luna")
        print((await agent.run("Say hello in three languages.")).text)

asyncio.run(main())
