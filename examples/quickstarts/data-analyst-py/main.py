import asyncio
from pathlib import Path
import httpx
from camelai_agent_runtime import Agents

async def main():
    async with Agents() as agents:
        agent = await agents.upsert(
            "data-analyst-py",
            model="openrouter/openai/gpt-6-luna",
            instructions="You are a data analyst. Analyse attached files with js_exec (fs.readFile), never by eye. "
            "Write your findings as a short Markdown report to /workspace/out/report.md and present_file it; "
            "summarise it in your reply without linking to it.",
        )
        run = await agent.run("Which regions and products are growing or shrinking? Revenue = units * unit_price.",
                              files=[Path("sales.csv")])
        print(run.text)
        for f in run.raw.get("presented", []):  # the files the agent handed over with present_file
            # agent.files.download(path) is simpler, but 0.5.0 raises on a compressed file's weak ETag.
            link = await agent.files.link(f["path"])
            Path(Path(f["path"]).name).write_bytes(httpx.get(link["url"]).content)
            print("saved", Path(f["path"]).name)

asyncio.run(main())
