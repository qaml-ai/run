"""Two real model turns against one private remote Linux computer."""
import argparse
import asyncio
import json
import os
from pathlib import Path
import sys
import time
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "clients" / "python"))
from camelai_run import Agents
from providers import create_computer
from tools import ComputerTools


FIRST = """Use the private computer to complete this task, actually running each step:
1. Create /workspace/computer-lab and install Python's humanize package with pip.
2. Initialize /workspace/computer-lab/state.json to {"counter": 1} once BEFORE starting the server. Write a Python HTTP server at /workspace/computer-lab/server.py. On EVERY GET /proof it must READ the current counter from that file and return JSON with provider '__PROVIDER__' (the computer provider, not the model provider), marker 'camelrun-computer-proof', that counter, and formatted_size produced by humanize.naturalsize(1048576, binary=True). The request handler must NEVER write or reset the file and must NOT hard-code the counter.
3. Start the server on 127.0.0.1:8765 in the background, redirecting its output so the command returns.
4. Request /proof using a separate Python process and inspect the response. Also run python3 -m compileall on your server file.
Do not report success without successful command output. Leave the server and files running for the next turn. Reply concisely with the evidence."""

SECOND = """This is a new turn. Do not reinstall, recreate files, or restart the server. Find and read the state saved by the previous turn. Change counter from 1 to 2, request the already-running server's /proof endpoint and verify the response contains counter 2. Report the actual response. This tests filesystem and background-process continuity between agent turns."""


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--provider", choices=["modal", "daytona", "boat"], required=True)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--model", default=os.getenv("AGENT_MODEL", "azure/gpt-6-luna"))
    parser.add_argument("--workspace-id", default=os.getenv("CAMELRUN_WORKSPACE_ID"))
    args = parser.parse_args()
    evidence = {"provider": args.provider, "model": args.model, "turns": [], "cleanup": False}
    args.evidence.parent.mkdir(parents=True, exist_ok=True)

    def save():
        args.evidence.write_text(json.dumps(evidence, indent=2) + "\n")
        args.evidence.chmod(0o600)

    computer = None
    started = time.monotonic()
    try:
        computer = await asyncio.to_thread(create_computer, args.provider)
        evidence.update(computer_id=computer.id, startup_seconds=round(time.monotonic() - started, 3))
        save()
        print(json.dumps({"provider": args.provider, "computer_id": computer.id, "startup_seconds": evidence["startup_seconds"]}), flush=True)
        controller = ComputerTools(computer)
        async with Agents() as agents:
            options = {"workspace_id": args.workspace_id} if args.workspace_id else {}
            agent = await agents.upsert(
                f"computer-lab-{args.provider}-{uuid.uuid4().hex[:8]}",
                name=f"Computer Lab — {args.provider}", model=args.model, code_mode=False, file_tools=False,
                instructions=f"You are testing a real private Linux computer on {args.provider}. Use the computer tools to execute work; never simulate command output. Your computer persists across turns for this test, then is automatically removed. Only touch /workspace/computer-lab and packages needed for this task. Never read credentials or host/account metadata.",
                tools=controller.tools(), spend_limit={"usd": 1},
                run_limits={"maxSeconds": 300, "maxResponses": 30}, **options,
            )
            controller.bind(agent.id)
            evidence["agent_id"] = agent.id
            save()
            for index, prompt in enumerate([FIRST.replace('__PROVIDER__', args.provider), SECOND], 1):
                run = await asyncio.wait_for(agent.run(prompt, spend_limit={"usd": 0.5}), timeout=330)
                evidence["turns"].append({"id": run.id, "status": run.status, "text": run.text, "usage": run.usage,
                                          "tool_calls": run.tool_calls, "tool_errors": run.tool_errors})
                save()
                print(json.dumps({"turn": index, "status": run.status, "reply": run.text}), flush=True)
                if run.status != "completed" or run.tool_errors:
                    raise RuntimeError("Agent run did not complete cleanly")
            # Independently verify the environment; the model's success claim is not the assertion.
            verify = await asyncio.to_thread(computer.execute,
                "python3 - <<'PY'\nimport json,urllib.request,pathlib,humanize\nr=json.load(urllib.request.urlopen('http://127.0.0.1:8765/proof',timeout=5))\nassert r['marker']=='camelrun-computer-proof'\nassert r['counter']==2\nassert r['formatted_size']==humanize.naturalsize(1048576,binary=True)\nassert json.loads(pathlib.Path('/workspace/computer-lab/state.json').read_text())['counter']==2\nprint(json.dumps(r))\nPY", 15)
            if verify.exit_code != 0:
                raise RuntimeError("Independent computer verification failed")
            evidence["verification"] = json.loads(verify.stdout)
            if evidence["verification"].get("provider") != args.provider:
                raise RuntimeError("Computer provider label was incorrect")
            save()
    except BaseException as error:
        evidence["error_type"] = type(error).__name__
        save()
        raise
    finally:
        if computer is not None:
            await asyncio.to_thread(computer.close)
            evidence["cleanup"] = True
            evidence["elapsed_seconds"] = round(time.monotonic() - started, 3)
            save()
            print(json.dumps({"cleanup": True, "elapsed_seconds": evidence["elapsed_seconds"]}), flush=True)


if __name__ == "__main__":
    asyncio.run(main())
